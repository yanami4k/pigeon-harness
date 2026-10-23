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


Model access: set a provider key in the environment (for example `DEEPSEEK_API_KEY`) and pass `--model`, or start `pigeon` and run `/login` to pick a provider, then `/model` to switch models inside a session. Custom providers are declared under `model.providers` in the user-level settings. See [docs/configuration.md](docs/configuration.md).

## Documentation

- [Behavior specifications](docs/spec/README.md)
- [Configuration](docs/configuration.md)
- [Testing](docs/testing.md)
