# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[1.0.1]: https://github.com/emilgruzalski/detect-project/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/emilgruzalski/detect-project/releases/tag/v1.0.0
