'use strict';

import {readFile} from 'fs/promises';
import minimatch from 'minimatch';
import path from 'path';

import indexPattern from './patterns/index.js';
import {indexSql, indexEmbeddedSql} from './sql.js';

export default async function* (repo, absolutePath, files) {
  for (const f of files) {
    const lang = path.extname(f).substr(1);
    const c = await readFile(f, 'utf8');
    const relativePath = f.slice(path.resolve(absolutePath).length + 1);

    if (lang === 'sql') {
      for (const i of indexSql(relativePath, c)) {
        yield `${JSON.stringify(i)}\n`;
      }
    } else {
      for (const i of indexEmbeddedSql(relativePath, c)) {
        yield `${JSON.stringify(i)}\n`;
      }

      for (const type in repo.patterns) {
        if (repo.patterns[type].some(p => minimatch(relativePath, p))) {
          for (const i of indexPattern(type)(relativePath, c)) {
            yield `${JSON.stringify(i)}\n`;
          }
        }
      }
    }
  }
}
