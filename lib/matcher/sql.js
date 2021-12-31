'use strict';

import * as TreeSitter from 'tree-sitter';
import {getParser, getName, getCaptureNode} from '../core.js';

const parser = getParser('sql');

export default async function (migration) {
  // TODO try to match columns in alter
  const query = new TreeSitter.Query(parser.getLanguage(), `([
    (drop_table (table_reference schema: (identifier)? @schema name: (identifier) @table) @ref)
    (alter_table (table_reference schema: (identifier)? @schema name: (identifier) @table) @ref)
    (drop_view (table_reference schema: (identifier)? @schema name: (identifier) @table) @ref)
    (alter_view (table_reference schema: (identifier)? @schema name: (identifier) @table) @ref)
  ] @kind)`);

  const tree = parser.parse(migration);

  const matches = query.matches(tree.rootNode).reduce((acc, m) => {
    const kind = getCaptureNode(m, 'kind');
    const ref = getCaptureNode(m, 'ref');
    const schema = getCaptureNode(m, 'schema');
    const relation = getCaptureNode(m, 'table');
    const name = getName(tree, schema, relation);

    if (!acc[name]) {
      acc[name] = [];
    }

    acc[name].push({
      kind: kind.type,
      x1: ref.startPosition.column + 1,
      y1: ref.startPosition.row + 1,
      x2: ref.endPosition.column + 1,
      y2: ref.endPosition.row + 1,
    });

    return acc;
  }, {});

  return matches;
}
