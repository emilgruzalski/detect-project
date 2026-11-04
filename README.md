# Detect Project

GitHub Action that inspects a directory and reports **which language it is**, **what version the application is** and **which package manager it uses**. Supports **Node.js**, **Python**, **Go**, **Rust**, **Dart/Flutter**, **Ruby**, **PHP**, **.NET** and **Java/JVM** (Maven, Gradle).

Typical uses: choosing the right `setup-*` action in a reusable workflow, tagging Docker images with the app version, or deciding between `npm ci` / `pnpm install` / `poetry install` without hard-coding it per repository.

Runs on the **Node.js 24** action runtime (`runs.using: node24`), which is the default on GitHub-hosted runners and requires runner v2.327.1+ on self-hosted machines (Node 24 does not run on macOS ≤ 13.4 or ARM32).

## Usage

```yaml
- uses: actions/checkout@v7

- id: project
  uses: emilgruzalski/detect-project@v1
  with:
    working-directory: .        # optional, default "."
    language: auto              # optional: auto | node | python | go
    language-priority: ''       # optional, e.g. "python,node" for mixed repositories
    tag-pattern: ''             # optional, e.g. "release-*" for the git-tag version fallback
    discover: false             # optional: also report every project below working-directory
    fail-on-unknown: false      # optional: fail when nothing is detected

- run: |
    echo "language:        ${{ steps.project.outputs.language }}"
    echo "name:            ${{ steps.project.outputs.name }}"
    echo "version:         ${{ steps.project.outputs.version }}"
    echo "package manager: ${{ steps.project.outputs.package-manager }} ${{ steps.project.outputs.package-manager-version }}"
    echo "runtime:         ${{ steps.project.outputs.language-version }} (${{ steps.project.outputs.language-version-source }})"
    echo "install:         ${{ steps.project.outputs.install-command }} in ${{ steps.project.outputs.workspace-root }}"
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `working-directory` | `.` | Directory to inspect, relative to the workspace root. The step **fails** when it does not exist or is not a directory. |
| `language` | `auto` | Force a language (`node`, `python`, `go`, `rust`, `dart`, `ruby`, `php`, `dotnet`, `java` — `dart` includes Flutter, `java` any Maven or Gradle build) instead of auto-detecting. |
| `language-priority` | | Languages to prefer as primary when several are detected, comma separated (`python,node`). Unlisted languages follow in the default order. |
| `tag-pattern` | | `git describe --match` glob(s) for the [git-tag fallback](#git-tags), comma or newline separated (`release-*`, `api@v*`). Replaces the default `vX.Y…` / `X.Y…` patterns; the literal part before the first wildcard is stripped from the tag. |
| `discover` | `false` | Also inspect the subdirectories of `working-directory` and report every project found in the `projects` output (see [Discovering projects](#discovering-projects)). |
| `discover-max-depth` | `3` | How many directory levels below `working-directory` `discover` inspects (`0`–`10`). |
| `discover-exclude` | | Globs relative to `working-directory` that `discover` skips together with everything below them, comma or newline separated (`examples, legacy/**`). |
| `fail-on-unknown` | `false` | Fail the step when no supported project is found (with `discover`: neither in `working-directory` nor below it). |

### Outputs

| Output | Example | Description |
| --- | --- | --- |
| `language` | `node` | `node`, `python`, `go`, `rust`, `dart` (Dart and Flutter), `ruby`, `php`, `dotnet`, `java` (Maven and Gradle builds, also Kotlin) or `unknown`. |
| `name` | `my-app` | `package.json` name, pyproject name or Go module path. |
| `version` | `1.4.2-rc.1` | Application version. Empty when it cannot be determined. |
| `version-source` | `package.json` | Where the version came from (`pyproject.toml:project.version`, `VERSION`, `internal/version/version.go`, `../../.release-please-manifest.json:apps/api`, `git-tag`, …). |
| `version-major` / `version-minor` / `version-patch` | `1` / `4` / `2` | Version components; minor and patch are `0` when absent (`1.4` → `1`/`4`/`0`). Empty without a version. |
| `version-prerelease` | `rc.1` | Pre-release part (`rc.1`, `beta2`, PEP 440 `dev3`); empty for final releases, including PEP 440 post-releases. |
| `version-build` | `45` | Build metadata after `+` (`1.2.3+45`, PEP 440 local version). |
| `is-prerelease` | `true` | `true` when `version-prerelease` is set, otherwise `false`. |
| `package-manager` | `pnpm` | See the table below. |
| `package-manager-version` | `9.12.0` | When declared somewhere (see below). Otherwise, for pnpm and Yarn, the major version implied by the lockfile format (`>=9`, `8`, `1`, `>=2`, …); empty when unknown. |
| `language-version` | `>=20` | Runtime version or constraint (`.nvmrc`, `requires-python`, `go` directive, …), passed through as written. |
| `language-version-source` | `package.json:engines.node` | Where `language-version` came from, relative to `working-directory` (`.nvmrc`, `../../.python-version`, `go.mod:go`, …). |
| `language-version-file` | `apps/api/.nvmrc` | The file `language-version` was read from, relative to the workspace root, **only** when the official setup action reads the same value from it (see [below](#passing-the-runtime-to-setup-actions)); otherwise empty. |
| `manifest` | `package.json` | Manifest the detection is based on, relative to `working-directory`. |
| `lockfile` | `../../pnpm-lock.yaml` | Lockfile relative to `working-directory` — for workspace members that is the workspace root's lockfile. Empty when there is none. |
| `workspace-root` | `.` | Where to install dependencies, relative to the workspace root: the monorepo root for workspace members, otherwise `working-directory` itself. |
| `install-command` | `pnpm install --frozen-lockfile` | Dependency install command for the detected package manager, meant to run in `workspace-root` (table below). Empty when there is no safe default. |
| `cache-dependency-path` | `pnpm-lock.yaml` | Dependency file for `cache-dependency-path` of the setup actions, relative to the workspace root: the lockfile, or for pip `requirements.txt` / the manifest. Empty when there is none. |
| `languages` | `[{…}, {…}]` | JSON array with the full result for **every** language found (same fields as the outputs, camelCase) — useful for mixed repos. |
| `projects` | `[{"directory":"apps/web",…}]` | With `discover`: one entry per project directory found — `directory` (relative to the workspace root, usable as `working-directory`), `languages` and every field of its primary result (camelCase). `[]` otherwise. |

Leading `v` is stripped from versions (`v1.2.3` → `1.2.3`); constraints such as `>=3.11` or `^9` are passed through unchanged.

## Detection rules

### Node.js — manifest: `package.json`

| What | Sources, in priority order |
| --- | --- |
| Version | `version` field → [release tooling](#release-tooling) |
| Package manager | `packageManager` field (corepack) → `devEngines.packageManager` → lockfile (`bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json`) → the same from the workspace root (`pnpm-workspace.yaml` alone means pnpm) → `volta`/`engines` entry → `npm` |
| Package manager version | `packageManager` field → `devEngines` → `volta.<pm>` → `.yarnrc.yml` `yarnPath` (Yarn Berry) → `engines.<pm>` (project first, then workspace root) → lockfile format, as a major version: `pnpm-lock.yaml` `lockfileVersion` 5.3 → `6`, 5.4 → `7`, 6.x → `8`, 9.x → `>=9` (pnpm 9 and 10); Yarn v1 lockfile → `1`, Berry lockfile (`__metadata`) → `>=2` |
| Runtime version | `.nvmrc` → `.node-version` → `volta.node` → `devEngines.runtime` → `engines.node` → `.tool-versions` → `mise.toml` |
| Install command | `npm ci` / `npm install`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (Berry) or `--frozen-lockfile` (Classic), `bun install --frozen-lockfile` — the frozen form only when the lockfile belongs to the detected package manager |

### Python — manifest: `pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile` or `requirements.txt` (first found)

| What | Sources, in priority order |
| --- | --- |
| Version | `[project] version` → `[tool.poetry] version` → dynamic version (`[tool.setuptools.dynamic]` `attr:`/`file:`, `[tool.hatch.version] path`, `[tool.pdm.version]`, flit module) → `setup.cfg` `[metadata] version` (incl. `attr:`/`file:`) → `setup.py` `version=` → `VERSION` file → [release tooling](#release-tooling) → `__version__` in the project's own package (see below) → latest git tag (only for SCM-versioned projects) |
| Package manager | lockfile (`uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock`) → membership of a uv workspace → `[tool.uv]` / `[tool.poetry]` / `[tool.pdm]` / `[tool.hatch.envs]` → build backend (`poetry.core…` → poetry, `pdm…` → pdm) → `Pipfile` → `pip` |
| Lockfile | the above, then PEP 751 `pylock.toml` / `pylock.<name>.toml` (tool-agnostic, so it does not decide the package manager); workspace members get the root `uv.lock` |
| Package manager version | `poetry.lock` header (`@generated by Poetry X.Y.Z`) → `[tool.poetry] requires-poetry` → `[tool.uv] required-version` (project, then workspace root) |
| Runtime version | `.python-version` → `[project] requires-python` → `[tool.poetry.dependencies] python` → `Pipfile` `[requires]` → `setup.cfg` `python_requires` → `runtime.txt` → `.tool-versions` → `mise.toml` |
| Install command | `uv sync --locked` (`--package <name>` for workspace members), `poetry install`, `pdm sync` / `pdm install`, `hatch env create`, `pipenv install --deploy` / `pipenv install`, `pip install -r requirements.txt` / `pip install .` |

The `__version__` scan only looks at the project's own package: the module named after the project (`my-app` → `my_app`, in the root or `src/`), or else the single top-level package in the root or `src/`. Directories such as `tests/`, `docs/`, `vendor/` or `third_party/` never count, and with several candidate packages nothing is guessed.

### Go — manifest: `go.mod` (or `go.work`, `Gopkg.toml`)

| What | Sources, in priority order |
| --- | --- |
| Name | `module` directive |
| Version | `VERSION` file → [release tooling](#release-tooling) → `Version = "…"` / `Version string = "…"` constant in `version.go`, `internal/version/version.go`, `cmd/**/version.go`, … (placeholders like `"dev"` are ignored) → a package-level one-line `var version = "X.Y…"` in `main.go` / `cmd/*/main.go` → latest git tag |
| Package manager | `go` (modules), `dep` for `Gopkg.toml` |
| Package manager version | `toolchain` directive |
| Runtime version | `go` directive → `toolchain` → `.tool-versions` → `mise.toml` |
| Install command | `go mod download` (`dep ensure` for dep; none for a bare `go.work`) |

### Rust — manifest: `Cargo.toml`

| What | Sources, in priority order |
| --- | --- |
| Name | `[package] name` (empty for a virtual workspace root) |
| Version | `[package] version` → `[workspace.package] version` (for `version.workspace = true` and virtual workspace roots) → [release tooling](#release-tooling) → latest git tag |
| Package manager | `cargo` |
| Lockfile | `Cargo.lock` of the package, otherwise of its cargo workspace root |
| Runtime version | `rust-toolchain.toml` `[toolchain] channel` / legacy `rust-toolchain`, in the package directory or the nearest parent up to the repository root (as rustup resolves them) → `rust-version` (MSRV; inherited from `[workspace.package]` with `rust-version.workspace = true`) → `.tool-versions` → `mise.toml` |
| Install command | `cargo fetch --locked` with a `Cargo.lock`, otherwise `cargo fetch` |

The cargo workspace of a package is its own Cargo.toml when that has a `[workspace]` table, the path in `package.workspace`, or else the nearest parent with a `[workspace]` that does not `exclude` it.

### Dart / Flutter — manifest: `pubspec.yaml`

`language` is `dart` for both; a project is a Flutter project — `package-manager` `flutter` instead of `dart` — when it depends on the Flutter SDK (`flutter: sdk: flutter`), constrains `environment.flutter` or has a `flutter:` section.

| What | Sources, in priority order |
| --- | --- |
| Name | `name` |
| Version | `version`, as written (`1.4.0+27`: `version-build` is `27`) → [release tooling](#release-tooling) |
| Package manager | `flutter` or `dart` (pub) |
| Lockfile | `pubspec.lock` of the package, otherwise of its [pub workspace](https://dart.dev/tools/pub/workspaces) root (members declare `resolution: workspace`, the root lists them under `workspace:`) |
| Runtime version (Flutter) | The **Flutter** SDK version — Dart comes with it: FVM pin (`.fvmrc` `flutter`, `.fvm/fvm_config.json` `flutterSdkVersion`) in the package directory or the nearest parent up to the repository root → `environment.flutter` → `.tool-versions` → `mise.toml` |
| Runtime version (Dart) | `environment.sdk` → `.tool-versions` → `mise.toml` |
| Install command | `flutter pub get` / `dart pub get`, with `--enforce-lockfile` when there is a `pubspec.lock` |

`pubspec.yaml` is parsed with the YAML failsafe schema, so `version: 1.10` stays `1.10` instead of becoming the number 1.1.

### Ruby — manifest: `Gemfile` (or `gems.rb`, or a `*.gemspec` alone)

| What | Sources, in priority order |
| --- | --- |
| Name | gemspec `spec.name = "…"` or `Gem::Specification.new "…"` (empty for apps) |
| Version | gemspec literal version → `VERSION = "…"` in `lib/<name>/version.rb` (or the single `lib/*/version.rb`) → `VERSION` file → [release tooling](#release-tooling) |
| Package manager | `bundler`; version from `BUNDLED WITH` in `Gemfile.lock` |
| Runtime version | `.ruby-version` → Gemfile `ruby "…"` / `ruby file: "…"` → `Gemfile.lock` `RUBY VERSION` → `.tool-versions` → `mise.toml` |
| Install command | `bundle install` (none for a gemspec without Gemfile) |

### PHP — manifest: `composer.json`

| What | Sources, in priority order |
| --- | --- |
| Name / version | `name`; `version` → [release tooling](#release-tooling) → latest git tag (Packagist versions packages by tags) |
| Package manager | `composer`; lockfile `composer.lock` |
| Runtime version | `.php-version` → `composer.lock` `platform-overrides.php` → `config.platform.php` → `require.php` → `.tool-versions` → `mise.toml` — the first three in the order shivammathur/setup-php reads them |
| Install command | `composer install --no-interaction` |

### .NET — manifest: `*.sln` / `*.slnx`, else `*.csproj` / `*.fsproj` / `*.vbproj` (first by name)

| What | Sources, in priority order |
| --- | --- |
| Name | project `PackageId` → `AssemblyName` → file name (solutions: file name) |
| Version | project `Version` → `VersionPrefix`[`-VersionSuffix`] → the same in the nearest `Directory.Build.props` (and local files it imports, e.g. `Directory.Version.props`) → Nerdbank.GitVersioning `version.json` → [release tooling](#release-tooling) → latest git tag (MinVer, GitVersion); conditional and computed (`$(…)`) values are skipped |
| Package manager | `dotnet` (NuGet); lockfile `packages.lock.json` |
| Runtime version | `global.json` `sdk.version`, looked up to the repository root like the `dotnet` CLI → highest `TargetFramework(s)` as an SDK major (`net8.0` → `8.0`) → `.tool-versions` → `mise.toml` |
| Install command | `dotnet restore` (with the file name when the directory holds several solutions/projects; `--locked-mode` with a lockfile) |

### Java / JVM — manifest: `pom.xml`, else `build.gradle(.kts)` / `settings.gradle(.kts)`

`language` is `java` for every Maven or Gradle build, Kotlin and Android included; a directory with both a POM and a Gradle build is reported as Maven.

| What | Maven | Gradle |
| --- | --- | --- |
| Name | `artifactId` | `rootProject.name` of the settings file, otherwise the directory name |
| Version | `version` (`${revision}`-style placeholders resolved from properties and `.mvn/maven.config`) → the parent's version when the parent is in this repository → [release tooling](#release-tooling) → latest git tag | `gradle.properties` `version` → `version = "…"` → Android `versionName` + `versionCode` (`1.4.0+27`) → the build root's `gradle.properties` / build file → [release tooling](#release-tooling) → latest git tag |
| Package manager version | Maven version from `.mvn/wrapper/maven-wrapper.properties` | Gradle version from `gradle/wrapper/gradle-wrapper.properties` |
| Build root (`workspace-root`) | top of the `<modules>` aggregator chain | the directory whose `settings.gradle(.kts)` `include`s the project |
| Runtime version | `.java-version` → `.sdkmanrc` → `maven.compiler.release` / `java.version` / `maven.compiler.target` / `.source` (own POM, then the aggregators) → `.tool-versions` → `mise.toml` | `.java-version` → `.sdkmanrc` → `JavaLanguageVersion.of(…)` / `jvmToolchain(…)` / `sourceCompatibility` (own build file, then the root's) → `.tool-versions` → `mise.toml` |
| Install command | `./mvnw -B dependency:go-offline` (or `mvn`) for single-module builds; none for multi-module builds, where unbuilt sibling modules cannot be resolved | none — Gradle resolves dependencies during the build |

### Release tooling

Versions recorded by release tools count for every language. They rank after the manifest's own version (and a `VERSION` file) and before guessing from source code:

| Tool | Read from |
| --- | --- |
| [release-please](https://github.com/googleapis/release-please) | `.release-please-manifest.json` in the project directory or the nearest parent (up to the repository root), entry keyed by the project's path (`.` for the root, `packages/api`, …) |
| [bump-my-version](https://github.com/callowayproject/bump-my-version) / bump2version | `current_version` in `.bumpversion.toml`, `.bumpversion.cfg`, `pyproject.toml` `[tool.bumpversion]` or `setup.cfg` `[bumpversion]` (first found) |
| [commitizen](https://commitizen-tools.github.io/commitizen/) | `version` in the first commitizen configuration (`pyproject.toml` `[tool.commitizen]`, `.cz.toml`, `.cz.json`, `cz.json`, `.cz.yaml`, `cz.yaml`, `cz.toml`); ignored when `version_provider` is set to anything but `commitizen` |

### Git tags

The git-tag fallback uses `git describe --tags --abbrev=0` restricted to release-shaped tags (`v1.2.3`, `1.2.3`, at least `MAJOR.MINOR`), so tags such as `nightly`, `latest` or a floating major tag (`v1`) are never reported as the version. A Go module in a subdirectory uses Go's tag convention — the module in `tools/` is versioned by `tools/v1.2.3` tags — and the prefix is stripped. With `actions/checkout` you need `fetch-depth: 0` (or `fetch-tags: true`) for it to see any tags.

Other tag schemes are selected with `tag-pattern` — e.g. `release-*` (tags `release-1.4.0`) or `api@v*` (per-package tags `api@v2.0.1` in a monorepo). The patterns replace the defaults (including the Go module prefix), the literal part before the first wildcard is stripped, and the rest must still look like a release version.

### Monorepos and parent directories

When `working-directory` points into a repository, parent directories up to the repository root (or `GITHUB_WORKSPACE`, whichever is nearer) are consulted as well:

- **Workspace members** — a directory listed in a parent's `pnpm-workspace.yaml`, `package.json#workspaces` (npm, Yarn, Bun; globs and `!` negations) or `[tool.uv.workspace] members` (minus `exclude`), a member of a cargo workspace, a pub workspace member (`resolution: workspace`), a module of a Maven aggregator or a project `include`d by a Gradle settings file — inherit the workspace root's lockfile, `packageManager` / `devEngines` / `volta` / `engines` declarations, uv settings and `[workspace.package]` values. `workspace-root` then points at that root and `install-command` is meant to run there. Declarations of the project itself always win over the root's.
- **Runtime version files** (`.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`, `mise.toml`) are looked up in parent directories the way nvm, pyenv, asdf and mise do — nearest first, after everything declared in the project directory. Toolchain pins that decide what gets installed — `rust-toolchain(.toml)` and FVM's `.fvmrc` — win over a package's own constraint (`rust-version`, `environment.flutter`) wherever they sit up to the repository root.

