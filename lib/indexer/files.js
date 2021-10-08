'use strict';

import {readFile} from 'fs/promises';
import minimatch from 'minimatch';
import path from 'path';

import indexPattern from './patterns/index.js';
import {indexSql, indexEmbeddedSql} from './sql.js';

export default async function* (repo, dir, files) {
  for (const f of files) {
    const lang = path.extname(f).substr(1);
    const c = await readFile(f, 'utf8');

    if (lang === 'sql') {
      for (const i of indexSql(f, c)) {
        yield `${JSON.stringify(i)}\n`;
      }
    } else {
      for (const i of indexEmbeddedSql(f, c)) {
        yield `${JSON.stringify(i)}\n`;
      }

      for (const type in repo.patterns) {
        if (repo.patterns[type].some(p => minimatch(f, path.join(dir, p)))) {
          for (const i of indexPattern(type)(f, c)) {
            yield `${JSON.stringify(i)}\n`;
          }
        }
      }
    }
  }
}
