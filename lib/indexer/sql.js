'use strict';

import path from 'path';
import * as TreeSitter from 'tree-sitter';

import {getParser, getCaptureNode, getName, getText} from '../core.js';

const sqlParser = getParser('sql');
// TODO find function refs?
// TODO look for SELECT * (or name.*, or a bunch of params and then a *) and
// set is_all_columns
const tableRefs = new TreeSitter.Query(sqlParser.getLanguage(), `[
  (table_expression schema: (identifier)? @schema name: (identifier) @table table_alias: (identifier)? @alias)
  (table_reference schema: (identifier)? @schema name: (identifier) @table)
]`);
const columnRefs = new TreeSitter.Query(sqlParser.getLanguage(), `[(
  field
    schema: (identifier)? @schema
    table_alias: (identifier)? @table
    name: (identifier) @column
)(
  column name: (identifier) @column
)]`);

export function indexEmbeddedSql(file, code) {
  const ext = path.extname(file).substr(1);
  const parser = getParser(ext);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(code);

  const embeddedSql = getSqlStringQueries(ext).reduce((matchesAtPositions, q) => {
    return new TreeSitter.Query(parser.getLanguage(), q)
      .matches(tree.rootNode)
      .reduce((acc, m) => {
        // find the longest, or at least the first, match at each position:
        // * longest matches for sibling queries (StringBuilder append calls)
        // * first match for recursive queries (string concatenation results in
        //   nested binary expressions)
        const pos = `${m.captures[0].node.startPosition.row}:${m.captures[0].node.startPosition.column}`;

        if (!acc[pos] || acc[pos].captures.length < m.captures.length) {
          acc[pos] = m;
        }

        return acc;
      }, matchesAtPositions);
  }, {});

  let refs = [];
  for (const pos in embeddedSql) {
    const sqlText = getSqlString(tree, embeddedSql[pos]);

    refs = refs.concat(indexSql(file, sqlText, embeddedSql[pos]));
  }

  return refs;
}

export function indexSql(file, code, parentNode) {
  const tree = sqlParser.parse(code);

  if (tree.rootNode.type === 'ERROR') {
    // whole query failed to parse, it's:
    // a) not SQL (e.g. a test named "update the thing")
    // b) incomplete SQL (StringBuilder ran into conditional logic)
    // c) SQL we aren't good enough at parsing
    // if (!tree.rootNode.child(0) || tree.rootNode.child(0).childCount === 0) {
    if (tree.rootNode.childCount === 0 ||
       (tree.rootNode.childCount === 1 && tree.rootNode.child(0).childCount < 2)
    ) {
      // string started with one keyword but no more was identifiable: it's not
      // SQL, bail out
      return [];
    }
  }

  const columns = columnRefs.matches(tree.rootNode).reduce((acc, m) => {
    // TODO sometimes spurious columns, often with single-letter names, can
    // appear as a result of parsing errors (e.g. a RETURNING being taken as
    // error -> IN -> a column named "g"). Can we detect whether a capture is
    // in an error s-expression?
    const column = getText(tree, m.captures.pop().node);
    const tableRef = m.captures.map(c => getText(tree, c.node)).join('.');

    // deduplicate since columns can appear multiple times in SELECT lists,
    // JOIN conditions, WHERE criteria, etc
    if (!acc[tableRef]) { acc[tableRef] = new Set(); }

    acc[tableRef].add(column);

    return acc;
  }, {});

  // console.log(tree.rootNode.toString());
  return tableRefs.matches(tree.rootNode).map((m, idx, arr) => {
    // positions are 0-based
    const parentX = parentNode ? parentNode.captures[0].node.startPosition.column + 1 : 1;
    const parentY = parentNode ? parentNode.captures[0].node.startPosition.row + 1 : 1;

    const alias = getText(tree, getCaptureNode(m, 'alias'));
    const delimitedName = getName(tree, getCaptureNode(m, 'schema'), getCaptureNode(m, 'table'));
    const candidateColumns = [];

    for (let c of columns[alias] || []) { candidateColumns.push({name: c, confidence: 1}); }
    for (let c of columns[delimitedName] || []) { candidateColumns.push({name: c, confidence: 1}); }
    for (let c of columns[''] || []) {
      candidateColumns.push({
        name: c,
        // TODO single-table query that defines but doesn't use a table alias
        // may be double-counted in this algorithm
        confidence: 1 / arr.length // more confident the fewer other tables are in the query
      });
    }

    return {
      file_path: file,
      x1: parentX + m.captures[0].node.startPosition.column,
      y1: parentY + m.captures[0].node.startPosition.row,
      x2: parentX + m.captures[0].node.endPosition.column,
      y2: parentY + m.captures[0].node.endPosition.row,
      entity: delimitedName,
      column_refs: candidateColumns
    };
  });
}

/**
 * Build an SQL string out of query text embedded in host-language boilerplate
 * (string concatenation, StringBuilder appending, etc). The string must be
 * padded to match positions character-by-character because we're going to add
 * offsets *in* the query to the offsets *of* the query in the surrounding
 * code.
 */
function getSqlString(tree, match) {
  let row = match.captures[0].node.startPosition.row;

  return match.captures.reduce((str, c) => {
    // if (!c.name.startsWith('str') || !c.name.startsWith('next')) {
    if (!c.name.startsWith('str')) {
      return str;
    }

    if (c.node.startPosition.row > row) {
      str += '\n'.repeat(c.node.startPosition.row - row);
      row = c.node.startPosition.row;
    }

    return str + ' '.repeat(c.node.startPosition.column) + getText(tree, c.node)
      // TODO minimum, possibly viable.
      // * doesn't handle ternaries, let alone more involved construction logic
      // * since we're using the outermost node in string concatenations, the x
      //   (column) values will be off, but that may be an insoluble problem
      //   considering spaces vs tabs. At least we've got line numbers....
      .replaceAll(/^(\s*[`'"]\s*)/mg, match => ' '.repeat(match.length))
      .replaceAll(/([`'"]\s*\+?\s*$)/mg, match => ' '.repeat(match.length))
      .replaceAll(/(\\r|\\n)/g, '');
  }, '');
}

function getSqlStringQueries(ext) {
  switch (ext) {
    case 'java':
      // TODO multiline strings aren't supported yet, will need to fix this or
      // work around
      // https://github.com/tree-sitter/tree-sitter-java/issues/1
      return [`(
        [
          (string_literal)
          (binary_expression)
        ] @str
        (#match? @str "^.(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )`, `((
        (expression_statement
          (method_invocation
            arguments: (argument_list (string_literal) @str))
          (#match? @str "^.(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)"))
      )(expression_statement
        (method_invocation
          name: (identifier) @mname
          arguments: (argument_list (string_literal) @str))
        (#match? @mname "append")
      )*)`, `(
        element_value_array_initializer
          (
            (string_literal) @str
            ("," (string_literal) @strnext)*
          )
          (#match? @str "^.(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )`].map(s => Buffer.from(s));

    default:
      return [`(
        (string) @str
        (#match? @str "^.(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )`].map(s => Buffer.from(s));
  }
}

