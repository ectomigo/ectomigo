'use strict';

import path from 'path';
import * as TreeSitter from 'tree-sitter';

import {getParser, getCaptureNode, getName, getText, unquote} from '../../core.js';

/**
 * Index MassiveJS data access calls.
 */
export default function indexMassive(file, code) {
  const ext = path.extname(file).substr(1);
  const parser = getParser(ext);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(code);

  const joins = new TreeSitter.Query(parser.getLanguage(), Buffer.from(`
    (call_expression function:
      (member_expression object: [
        (call_expression function:
          (member_expression object:
            (member_expression object:
              (member_expression
                object: (identifier) @ctx
                property: (property_identifier) @db)
              property: (property_identifier) @tbl)
            property: (property_identifier) @join)
          arguments: (arguments) @joinargs)

        (call_expression function:
          (member_expression object:
            (member_expression object:
              (member_expression object:
                (member_expression
                  object: (identifier) @ctx
                  property: (property_identifier) @db)
                property: (property_identifier) @schema)
              property: (property_identifier) @tbl)
            property: (property_identifier) @join)
          arguments: (arguments) @joinargs)
        ]
        property: (property_identifier) @function)
      arguments: (arguments) @args
      (#eq? @db "db")
      (#eq? @join "join")
    )
  `)).matches(tree.rootNode);

  let refs = joins.reduce((acc, j) => {
    const parentTable = getCaptureNode(j, 'tbl');
    const parentTableName = getText(tree, parentTable);
    const joinDefn = j.captures.find(c => c.name === 'joinargs').node.namedChild(0);
    let join = {};

    join[parentTableName] = {
      columns: new Set(),
      x1: parentTable.startPosition.column + 1,
      y1: parentTable.startPosition.row + 1,
      x2: parentTable.endPosition.column + 1,
      y2: parentTable.endPosition.row + 1
    };

    switch (joinDefn.type) {
      case 'string':
        // string naming a single second table
        acc.push({
          columns: new Set(),
          entity: unquote(getText(tree, joinDefn)),
          x1: joinDefn.startPosition.column + 1,
          y1: joinDefn.startPosition.row + 1,
          x2: joinDefn.endPosition.column + 1,
          y2: joinDefn.endPosition.row + 1
        });
        break;
      default:
        // object definition
        const props = new TreeSitter.Query(parser.getLanguage(), Buffer.from(`
          ((pair key: (property_identifier) @key
            value: (object) @target)
          (#not-eq? @key "rel")
          (#not-eq? @key "on")
          (#not-eq? @key "type")
          (#not-eq? @key "omit")
          (#not-eq? @key "pk")
          (#not-eq? @key "decomposeTo"))
        `)).matches(joinDefn);

        join = props.reduce((join, p) => {
          const alias = unquote(getText(tree, p.captures[0].node));
          let relname;
          let columns = new Set();

          for (let i = 0; i < p.captures[1].node.namedChildCount; i++) {
            const c = p.captures[1].node.namedChild(i);

            // ignore stuff like comments in the definition, not sure why
            // they're appearing
            if (c.namedChildCount === 0) { continue; }

            switch (getText(tree, c.namedChild(0))) {
              case 'relation':
                relname = unquote(getText(tree, c.namedChild(1)));
                break;

              case 'pk':
                // TODO can be string or array of columns
                break;

              case 'on':
                new TreeSitter.Query(parser.getLanguage(), Buffer.from(`
                  (pair key: [(property_identifier) (string)] @key
                    value: (string) @val)
                `)).matches(c.namedChild(1)).forEach(pair => {
                  pair.captures.forEach(c => columns.add(unquote(getText(tree, c.node))));
                });
                break;

              default: break;
            }
          }

          join[alias] = join[alias] || {
            // TODO track confidence, should be less confident the more tables
            // included etc
            columns: new Set(),
            x1: p.captures[0].node.startPosition.column + 1,
            y1: p.captures[0].node.startPosition.row + 1,
            x2: p.captures[0].node.endPosition.column + 1,
            y2: p.captures[0].node.endPosition.row + 1
          };

          if (relname) {
            join[alias].name = relname;
          }

          // ~half the columns we get from an `on` definition reference other
          // tables; find them as best possible.
          // TODO constants and origin table columns foul up the results....
          for (const col of columns) {
            // TODO schemas!
            const split = col.split('.');

            if (split.length === 1) {
              join[alias].columns.add(col);
            } else {
              join[split[0]] = join[split[0]] || {
                columns: new Set()
              };

              join[split[0]].columns.add(split[1]);
            }
          }

          return join;
        }, join);

        break;
    }

    // TODO full-text search methods don't use criteria but do have field lists
    // TODO options.fields, options.order
    const args = j.captures.find(c => c.name === 'args');
    let argColumns = [];

    if (args.namedChildCount > 0) {
      argColumns = new TreeSitter.Query(parser.getLanguage(), `
        ((object (pair key: [(property_identifier) (string)] @key)))
      `).matches(args.node.namedChild(0)).reduce((acc, m) => {
        return acc.concat(m.captures.map(c => {
          const name = unquote(getText(tree, c.node));
          const possibleEntity = name.split('.').slice(0, -1);

          return {
            name,
            possibleEntity
          };
        }));
      }, argColumns);
    }

    for (const tbl in join) {
      argColumns.forEach(c => {
        if (c.possibleEntity.length === 0 && tbl === parentTableName) {
          join[tbl].columns.add({name: c.name, confidence: 1});
        } else if (c.possibleEntity.join('.') === tbl) {
          join[tbl].columns.add({name: c.name, confidence: 1});
        }
      });

      acc.push({
        entity: join[tbl].name || tbl,
        join: true,
        x1: join[tbl].x1,
        y1: join[tbl].y1,
        x2: join[tbl].x2,
        y2: join[tbl].y2,
        column_refs: join[tbl].columns.size > 0 ? [...join[tbl].columns] : null
      });
    }

    return acc;
  }, []);

  const matches = new TreeSitter.Query(parser.getLanguage(), Buffer.from(`
    (call_expression function:
      (member_expression object:
        (member_expression
          object: [
            (identifier) @db
            (member_expression
              object: (identifier) @db
              property: (property_identifier) @schema)
            (member_expression
              object: (identifier) @ctx
              property: (property_identifier) @db)
            (member_expression
              object: (member_expression
                object: (identifier) @ctx
                property: (property_identifier) @db)
              property: (property_identifier) @schema)
          ]
          property: (property_identifier) @table)
        property: (property_identifier) @function
        (#eq? @db "db")
        (#not-eq? @function "join")
      )
      arguments: (arguments) @args)`)).matches(tree.rootNode);

  matches.reduce((refs, m) => {
    const table = getCaptureNode(m, 'table');
    const delimitedName = getName(tree, getCaptureNode(m, 'schema'), table);
    const args = m.captures.find(c => c.name === 'args');
    const columns = new TreeSitter.Query(parser.getLanguage(), `
      (arguments . (object (pair key: (property_identifier) @key)))
    `).matches(args.node).reduce((acc, m) => {
      return acc.concat(m.captures.map(c => ({name: getText(tree, c.node), confidence: 1})));
    }, []);

    refs.push({
      entity: delimitedName,
      x1: table.startPosition.column + 1,
      y1: table.startPosition.row + 1,
      x2: table.endPosition.column + 1,
      y2: table.endPosition.row + 1,
      column_refs: columns.length > 0 ? columns : null
    });

    return refs;
  }, refs);

  return refs.map(r => {
    r.file_path = file;
    r.confidence = 1;

    return r;
  });
}
