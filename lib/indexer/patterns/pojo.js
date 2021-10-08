'use strict';

import path from 'path';
import * as TreeSitter from 'tree-sitter';

import {getParser} from '../../core.js';

import {camelCase} from 'change-case';

export default function indexPojo(file, code) {
  const ext = path.extname(file).substr(1);
  const parser = getParser(ext);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(code);

  const clazz = new TreeSitter.Query(parser.getLanguage(), `(
    (class_declaration
      (modifiers) @mods
      name: (identifier) @name)
    (#match? @mods "public"))`).matches(tree.rootNode)[0];

  // TODO restrict types? enums though....
  const vars = new Set(new TreeSitter.Query(parser.getLanguage(), `(
    (class_declaration
      (class_body
        (field_declaration
          (modifiers) @mod
          (#match? @mod "private")
          (variable_declarator name: (identifier) @var)
        ))))`).matches(tree.rootNode).map(m => tree.getText(m.captures[1].node)));

  const getters = new Set(new TreeSitter.Query(parser.getLanguage(), `(
    (class_declaration
      (class_body
        (method_declaration
          (modifiers) @mod
          (#match? @mod "public")
          name: (identifier) @method
          (#match? @method "^get[A-Z]")
        ))))`).matches(tree.rootNode).map(m => tree.getText(m.captures[1].node).toLowerCase()));

  const intersection = [...vars].filter(v => getters.has(`get${v.toLowerCase()}`));

  if (intersection.length > 1) {
    return [{
      file_path: file,
      // score higher (zero to one) the closer we are to an exact match between
      // private vars and getters
      confidence: 2 * intersection.length / (vars.size + getters.size),
      // TODO may be off by one due to zero-based indexing, double-check
      x1: clazz.captures[1].node.startPosition.column,
      y1: clazz.captures[1].node.startPosition.row,
      x2: clazz.captures[1].node.endPosition.column,
      y2: clazz.captures[1].node.endPosition.row,
      // TODO we can't reliably determine schemas since packages are separately
      // arbitrary and can be nested! a problem for processing
      entity: tree.getText(clazz.captures[1].node),
      column_refs: JSON.stringify(intersection.map(i => ({name: i, confidence: 1})))
    }];
  }

  return [];
}