A nested project that is *not* a workspace member keeps its own package manager and lockfile.

### Mixed repositories

If several languages are found in one directory, they are all reported in the `languages` output and the primary one is chosen in the order **node → python → go → rust → dart → ruby → php → dotnet → java**, with a warning. Set `language-priority:` (e.g. `python,node` for a Django app with a Tailwind `package.json`, or `php` for a Laravel app with its Vite `package.json`) to change the order, `language:` to consider a single language only, or point `working-directory` at the sub-project.

## Discovering projects

With `discover: true` the action also inspects every directory up to `discover-max-depth` levels below `working-directory` and reports each one that contains a project in the `projects` output — a JSON array ready for a matrix. The regular outputs keep describing `working-directory` itself. Hidden directories (`.git`, `.github`, `.venv`, …), dependency and build output (`node_modules`, `vendor`, `dist`, `build`, `target`, `venv`, `__pycache__`, …) and test data (`testdata`, `fixtures`) are never descended into; add more with `discover-exclude`. `language` and `language-priority` apply to every discovered directory.

```yaml
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      projects: ${{ steps.project.outputs.projects }}
    steps:
      - uses: actions/checkout@v7
      - id: project
        uses: emilgruzalski/detect-project@v1
        with:
          working-directory: apps        # every app below apps/, but not the monorepo root itself
          discover: true
          discover-exclude: legacy

  build:
    needs: detect
    if: needs.detect.outputs.projects != '[]'
    name: ${{ matrix.project.directory }} (${{ matrix.project.language }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.detect.outputs.projects) }}
    steps:
      - uses: actions/checkout@v7
      - if: matrix.project.language == 'node'
        uses: actions/setup-node@v7
        with:
          node-version-file: ${{ matrix.project.languageVersionFile }}
      - name: Install dependencies
        working-directory: ${{ matrix.project.workspaceRoot }}
        env:
          INSTALL_COMMAND: ${{ matrix.project.installCommand }}
        run: $INSTALL_COMMAND
      - name: Test
        working-directory: ${{ matrix.project.directory }}
        run: echo "testing ${{ matrix.project.name }} ${{ matrix.project.version }}"
```

