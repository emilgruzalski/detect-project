# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-11-04

### Added

- **Ruby** (`language: ruby`, package manager `bundler`): `Gemfile` / `gems.rb` / gemspec; name and version from the gemspec (incl. the positional `Gem::Specification.new "name"` form) or `lib/<name>/version.rb`; Bundler version from `BUNDLED WITH`; runtime from `.ruby-version` → Gemfile `ruby` (incl. `file:`) → `Gemfile.lock` `RUBY VERSION` → asdf/mise; `bundle install`.
- **PHP** (`language: php`, package manager `composer`): `composer.json` / `composer.lock`; version from `version`, release tooling or git tags; runtime in setup-php's order — `.php-version`, `composer.lock` `platform-overrides.php`, `config.platform.php` — then `require.php` and asdf/mise; `composer install --no-interaction`.
- **.NET** (`language: dotnet`, package manager `dotnet`): solutions and C#/F#/VB projects; version from `Version` / `VersionPrefix`[-`VersionSuffix`] in the project, the nearest `Directory.Build.props` and the local files it imports, Nerdbank.GitVersioning `version.json`, release tooling or git tags; SDK from `global.json` (up to the repository root) → highest target framework → asdf/mise; `dotnet restore` (`--locked-mode` with `packages.lock.json`).
- **Java/JVM** (`language: java`, package manager `maven` or `gradle`): Maven POMs (`${revision}` and `.mvn/maven.config`, in-repo parent versions, `<modules>` aggregator chains, Maven wrapper version, `maven.compiler.release` / `java.version`) and Gradle builds (settings `include`s, `gradle.properties` / `version`, Android `versionName` + `versionCode`, toolchains and `sourceCompatibility`, Gradle wrapper version); `.java-version` / `.sdkmanrc` / `.tool-versions` as read by setup-java; `./mvnw -B dependency:go-offline` for single-module Maven builds.
- `language-version-file` for `php-version-file`, `global-json-file`, `java-version-file` and the files setup-ruby reads itself.
- Corpus: rack, sinatra, laravel/laravel, composer/composer, Serilog, Polly, gson, spring-petclinic and nowinandroid (32 repositories in total). It caught the positional gemspec form (sinatra) and versions in an imported `Directory.Version.props` (Serilog), both fixed with regression tests.

### Changed

- New languages are appended to the detection order (`… → dart → ruby → php → dotnet → java`). A Laravel app with its Vite `package.json` stays `node` by default — set `language-priority: php`.

## [1.3.0] - 2026-11-04

### Added

- **Rust** (`language: rust`, package manager `cargo`): `Cargo.toml` name and version (incl. `version.workspace = true` and virtual workspace roots), cargo workspaces (lockfile and `workspace-root` of the workspace root; `members`, `exclude`, `package.workspace`), runtime from `rust-toolchain.toml` / `rust-toolchain` (looked up to the repository root, like rustup) → `rust-version` (MSRV, incl. workspace inheritance) → `.tool-versions` / `mise.toml`; install command `cargo fetch --locked`.
- **Dart / Flutter** (`language: dart`, package manager `dart` or `flutter`): `pubspec.yaml` name and version (`1.4.0+27` → `version-build` `27`), pub workspaces (`resolution: workspace`), `pubspec.lock`; for Flutter projects the runtime is the Flutter SDK version — FVM `.fvmrc` / `.fvm/fvm_config.json` (looked up to the repository root) → `environment.flutter` → `.tool-versions` / `mise.toml` — with `language-version-file` set when subosito/flutter-action can read it; for Dart projects the `environment.sdk` constraint. Install command `flutter pub get` / `dart pub get` (`--enforce-lockfile` with a lockfile).
- `discover`, `language`, `language-priority` and the job summary cover both new languages.
- Corpus: ripgrep, tokio, serde, clap, dart-lang/http, dio, localsend and riverpod (23 repositories in total).

### Changed

- New languages are appended to the detection order (`node → python → go → rust → dart`), so the primary language of existing mixed projects does not change.
- New runtime dependency `yaml` (bundled into `dist/`) for `pubspec.yaml`, parsed with the failsafe schema so `version: 1.10` stays `1.10`.

## [1.2.0] - 2026-11-04

### Added

- `discover`, `discover-max-depth` and `discover-exclude` inputs and a `projects` output: every project found below `working-directory` (directory relative to the workspace root, languages and the full primary result) as JSON for a `fromJSON` matrix. The job summary lists the discovered projects.
- Versions from release tooling for every language: `.release-please-manifest.json` (nearest manifest, keyed by package path), bump-my-version / bump2version `current_version` and commitizen `version`. They rank after the manifest's own version and a `VERSION` file, before guessing from source code.
- `tag-pattern` input: custom `git describe --match` globs for the git-tag fallback (`release-*`, `api@v*`); the literal prefix is stripped.
- Go: a package-level `var version = "X.Y…"` in `main.go` / `cmd/*/main.go` (e.g. fzf) is read when no `version*.go` file declares one.
- Node: when nothing declares the package manager version, pnpm and Yarn report the major version implied by the lockfile format (`pnpm-lock.yaml` `lockfileVersion` → `6`/`7`/`8`/`>=9`, Yarn v1 lockfile → `1`, Berry lockfile → `>=2`).
- Debug logging: with step debug logging enabled, every resolved value is logged with its source and the sources that were tried.
- Real-world corpus test (`bun run test:corpus`, `Corpus` workflow: weekly, on demand and on pull requests touching `src/`): pinned commits of 15 popular Node, Python and Go repositories compared against a reviewed snapshot.

### Changed

- All version chains go through one shared source layer, and file reads are cached per run (one read per path even when `discover` inspects many directories).
- The e2e scenarios live in `__tests__/e2e-scenarios.json`, shared by `bun run test:e2e` (input defaults read from `action.yml`) and the CI matrix.
- Bumped dev dependencies: rollup 4.63 → 4.67, vitest 5.0 → 5.1 (supersedes Dependabot #10).

### Fixed

- Repository-controlled values (names, versions, paths) are HTML-escaped in the job summary.
- README: the Docker example no longer produces an invalid image tag for versions with build metadata (`1.2.3+45`).

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

[Unreleased]: https://github.com/emilgruzalski/detect-project/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/emilgruzalski/detect-project/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/emilgruzalski/detect-project/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/emilgruzalski/detect-project/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/emilgruzalski/detect-project/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/emilgruzalski/detect-project/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/emilgruzalski/detect-project/releases/tag/v1.0.0
