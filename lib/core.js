'use strict';

import * as TreeSitter from 'tree-sitter';
import Java from 'tree-sitter-java';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import Sql from 'tree-sitter-sql';

export function getParser(ext) {
  const langs = {
    'sql': Sql,
    'java': Java,
    'js': JavaScript,
    'py': Python
  };

  if (!langs[ext]) {
    return null;
  }

  const parser = TreeSitter.default();

  parser.setLanguage(langs[ext]);

  return parser;
}

export function getCaptureNode(match, name) {
  const capture = match.captures.find(c => c.name === name);

  if (capture) {
    return capture.node;
  }

  return undefined;
}

export function getText(tree, node) {
  if (!node) {
    return undefined;
  }

  return tree.getText(node);
}

export function getName(tree, ...nodes) {
  if (nodes.count > 1 && nodes[0] === 'public') {
    nodes.shift();
  }

  return nodes.filter(n => n).map(n => getText(tree, n)).join('.');
}

export function unquote(str) {
  return str ? str.replaceAll(/(^['"]|["']$)/g, '') : str;
}
