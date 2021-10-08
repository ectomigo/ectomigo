'use strict';

import {readFile} from 'fs/promises';
import matchSql from './sql.js';

export default async function (context, files) {
  let migrations = {};

  for (const f of files) {
    const migration = await readFile(f, 'utf8');
    const matches = await matchSql(migration);

    migrations[f] = {matches};

    // TODO search_path can affect recognition by schema

  }

  return migrations;
}