A directory that is itself a project — e.g. a monorepo root with a `package.json` — is reported as `.`; start from a subdirectory (as above) when the root should not get a job of its own. A matrix is limited to 256 jobs.

## Troubleshooting

With [step debug logging](https://docs.github.com/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging) enabled (`ACTIONS_STEP_DEBUG` = `true`, or *Re-run jobs → Enable debug logging*), the log shows for every resolved value where it came from and which sources had nothing, e.g.

```
[apps/api] node version: "1.4.0" from .release-please-manifest.json (nothing in: package.json:version)
[apps/api] node runtime: "22" from ../../.nvmrc
```

## Passing the runtime to setup actions

`language-version` is passed through exactly as written, which is not always valid input for `node-version` / `python-version` — a PEP 440 constraint such as `>=3.10,<3.13` is not a SemVer range. Prefer the `*-version-file` inputs with `language-version-file`: the setup action then reads the file itself. The output is only set for files that the official actions read the same value from:

| Language | `language-version-file` is set for |
| --- | --- |
| Node.js (`node-version-file`) | `.nvmrc`, `.node-version`, `package.json` (`volta.node`, `devEngines.runtime`, `engines.node`), `.tool-versions`, `mise.toml` (`tools.node` as a string or `{ version }`) |
| Python (`python-version-file`) | `.python-version`, `pyproject.toml` (`requires-python`, or Poetry's `python` when there is no `[project]` table), `Pipfile`, `.tool-versions` |
| Go (`go-version-file`) | `go.mod` / `go.work` (setup-go prefers the `toolchain` directive), `.tool-versions` (`golang` entry) |
| Flutter (`flutter-version-file` of [subosito/flutter-action](https://github.com/subosito/flutter-action)) | `.fvmrc`, `.fvm/fvm_config.json`, `pubspec.yaml` (only with an exact `environment.flutter` such as `3.24.3`) |
| Rust (no file input) | `rust-toolchain.toml` / `rust-toolchain` — rustup and [actions-rust-lang/setup-rust-toolchain](https://github.com/actions-rust-lang/setup-rust-toolchain) without a `toolchain` input read it by themselves |
| Ruby (no file input) | `.ruby-version`, `.tool-versions`, `mise.toml` (`tools.ruby` as a string) — [ruby/setup-ruby](https://github.com/ruby/setup-ruby) reads them itself from its `working-directory` |
| PHP (`php-version-file` of [shivammathur/setup-php](https://github.com/shivammathur/setup-php)) | `.php-version`, `.tool-versions` |
| .NET (`global-json-file` of actions/setup-dotnet) | `global.json` |
| Java (`java-version-file` of actions/setup-java) | `.java-version`, `.sdkmanrc`, `.tool-versions` |

For sources such as `setup.cfg`, `runtime.txt`, a mise file for Python/Go, a Rust `rust-version` (MSRV), a Flutter version range, a Gemfile `ruby` line, `composer.json` constraints, a .NET target framework or a POM/Gradle Java level it is empty, so fall back to `language-version` or a default. [dart-lang/setup-dart](https://github.com/dart-lang/setup-dart) only takes an `sdk` version or channel, so for pure Dart projects it is always empty; `language-version` is the `environment.sdk` constraint there. setup-php reads `composer.lock` `platform-overrides.php` and `config.platform.php` by itself when given no version.

## Example: set up, install and tag

```yaml
- id: project
  uses: emilgruzalski/detect-project@v1
  with:
    working-directory: apps/api

- if: steps.project.outputs.language == 'node'
  uses: actions/setup-node@v7
  with:
    node-version-file: ${{ steps.project.outputs.language-version-file }}
    node-version: ${{ steps.project.outputs.language-version-file == '' && '24' || '' }}

- if: steps.project.outputs.language == 'python'
  uses: actions/setup-python@v7
  with:
    python-version-file: ${{ steps.project.outputs.language-version-file }}
    cache: ${{ steps.project.outputs.package-manager == 'pip' && 'pip' || '' }}
    cache-dependency-path: ${{ steps.project.outputs.cache-dependency-path }}

- if: steps.project.outputs.language == 'go'
  uses: actions/setup-go@v7
  with:
    go-version-file: ${{ steps.project.outputs.language-version-file }}
    cache-dependency-path: ${{ steps.project.outputs.cache-dependency-path }}

# Without a `toolchain` input it installs what rust-toolchain(.toml) asks for.
- if: steps.project.outputs.language == 'rust'
  uses: actions-rust-lang/setup-rust-toolchain@v2

- if: steps.project.outputs.package-manager == 'flutter'
  uses: subosito/flutter-action@v2
  with:
    flutter-version-file: ${{ steps.project.outputs.language-version-file }}
    channel: stable

- if: steps.project.outputs.package-manager == 'dart'
  uses: dart-lang/setup-dart@v1

# Reads .ruby-version / .tool-versions / mise.toml from working-directory; installs BUNDLED WITH.
- if: steps.project.outputs.language == 'ruby'
  uses: ruby/setup-ruby@v1
  with:
    working-directory: ${{ steps.project.outputs.workspace-root }}
    bundler-cache: true

- if: steps.project.outputs.language == 'php'
  uses: shivammathur/setup-php@v2
  with:
    php-version-file: ${{ steps.project.outputs.language-version-file }}

- if: steps.project.outputs.language == 'dotnet'
  uses: actions/setup-dotnet@v6
  with:
    global-json-file: ${{ steps.project.outputs.language-version-file }}
    dotnet-version: ${{ steps.project.outputs.language-version-file == '' && steps.project.outputs.language-version || '' }}

- if: steps.project.outputs.language == 'java'
  uses: actions/setup-java@v6
  with:
    distribution: temurin
    java-version-file: ${{ steps.project.outputs.language-version-file }}
    java-version: ${{ steps.project.outputs.language-version-file == '' && steps.project.outputs.language-version || '' }}
    cache: ${{ steps.project.outputs.package-manager }}

- name: Install dependencies
  if: steps.project.outputs.install-command != ''
  working-directory: ${{ steps.project.outputs.workspace-root }}
  env:
    INSTALL_COMMAND: ${{ steps.project.outputs.install-command }}
  run: $INSTALL_COMMAND

- name: Build image
  env:
    VERSION: ${{ steps.project.outputs.version || github.sha }}
    MAJOR_MINOR: ${{ steps.project.outputs.version-major }}.${{ steps.project.outputs.version-minor }}
    PRERELEASE: ${{ steps.project.outputs.is-prerelease }}
  run: |
    # Docker tags allow [A-Za-z0-9_.-] only: build metadata such as 1.2.3+45 becomes 1.2.3-45.
    tags=(-t "my-app:${VERSION//+/-}")
    if [ "$PRERELEASE" = false ] && [ "$MAJOR_MINOR" != . ]; then tags+=(-t "my-app:$MAJOR_MINOR"); fi
    docker build "${tags[@]}" .
```

Pass outputs to `run:` through `env:` as above rather than `${{ }}` inside the script: values such as names and versions come from files in the repository.

## Development

Requires Node.js 24 (see `.node-version`) and [Bun](https://bun.sh) as the package manager (version pinned in `packageManager`). Scripts run on Node; Bun only installs dependencies and runs scripts.

```bash
bun install
bun run typecheck
bun run test          # vitest unit tests
bun run package       # bundles src/index.ts + dependencies into dist/index.js (rollup, ESM)
bun run test:e2e      # e2e tests that run the bundled dist/index.js like the runner does
bun run test:corpus   # real-world corpus: pinned commits of popular repos vs. a snapshot (needs network)
bun run local-action  # runs the action locally via @github/local-action using inputs from .env
```

`dist/` is committed (GitHub runs the action straight from it, no dependency install on the runner); CI fails if it is out of date, so run `bun run package` before committing source changes. To try the action locally, copy `.env.example` to `.env` and run `bun run local-action`.

The e2e scenarios live in `__tests__/e2e-scenarios.json`; both `bun run test:e2e` and the CI `e2e` matrix read them, so a scenario is added in one place. The corpus (`__tests__/corpus/corpus.json`) runs weekly, on demand and on pull requests that touch `src/`; after a deliberate behaviour change, review the diff and update the snapshot with `bun run test:corpus -u`.

Source layout:

```
src/
  index.ts             # runtime entry: calls run() and reports failures
  main.ts              # run(): inputs → detection → outputs + job summary
  detect.ts            # runs the detectors, picks the primary language
  discover.ts          # walks subdirectories for the discover input
  detectors/
    node.ts python.ts go.ts rust.ts dart.ts ruby.ts php.ts dotnet.ts java.ts
  utils/
    sources.ts         # resolveFirst(): ordered, named value sources with debug logging
    release-tools.ts   # release-please / bump-my-version / commitizen versions
    runtime.ts         # runtime version files, walking up to the repository root
    fs.ts ...          # cached fs helpers, TOML/INI parsing, version handling, workspace globs
__tests__/             # vitest suites (e2e.test.ts runs dist/, corpus.test.ts clones real repos) + fixtures
```

Adding a language means implementing the `Detector` interface from `src/types.ts` and registering it in `src/detectors/index.ts`.

## Releasing

1. Bump `version` in `package.json`, add an entry to [CHANGELOG.md](CHANGELOG.md), run `bun run all`, commit (including `dist/`).
2. Create a GitHub release with a `vMAJOR.MINOR.PATCH` tag (e.g. `v1.2.0`). Tick **Publish this Action to the GitHub Marketplace** on the release form if you want it listed.
3. The [Release workflow](.github/workflows/release.yml) verifies that `dist/` is fresh and force-moves the floating major tag (`v1`) to that release, so `uses: …@v1` users get the update.

Pre-releases (e.g. `v2.0.0-rc.1`) never move a major tag. Major tags are plain git tags without a GitHub release, which keeps them movable even with immutable releases enabled.
