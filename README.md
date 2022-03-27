# ectomigo

When database schemas change, code has to catch up. Too much of that code is out of sight and out of mind -- in other modules, other systems, other repositories -- and gets left behind. After migration that code still expects the old structure and breaks. Chaos ensues.

**ectomigo** is a first line of defense against the risks inherent to schema migrations. Once enabled on a repository, it indexes your data access code on every push: script files, inline SQL strings, and higher-level patterns in languages like JavaScript and Python. When you submit schema changes for review, it matches the affected database structures against your entire organization's code. If it finds any current references, in _any_ covered repository, you'll get review comments linking directly to that code.

ectomigo is free for up to two private repositories (subject to [some restrictions](https://ectomigo.com/pricing#tier-free)). See the [pricing page](https://ectomigo.com/pricing) for more details.

## quick start

Copy this into `.github/workflows/ectomigo.yml` and edit the final ectomigo step definition for your project. If you want ectomigo to run as part of an existing `push`-triggered job, copy its step block in at some point after the `checkout` step.

```yaml
name: run ectomigo
on: [push]
jobs:
  ectomigo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
        name: checkout
      - uses: ectomigo/ectomigo@v0.1.8
        name: test
        with:
          main_branches: main,release
          migration_paths: migrations/deploy/*.sql
          ignore_paths: test/**/*,node_modules/**/*
          patterns: '{"massive": ["javascript/**/*.js"]}'
          token: ${{ secrets.GITHUB_TOKEN }}
```

* **main_branches** is an optional comma-separated list of branches visible for reporting purposes to other repositories. `main` and `master` are automatically tracked. More on [branch interactions](#branch-and-repo-interactions) below.
* **migration_paths** is an optional comma-separated list of path globs to search for migration files. Only SQL migrations are currently supported; point this at your deploy scripts directory.
* **ignore_paths** is an optional comma-separated list of path globs to ignore. Paths in your .gitignore file are automatically excluded.
* **patterns** is an optional JSON map of data access pattern names to lists of path globs. See [below](#patterns) for details.

The **token** field is required and should be reproduced exactly as given in the example.

## branch and repository interactions

The example GitHub action runs on `push` events. Every time you push a branch -- any branch -- ectomigo will index the data access code it contains. If that push corresponds to a pull request, it will next look for schema migrations and report any potentially destructive changes. But how does ectomigo decide which branches to report on?

Within the active repository, ectomigo scans the same branch it just indexed. Therefore, if your pull request which changes your database schema also updates your data access code to match, there won't be any dangerous invocations for ectomigo to find.

When your data access code is spread across multiple repositories and you submit a pull request with a schema migration in A, ectomigo will look for its most recent index _of declared **main_branches**_ in B, C, and D, one main branch per repository. As you land the requisite changes on the main branches of each of these dependent repositories, ectomigo will have less (hopefully!) to report on.

This makes it useful to declare **main_branches** to include not just your "production" branch, but also any staging or development branches.

## patterns

ectomigo always indexes any SQL it can find. However, there are many more ways for common programming languages to interact with a database. Here's what ectomigo supports at present:

| name | language | description |
|------|----------|-------------|
| massive | javascript | The [MassiveJS](https://massivejs.org) data mapper. |
| sqlalchemy | python | SQLAlchemy Core and ORM definitions. |
