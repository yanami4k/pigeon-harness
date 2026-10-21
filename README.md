# Pigeon

Pigeon is a research-oriented terminal coding agent written in TypeScript. It runs in the
terminal, reads and edits files, runs commands, and records its work as sessions you can
resume, inspect and fork.

## Prerequisites

- Node.js `>=22.19.0 <25` (see `engines` in `package.json`).
- `git`, required for most workflows.
- Docker, optional: only needed for sandbox sessions.

## Install

Download the package file from the
[GitHub Releases](https://github.com/yanami4k/pigeon-harness/releases) page, then install it
globally:

```sh
npm install -g <package-file>
```

## Get started

Model and key configuration: see [docs/configuration.md](docs/configuration.md).

## Documentation

- [Behavior specifications](docs/spec/README.md)
- [Configuration](docs/configuration.md)
- [Testing](docs/testing.md)
