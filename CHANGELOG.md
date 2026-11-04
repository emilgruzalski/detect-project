# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-04

### Added

- Outputs `language-version-source` (where the runtime version came from) and `language-version-file` (the file to pass to `node-version-file` / `python-version-file` / `go-version-file`; only set when the official setup action reads the same value from it).
- Outputs `install-command` (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `uv sync --locked`, `pipenv install --deploy`, `go mod download`, …), `workspace-root` (where to run it) and `cache-dependency-path` (for the setup actions' caches).
- Outputs `version-major`, `version-minor`, `version-patch`, `version-prerelease`, `version-build` and `is-prerelease` (SemVer and PEP 440 aware).
- Input `language-priority` to choose the primary language of a mixed project without dropping the others from `languages`.
- Monorepo support: workspace members (`pnpm-workspace.yaml`, `package.json#workspaces`, `[tool.uv.workspace]`) inherit the root's lockfile, package manager declarations and uv settings, and runtime version files are looked up in parent directories up to the repository / workspace root.
- Node: `devEngines.runtime` is read for the runtime version (after `volta.node`, before `engines.node`, like setup-node).
- Python: PEP 751 lock files (`pylock.toml`, `pylock.<name>.toml`) are reported as the lockfile.

### Fixed

- Workspace members were reported as `npm` / `pip` with no lockfile or runtime version.
- The git-tag fallback reported any nearest tag (`nightly`, a floating `v1`); it now only considers release-shaped tags (`vX.Y…` / `X.Y…`). Nested Go modules use their `dir/vX.Y.Z` tags, and the root module no longer picks up a nested module's tag.
- Go: `var Version string = "…"` / `const Version string = "…"` (declarations with an explicit type) were not recognised.
- Python: the `__version__` fallback walked three levels deep and could report a vendored or test package's version; it now only reads the project's own package (named after the project, or the single top-level package in the root / `src/`).
- A `working-directory` that does not exist (or is not a directory) now fails the step instead of producing a "no supported project" warning.

### Changed

- Switched the package manager from npm to Bun: `package-lock.json` → `bun.lock`, `packageManager: bun@1.4.3`, CI/release workflows use `oven-sh/setup-bun` and `bun install --frozen-lockfile`, Dependabot uses the `bun` ecosystem. Build and tests still run on Node 24.
- Unit tests and bundle e2e tests are now separate scripts (`test`, `test:e2e`); `bun run all` runs the e2e after the build. In CI, e2e testing happens only in the `e2e` job: every `uses: ./` scenario, including `fail-on-unknown`, is one matrix job with a shared assertion step, and it runs after `build`.

## [1.0.1] - 2026-10-23

### Changed

- Bumped `smol-toml` from 1.8.0 to 1.9.1 (runtime dependency, bundled into `dist/`).
- Bumped dev dependencies: `typescript` 5.9 → 7.0, `vitest` 4.1 → 5.0, `rollup` 4.63.3 → 4.63.5, `@types/node` 24.13 → 24.19.
- Build: replaced `@rollup/plugin-typescript` with `@rollup/plugin-sucrase`. TypeScript 7 no longer ships the JavaScript compiler API the old plugin relied on, so bundling now only strips types and type checking stays with `npm run typecheck`. `rollup.config.ts` is loaded through Node's native type stripping (no `--configPlugin`).
- `npm run all` now builds before running the tests, so the tests exercise the fresh bundle.
- Dependabot ignores major updates of `@types/node`, which must match the `node24` runtime.

### Added

- `__tests__/e2e.test.ts`: end-to-end tests that run the bundled `dist/index.js` in a separate Node process with runner-style inputs and `$GITHUB_OUTPUT`, covering every fixture, forced language and `fail-on-unknown`.

## [1.0.0] - 2026-09-14

### Added

- Initial release: detects language (Node.js, Python, Go), application version, package manager and runtime version constraints.

[Unreleased]: https://github.com/emilgruzalski/detect-project/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/emilgruzalski/detect-project/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/emilgruzalski/detect-project/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/emilgruzalski/detect-project/releases/tag/v1.0.0
