#!/usr/local/bin/node

'use strict';

import _ from 'lodash';

import * as core from '@actions/core';
import {context, getOctokit} from '@actions/github';
import axios from 'axios';
import minimatch from 'minimatch';
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

  // 1. Index the current ref
  const ref = 'master';
  const {data: job} = await axios.post(`${BASE_URL}/jobs`, {
    name: context.repo.owner,
    repo: context.repo.repo,
    ref: context.ref,
    url: context.apiUrl,
    platform: 'github',
    migration_paths: getInputArray('migration_paths'),
    ignore_paths: getInputArray('ignore_paths'),
    patterns: getInputJson('patterns'),
    token: uuidv4(),
    run_id: context.runId
  });

  console.log(process.env.GITHUB_WORKSPACE)

  const {data: repo} = await axios.get(`${BASE_URL}/repos?platform=github&token=${job.token}`);

  const files = await globby(
    _.concat(
      // all files....
      [`${process.env.GITHUB_WORKSPACE}/**/*`],
      // ....except anything in ignore or migration paths
      _.concat(repo.ignore_paths || [], repo.migration_paths || []).map(p => `!${process.env.GITHUB_WORKSPACE}/**/${p}`)
    ),
    { gitignore: true }
  );

  console.log(files)

  await pipeline(
    Readable.from(indexFiles(repo, process.cwd(), files)),
    createWriteStream('invocations.json')
  );

  const form = new FormData();

  form.append('platform', 'github');
  form.append('token', job.token);
  form.append('invocations', createReadStream('invocations.json'));

  const {data: count} = await axios.post(`${BASE_URL}/upload`, form, {
    headers: form.getHeaders()
  });

  console.log(`indexed ${count} database invocations in ${repo.name}/${ref}`);

  // 2. Scan any migrations added/modified in the PR

  if (!repo.migration_paths) {
    console.log(`no migration paths configured for ${context.repo.repo}, all done!`);

    return;
  }

  const octokit = getOctokit(token);

  const {data: commits} = await octokit.rest.pulls.listCommits({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: core.getInput('pull_request'),
  });

  console.log(commits)

  const {data: pullFiles} = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: core.getInput('pull_request'),
    per_page: 100 // TODO this is the per-request max, accumulate
  });

  const migrations = repo.migration_paths.reduce((acc, p) => {
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
    token: job.token,
    migrations: changes
  });

  const actions = {alter_table: 'altered', drop_table: 'dropped'};
  const seen = [];

  for (const record of invocations) {
    if (seen.indexOf(record.entity) === -1) {
      seen.push(record.entity);

      const acc = [`found references to ${actions[record.change[0].kind]} entity \`${record.entity}\`:\n`];
      let fileName;

      for (const inv of record.invocations) {
        if (fileName !== inv.file_path) {
          fileName = inv.file_path;

          acc.push(`* ${record.repo} (\`${record.ref}\`): ${inv.file_path}`);
        }

        // TODO look for column matches to alters/ellipsize/emoji code for
        // confidence? we can't color text unfortunately
        const columns = inv.is_all_columns ? 'all columns' : _.sortBy(inv.column_refs, r => r.confidence)
          .map(r => r.name)
          .join(', ');

        acc.push(`  - line ${inv.y1} (columns ${columns})`);
      }

      octokit.rest.pulls.createReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: core.getInput('pull_request'),
        commit_id: _.last(commits).sha,
        path: record.file_name,
        side: 'RIGHT',
        line: record.change[0].y1,
        body: acc.join('\n')
      });
    }
  }
}

try {
  run();
} catch (err) {
  core.setFailed(err);
}
