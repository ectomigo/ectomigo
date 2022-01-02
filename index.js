#!/usr/local/bin/node

'use strict';

import _ from 'lodash';

import * as core from '@actions/core';
import {context, getOctokit} from '@actions/github';
import axios from 'axios';
import minimatch from 'minimatch';
import murmurhash from 'murmurhash';
import {globby} from 'globby';
import {v4 as uuidv4} from 'uuid';
import {basename} from 'path';
import FormData from 'form-data';
import {Readable} from 'stream';
import {pipeline} from 'stream/promises';
import {createReadStream, createWriteStream} from 'fs';

import indexFiles from './lib/indexer/files.js';
import match from './lib/matcher/index.js'

const BASE_URL = 'https://ectomigo.herokuapp.com';

function getInputArray(key) {
  const val = core.getInput(key);

  if (val) {
    return val.split(',');
  }

  return null;
}

function getInputJson(key) {
  const val = core.getInput(key);

  if (val) {
    try {
      return JSON.parse(val);
    } catch (e) {
      console.error(`unable to parse ${key} input JSON`, e);
    }
  }

  return null;
}

async function run() {
  if (!core.getInput('pull_request')) {
    throw new Error('not a pull request!')
  }

  const token = core.getInput('token');

  if (!token || token.length === 0) {
    throw new Error('token not found!');
  }

  const ref = _.last(context.ref.split('/'))

  const {data: job} = await axios.post(`${BASE_URL}/jobs`, {
    name: context.repo.owner,
    repo: context.repo.repo,
    ref,
    url: `https://github.com/${context.repo.owner}/${context.repo.repo}`,
    platform: 'github',
    migration_paths: getInputArray('migration_paths'),
    ignore_paths: getInputArray('ignore_paths'),
    patterns: getInputJson('patterns'),
    details: {
      pull_number: core.getInput('pull_request')
    },
    run_id: context.runId
  });

  // 1. Index the current ref

  const files = await globby(
    _.concat(
      // all files....
      [`${process.env.GITHUB_WORKSPACE}/**/*`],
      // ....except anything in ignore or migration paths
      _.concat(job.ignore_paths || [], job.migration_paths || []).map(p => `!${process.env.GITHUB_WORKSPACE}/**/${p}`)
    ),
    { gitignore: true }
  );

  console.log(files)

  await pipeline(
    Readable.from(indexFiles(job, process.cwd(), files)),
    createWriteStream('invocations.json')
  );

  const form = new FormData();

  form.append('platform', 'github');
  form.append('token', job.job_id);
  form.append('invocations', createReadStream('invocations.json'));

  const {data: count} = await axios.post(`${BASE_URL}/upload`, form, {
    headers: form.getHeaders()
  });

  console.log(`indexed ${count} database invocations in ${context.repo.repo}/${ref}`);

  // 2. Scan any migrations added/modified in the PR

  if (!job.migration_paths) {
    console.log(`no migration paths configured for ${context.repo.repo}, all done!`);

    return;
  }

  const octokit = getOctokit(token);

  const pullFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: job.details.pull_number
  });

  console.log(pullFiles)

  const migrations = job.migration_paths.reduce((acc, p) => {
    return acc.concat(pullFiles.reduce((matches, f) => {
      if (minimatch(f.filename, p)) {
        matches.push(f.filename);
      }

      return matches;
    }, []));
  }, []);

  console.log(migrations)
  if (migrations.length === 0) {
    console.log('no migration changes detected in pull request, all done!');

    return;
  }

  const changes = await match(job, migrations);
  console.log(changes);

  const {data: invocations} = await axios.post(BASE_URL, {
    platform: 'github',
    token: job.job_id,
    migrations: changes
  });

  // index previous comments so we can see if any of our current findings are redundant

  const allComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: job.details.pull_number
  });

  console.log(allComments)

  const toDelete = allComments.reduce((acc, comment) => {
    if (comment.user.login === 'github-actions[bot]' && comment.body.startsWith('ectomigo found')) {
      acc[murmurhash.v3(`${comment.path}:${comment.line}:${comment.body}`)] = comment;
    }

    return acc;
  }, {});

  console.log(toDelete)

  // generate new comments from the matched invocations; each record includes
  // all references in a single repository (this or another) for a single
  // entity which has been changed in the scope of a single migration, yielding
  // migration file name and changes, entity name, target repository and ref,
  // and indexed invocations in that target repository.

  const comments = [];
  const byEntity = _.groupBy(invocations, i => i.entity);

  console.log(byEntity)

  for (const entity in byEntity) {
    let isDropped = false;
    const seen = [];
    const acc = [];

    for (const record of byEntity[entity]) {
      console.log(entity, record.change)

      isDropped = isDropped || record.change.some(c => c.kind.startsWith('drop_'));

      if (seen.indexOf(record.repo) > -1) {
        // if an entity is affected by multiple migration files, we'll see one
        // record per migration per target repo, but -- other than whether this
        // particular migration alters or drops the entity -- all the important
        // info will be identical.
        continue;
      }

      seen.push(record.repo);

      const scanned = record.scanned_at.toISOString().split('T')[0];

      acc.push('');
      acc.push(`#### in repository [${record.repo}](${record.url}) (\`${record.ref}\`) as of ${scanned}`);

      let fileName;

      for (const inv of record.invocations) {
        const fileUrl = `${record.url}/blob/${record.ref}/${inv.file_path}`;

        if (fileName !== inv.file_path) {
          fileName = inv.file_path;

          acc.push(`[\`${inv.file_path}\`](${fileUrl})`);
        }

        // TODO look for column matches to alters/ellipsize/emoji code for
        // confidence? we can't color text unfortunately
        const columns = inv.is_all_columns ? 'all columns' : _.sortBy(inv.column_refs, r => r.confidence)
          .map(r => r.name)
          .join(', ');

        // TODO index and include statement type
        if (columns.length > 0) {
          acc.push(`  - [line ${inv.y1}](${fileUrl}#L${inv.y1}) (columns: ${columns})`);
        } else {
          acc.push(`  - [line ${inv.y1}](${fileUrl}#L${inv.y1})`);
        }
      }
    }

    const anchor = byEntity[entity][0];
    const body = [`ectomigo found references to ${isDropped ? 'dropped' : 'altered'} entity \`${entity}\`:\n`]
      .concat(acc)
      .join('\n');
    const key = murmurhash.v3(`${anchor.file_name}:${anchor.change[0].y1}:${body}`);

    if (toDelete[key]) {
      // identical comment already exists, keep it
      delete toDelete[key];
    } else {
      // comment on the first modification
      comments.push({
        path: anchor.file_name,
        line: anchor.change[0].y1,
        body
      });
    }
  }

  // remove remaining comments from previous runs

  console.log(toDelete)

  for (const key in toDelete) {
    await octokit.rest.pulls.deleteReviewComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: toDelete[key].id
    });
  }

  // and finally, create the new review

  console.log(comments)

  if (comments.length > 0) {
    await octokit.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: job.details.pull_number,
      event: 'COMMENT',
      body: `ectomigo found references to database objects modified in this pull request. Review its comments and assess the potential impact of individual migration changes before merging.`,
      comments: comments.map(comment => ({
        side: 'RIGHT',
        path: comment.path,
        line: comment.line,
        body: comment.body
      }))
    });
  }
}

try {
  run();
} catch (err) {
  core.setFailed(err);
}
