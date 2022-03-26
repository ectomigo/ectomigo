'use strict';

import path from 'path';
import * as TreeSitter from 'tree-sitter';

import {getParser, getCaptureNode, getName, getText} from '../core.js';

const sqlParser = getParser('sql');
const allStatements = new TreeSitter.Query(sqlParser.getLanguage(), '((statement) @statement)');
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
        const pos = m.captures[0].node.startPosition.row;

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
    if (tree.rootNode.childCount === 0 ||
       (tree.rootNode.childCount === 1 && tree.rootNode.child(0).childCount < 2)
    ) {
      // string started with one keyword but no more was identifiable: it's not
      // SQL, bail out
      return [];
    }
  }

  const statements = allStatements.matches(tree.rootNode);

  return statements.reduce((refs, s) => {
    const root = s.captures[0].node;
    const text = getText(tree, root);

    const columns = columnRefs.matches(root).reduce((acc, m) => {
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

    return refs.concat(tableRefs.matches(root).map((m, idx, arr) => {
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
    }));
  }, []);
}

/** Build an SQL string out of query text embedded in host-language boilerplate
 * (string concatenation, StringBuilder appending, etc).
 *
 * The string must be de-quoted, padded to match positions character by
 * character because we're going to add offsets *in* the query to the offsets
 * *of* the query in the surrounding code, and also sanitized for prepared
 * statement parameters, escape characters, and the like. We also discard
 * anything interpolated in e.g. JavaScript template strings.
 */
function getSqlString(tree, match) {
  let row = match.captures[0].node.startPosition.row;

  const anchor = match.captures[0].node.startPosition; // for comparing interpolation capture position

  const deQuotedAndInterpolated = match.captures.reduce((str, c) => {
    if (['interpolation'].indexOf(c.name) > -1) {
      // interpolated (intra-string) capture. The outer capture text will
      // already contain the interpolation itself, so we need to go back and
      // erase it!
      const interp = getText(tree, c.node);
      const split = str.split('\n');
      const startRow = c.node.startPosition.row;
      const startCol = c.node.startPosition.column;
      const endRow = c.node.endPosition.row;
      const endCol = c.node.endPosition.column;

      if (startRow === endRow) {
        // single-line interpolation, zero out startCol to endCol
        const rowIdx = startRow - anchor.row;

        split[rowIdx] = split[rowIdx].substring(0, startCol) + '0'.repeat(interp.length) + split[rowIdx].substring(endCol);
      } else {
        // multi-line interpolation gets complicated:
        const startRowIdx = startRow - anchor.row;
        const endRowIdx = endRow - anchor.row;

        // first we zero out the interpolated area of the initial line
        const beforeInterp = split[startRowIdx].substring(0, startCol);

        split[startRowIdx] = beforeInterp + '0'.repeat(split[startRowIdx].length - beforeInterp.length);

        // then we replace middle lines with spaces
        for (let i = startRowIdx + 1; i < endRowIdx; i++) {
          split[i] = ' '.repeat(split[i].length);
        }

        // the interpolated area of the last line is also spaced out
        split[endRowIdx] = ' '.repeat(endCol) + split[endRowIdx].substring(endCol);
      }

      // at last, we put str back together, having zeroed out up to the first
      // line of interpolated content, and spaced out any subsequent lines or
      // partial lines, so the resulting string should be
      //
      // 1) exactly the same length
      // 2) closer to parseable SQL
      //
      // this approach does discard SQL snippets _inside_ interpolated strings,
      // e.g. `select ${flag ? 'col1': 'col2'} from...` but pobody's nerfect
      return split.join('\n');
    } else if (!c.name.startsWith('str')) {
      // inter-string capture, e.g. StringBuilder `append` method name tracking
      return str;
    }

    if (c.node.startPosition.row > row) {
      str += '\n'.repeat(c.node.startPosition.row - row);
      row = c.node.startPosition.row;
    }

    return str + ' '.repeat(c.node.startPosition.column) + getText(tree, c.node)
      // de-quote and pad beginning; remove the leading 'f' for python string
      // interpolation as well
      .replaceAll(/^f?(\s*[`'"]+\s*)/mg, match => ' '.repeat(match.length))
      // de-quote and pad end
      .replaceAll(/([`'"]\s*\+?\s*$)/mg, match => ' '.repeat(match.length))
      // remove any internal newline hijinx
      .replaceAll(/(\\r|\\n)/g, '');
  }, '');

  return deQuotedAndInterpolated
    // zero out ? prepared statement params
    .replaceAll('?', '0')
    // zero out python %s interpolation
    .replaceAll('%s', '00')
    // zero out $n prepared statement params
    .replaceAll(/\$\d+/g, m => '0'.repeat(m.length))
    // decolonize :named params
    .replaceAll(/\s:(?=\w)/g, '  ');
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
            name: (identifier) @mname
            arguments: (argument_list . (string_literal) @str))
          (#match? @mname "append")
        )*
      ) _* (expression_statement
        (method_invocation
          name: (identifier) @mname
          arguments: (argument_list . (string_literal) @str))
        (#match? @mname "append")
      )*)`, `(
        element_value_array_initializer
          (
            (string_literal) @str
            ("," (string_literal) @strnext)*
          )
          (#match? @str "^.(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )`].map(s => Buffer.from(s));

    case 'js': case 'ts': case 'jsx': case 'tsx':
      return [/* same as default */ `(
        (string) @str
        (#match? @str "(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )`, /* template strings */`(
        (template_string
          (template_substitution)* @interpolation
        ) @str
        (#match? @str "(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )
      `].map(s => Buffer.from(s));

    case 'py':
      return [`(
        (string
          (interpolation)* @interpolation
        ) @str
        (#match? @str "(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )
      `].map(s => Buffer.from(s));

    default:
      return [`(
        (string) @str
        (#match? @str "(select|insert|update|delete|with|SELECT|INSERT|UPDATE|DELETE|WITH)")
      )`].map(s => Buffer.from(s));
  }
}

