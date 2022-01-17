'use strict';

import path from 'path';
import * as TreeSitter from 'tree-sitter';

import {getParser, unquote} from '../../core.js';

export default function indexSqlAlchemy(file, code) {
  const ext = path.extname(file).substr(1);
  const parser = getParser(ext);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(code);

  const coreDefns = new TreeSitter.Query(parser.getLanguage(), `(
    assignment
      left: (identifier) @ref
      right: (call
        function: (identifier) @table_fn
        arguments:
          (argument_list .
            (string) @table
            (call
              function: (identifier) @column_fn
              arguments: (argument_list . (string) @column)
            )*)
      (#match? @table_fn "Table")
      (#match? @column_fn "Column")
    ))`).matches(tree.rootNode);

  // TODO predicates and alternation don't play too well together:
  //
  // https://github.com/tree-sitter/tree-sitter/issues/1584
  // https://github.com/tree-sitter/node-tree-sitter/issues/98
  //
  // so instead we work around by querying twice, once for ORM classes with a
  // schema defined and once for same without, then -- because the latter will
  // always include the former, minus schema -- we find intersections and sub
  // in the match with the schema where appropriate.
  const ormDefnsWithSchema = new TreeSitter.Query(parser.getLanguage(), `(
    class_definition
      name: (identifier) @ref
      body: (block [
        (expression_statement
          (assignment
            left: (identifier) @tablename
            right: (string) @table
          ))
        (expression_statement
          (assignment
            left: (identifier) @tableargs
            right: (dictionary
              (pair
                key: (string) @schema_arg
                value: (string) @schema
              ))
            (#match? @tableargs "__table_args__")
            (#match? @schema_arg "schema")))
        (expression_statement
          (assignment
            left: (identifier) @column
            right: (call function: (identifier) @column_fn)
          )
          (#match? @column_fn "Column"))
        (_)
      ]+)
      (#match? @tablename "__tablename__")
    )`).matches(tree.rootNode);

  const ormDefns = new TreeSitter.Query(parser.getLanguage(), `(
    class_definition
      name: (identifier) @ref
      body: (block [
        (expression_statement
          (assignment
            left: (identifier) @tablename
            right: (string) @table
          ))
        (expression_statement
          (assignment
            left: (identifier) @column
            right: (call function: (identifier) @column_fn)
          )
          (#match? @column_fn "Column"))
        (_)
      ]+)
      (#match? @tablename "__tablename__")
    )`).matches(tree.rootNode);

  let withSchemaIdx = 0;

  const finalOrmDefns = ormDefns.reduce((acc, defn) => {
    const node = defn.captures[0].node; // first capture is @ref
    const wsNode = ormDefnsWithSchema[withSchemaIdx].captures[0].node;

    if (node.startPosition.row === wsNode.startPosition.row && node.startPosition.column === wsNode.startPosition.column) {
      // we have the same node in both schemaless and with-schema! prefer the latter
      acc.push(ormDefnsWithSchema[withSchemaIdx]);

      withSchemaIdx++;
    } else {
      acc.push(defn);
    }

    return acc;
  }, []);

  return [...coreDefns, ...finalOrmDefns].map(defn => {
    const schema = defn.captures.find(c => c.name === 'schema');
    const table = defn.captures.find(c => c.name === 'table');
    const columns = defn.captures.filter(c => c.name === 'column');

    const entity = [
      schema ? unquote(tree.getText(schema.node)) : null,
      unquote(tree.getText(table.node))
    ].filter(x => x).join('.');

    return {
      file_path: file,
      confidence: 1,
      x1: table.node.startPosition.column,
      y1: table.node.startPosition.row,
      x2: table.node.endPosition.column,
      y2: table.node.endPosition.row,
      entity,
      column_refs: JSON.stringify(columns.map(c => ({name: tree.getText(c.node), confidence: 1})))
    };
  });
}
