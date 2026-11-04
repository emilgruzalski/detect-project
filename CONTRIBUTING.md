# Contributing

## Development

Requires Node.js 24 (`.node-version`) and [Bun](https://bun.sh) (pinned in `packageManager`); scripts run on Node, Bun installs dependencies and runs scripts.

```bash
bun install
bun run typecheck
bun run test          # unit tests (vitest)
bun run package       # bundle src/ into dist/index.js (rollup)
bun run test:e2e      # run the bundled dist/index.js like the runner does
bun run test:corpus   # pinned commits of popular repositories vs. a snapshot (needs network)
bun run all           # typecheck, test, package, test:e2e
bun run local-action  # run the action locally with inputs from .env (see .env.example)
```

- `dist/` is committed — GitHub runs it directly — and CI fails when it is stale, so run `bun run package` before committing source changes.
- The e2e scenarios live in `__tests__/e2e-scenarios.json`, shared by `bun run test:e2e` and the CI matrix.
- The corpus (`__tests__/corpus/corpus.json`) runs weekly, on demand and on pull requests touching `src/`; after a deliberate behaviour change, review the diff and update it with `bun run test:corpus -u`.
- A new language is a `Detector` (`src/types.ts`) registered — at the end, so primary languages never change — in `src/detectors/index.ts`.
- `__tests__/action.test.ts` keeps `action.yml` publishable (description under 125 characters) and in sync with the code and the README.

```
src/
  main.ts          inputs → detection → outputs and job summary
  detect.ts        runs the detectors, picks the primary language
  discover.ts      walks subdirectories for `discover`
  detectors/       one file per ecosystem
  utils/           sources (ordered values + debug log), release tooling, runtime files, fs cache, TOML/INI/XML, globs
__tests__/         vitest suites, fixtures, e2e scenarios, corpus
docs/              user documentation beyond the README
```

## Releasing

1. Bump `version` in `package.json`, add a [CHANGELOG](CHANGELOG.md) entry, run `bun run all` and commit (including `dist/`).
2. Publish a GitHub release with a `vMAJOR.MINOR.PATCH` tag; tick **Publish this Action to the GitHub Marketplace** to update the listing. The listing shows the README of the published release.
3. The [Release workflow](.github/workflows/release.yml) checks that `dist/` is fresh and moves the major tag (`v1`) to the release, so `@v1` users get it. Pre-releases never move a major tag.
