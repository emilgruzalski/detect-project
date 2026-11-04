# Detect Project

A GitHub Action that looks at a directory and tells your workflow **what the project is**: its language, application version, package manager, runtime version and the command that installs its dependencies — for **Node.js, Python, Go, Rust, Dart/Flutter, Ruby, PHP, .NET and Java/JVM** (Maven, Gradle).

Use it to pick the right `setup-*` action in a reusable workflow, tag images with the app version, run the right install command without hard-coding it per repository, or fan out a matrix over every project in a monorepo.

- **Reads what the tools read** — manifests, lockfiles, `.nvmrc`/`.python-version`/`rust-toolchain.toml`/`global.json`/…, release tooling and git tags — and says where every value came from.
- **Monorepo-aware** — workspace members (pnpm, npm/Yarn/Bun, uv, cargo, pub, Maven, Gradle) inherit the root's lockfile, package manager and settings; `discover` lists every project for a matrix.
- **Setup-ready outputs** — `language-version-file` plugs straight into `node-version-file`, `python-version-file`, `go-version-file`, `java-version-file`, …

Runs on the `node24` action runtime (default on GitHub-hosted runners; self-hosted runners need v2.327.1+).

## Quick start

```yaml
- uses: actions/checkout@v7

- id: project
  uses: emilgruzalski/detect-project@v1
  with:
    working-directory: apps/api   # optional, default "."

- run: echo "${{ steps.project.outputs.language }} ${{ steps.project.outputs.version }} via ${{ steps.project.outputs.package-manager }}"
```

For `apps/api` in a pnpm monorepo this gives, among others:

| Output | Value |
| --- | --- |
| `language` / `name` / `version` | `node` / `@acme/api` / `2.1.0-rc.1` |
| `package-manager` / `package-manager-version` | `pnpm` / `10.4.1` |
| `language-version` / `language-version-file` | `22.11.0` / `.nvmrc` (found in the repository root) |
| `install-command` / `workspace-root` | `pnpm install --frozen-lockfile` / `.` |

## Supported ecosystems

| `language` | Manifest | `package-manager` | Runtime version from (first match) |
| --- | --- | --- | --- |
| `node` | `package.json` | `npm`, `pnpm`, `yarn`, `bun` | `.nvmrc`, `.node-version`, `volta`, `devEngines.runtime`, `engines.node` |
| `python` | `pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile`, `requirements.txt` | `pip`, `uv`, `poetry`, `pdm`, `pipenv`, `hatch` | `.python-version`, `requires-python`, Poetry `python`, `Pipfile` |
| `go` | `go.mod`, `go.work`, `Gopkg.toml` | `go`, `dep` | `go` / `toolchain` directive |
| `rust` | `Cargo.toml` | `cargo` | `rust-toolchain(.toml)`, `rust-version` |
| `dart` | `pubspec.yaml` | `dart`, `flutter` | Flutter: `.fvmrc`, `environment.flutter` · Dart: `environment.sdk` |
| `ruby` | `Gemfile`, `gems.rb`, `*.gemspec` | `bundler` | `.ruby-version`, Gemfile `ruby`, `Gemfile.lock` |
| `php` | `composer.json` | `composer` | `.php-version`, Composer platform, `require.php` |
| `dotnet` | `*.sln(x)`, `*.csproj`, `*.fsproj`, `*.vbproj` | `dotnet` | `global.json`, target framework |
| `java` | `pom.xml`, `build.gradle(.kts)`, `settings.gradle(.kts)` | `maven`, `gradle` | `.java-version`, `.sdkmanrc`, compiler release / toolchain |

`.tool-versions` (asdf) and `mise.toml` are read for every runtime. The complete rules are under [How detection works](#how-detection-works).

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `working-directory` | `.` | Directory to inspect, relative to the workspace root. The step **fails** when it does not exist. |
| `language` | `auto` | Only consider this language: `node`, `python`, `go`, `rust`, `dart` (incl. Flutter), `ruby`, `php`, `dotnet` or `java` (any Maven/Gradle build). |
| `language-priority` | | Languages to prefer as primary when a directory has several, comma separated (`python,node`). The rest keep the default order. |
| `tag-pattern` | | `git describe --match` globs for the [git-tag fallback](#versions), comma or newline separated (`release-*`, `api@v*`). |
| `discover` | `false` | Also inspect the subdirectories and report every project in the `projects` output. See [Monorepo matrix](#build-every-project-of-a-monorepo). |
| `discover-max-depth` | `3` | How many levels below `working-directory` `discover` goes (`0`–`10`). |
| `discover-exclude` | | Globs relative to `working-directory` that `discover` skips, comma or newline separated (`examples, legacy/**`). |
| `fail-on-unknown` | `false` | Fail the step when no project is found (with `discover`: neither in `working-directory` nor below it). |

## Outputs

| Output | Example | Description |
| --- | --- | --- |
| `language` | `node` | Primary language (see [Supported ecosystems](#supported-ecosystems)) or `unknown`. |
| `name` | `my-app` | Project name from the manifest (package name, module path, `artifactId`, …). |
| `manifest` | `package.json` | Manifest the detection is based on, relative to `working-directory`. |
| `version` | `1.4.2-rc.1` | Application version; empty when nothing declares one. A leading `v` is stripped. |
| `version-source` | `package.json` | Where the version came from, e.g. `pyproject.toml:project.version`, `../../.release-please-manifest.json:apps/api`, `git-tag`. |
| `version-major` / `version-minor` / `version-patch` | `1` / `4` / `2` | Version components; minor and patch are `0` when absent. |
| `version-prerelease` | `rc.1` | Pre-release part (`rc.1`, `beta2`, PEP 440 `dev3`); empty for final releases. |
| `version-build` | `27` | Build metadata after `+` (`1.4.0+27`). |
| `is-prerelease` | `false` | `true` when `version-prerelease` is set. |
| `package-manager` | `pnpm` | Package manager or build tool (see [Supported ecosystems](#supported-ecosystems)). |
| `package-manager-version` | `9.12.0` | Its version when declared (`packageManager`, wrapper, `BUNDLED WITH`, …); for pnpm and Yarn otherwise the major implied by the lockfile. |
| `lockfile` | `../../pnpm-lock.yaml` | Lockfile relative to `working-directory` — the workspace root's for workspace members. |
| `install-command` | `pnpm install --frozen-lockfile` | Dependency install command, to run in `workspace-root`; empty when there is no safe default. |
| `workspace-root` | `.` | Where to install dependencies, relative to the workspace root: the monorepo root for workspace members, else `working-directory`. |
| `cache-dependency-path` | `pnpm-lock.yaml` | File for the setup actions' `cache-dependency-path`, relative to the workspace root. |
| `language-version` | `>=20` | Runtime version or constraint, as written (`.nvmrc`, `requires-python`, `go` directive, …). |
| `language-version-source` | `package.json:engines.node` | Where `language-version` came from, relative to `working-directory`. |
| `language-version-file` | `apps/api/.nvmrc` | That file, relative to the workspace root — **only** when the setup action reads the same value from it. See [Set up the toolchain](#set-up-the-toolchain). |
| `languages` | `[{…}]` | JSON array with the full result (camelCase fields) for **every** language found in the directory. |
| `projects` | `[{"directory":"apps/web",…}]` | With `discover`: one entry per project directory (`directory`, `languages` and all fields of its primary result); `[]` otherwise. |

## Recipes

### Set up the toolchain

`language-version` is passed through as written, so it is not always valid input for a setup action — a PEP 440 constraint such as `>=3.10,<3.13` is not a SemVer range. Pass `language-version-file` to the action's version-file input instead; it is only set when the action reads the same value from that file:

| Setup action | `language-version-file` is set for |
| --- | --- |
| actions/setup-node (`node-version-file`) | `.nvmrc`, `.node-version`, `package.json` (`volta.node`, `devEngines.runtime`, `engines.node`), `.tool-versions`, `mise.toml` (`tools.node`) |
| actions/setup-python (`python-version-file`) | `.python-version`, `pyproject.toml` (`requires-python`, or Poetry's `python` without a `[project]` table), `Pipfile`, `.tool-versions` |
| actions/setup-go (`go-version-file`) | `go.mod` / `go.work`, `.tool-versions` (`golang`) |
| subosito/flutter-action (`flutter-version-file`) | `.fvmrc`, `.fvm/fvm_config.json`, `pubspec.yaml` with an exact `environment.flutter` |
| shivammathur/setup-php (`php-version-file`) | `.php-version`, `.tool-versions` |
| actions/setup-dotnet (`global-json-file`) | `global.json` |
| actions/setup-java (`java-version-file`) | `.java-version`, `.sdkmanrc`, `.tool-versions` |
| ruby/setup-ruby (reads files itself) | `.ruby-version`, `.tool-versions`, `mise.toml` (`tools.ruby`) |
| actions-rust-lang/setup-rust-toolchain (reads files itself) | `rust-toolchain.toml`, `rust-toolchain` |

For other sources — `setup.cfg`, `runtime.txt`, a Rust MSRV, a Flutter range, a Gemfile `ruby` line, Composer constraints, a .NET target framework, a POM/Gradle Java level — it is empty; fall back to `language-version` or a default. dart-lang/setup-dart has no version-file input.

```yaml
- if: steps.project.outputs.language == 'node'
  uses: actions/setup-node@v7
  with:
    node-version-file: ${{ steps.project.outputs.language-version-file }}
    node-version: ${{ steps.project.outputs.language-version-file == '' && '24' || '' }}

- if: steps.project.outputs.language == 'python'
  uses: actions/setup-python@v7
  with:
    python-version-file: ${{ steps.project.outputs.language-version-file }}

- if: steps.project.outputs.language == 'go'
  uses: actions/setup-go@v7
  with:
    go-version-file: ${{ steps.project.outputs.language-version-file }}
    cache-dependency-path: ${{ steps.project.outputs.cache-dependency-path }}

- if: steps.project.outputs.language == 'rust'
  uses: actions-rust-lang/setup-rust-toolchain@v2   # installs what rust-toolchain(.toml) asks for

- if: steps.project.outputs.package-manager == 'flutter'
  uses: subosito/flutter-action@v2
  with:
    flutter-version-file: ${{ steps.project.outputs.language-version-file }}

- if: steps.project.outputs.package-manager == 'dart'
  uses: dart-lang/setup-dart@v1

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
```

### Install dependencies

```yaml
- if: steps.project.outputs.install-command != ''
  working-directory: ${{ steps.project.outputs.workspace-root }}
  env:
    INSTALL_COMMAND: ${{ steps.project.outputs.install-command }}
  run: $INSTALL_COMMAND
```

Pass outputs to `run:` through `env:` like this rather than `${{ }}` inside the script — names and versions come from files in the repository. The commands are frozen where the tool supports it (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`, `cargo fetch --locked`, …) and only when the lockfile belongs to the detected package manager. Gradle and multi-module Maven builds get none: they resolve dependencies during the build.

### Tag a Docker image

```yaml
- env:
    VERSION: ${{ steps.project.outputs.version || github.sha }}
    MAJOR_MINOR: ${{ steps.project.outputs.version-major }}.${{ steps.project.outputs.version-minor }}
    PRERELEASE: ${{ steps.project.outputs.is-prerelease }}
  run: |
    # Docker tags allow [A-Za-z0-9_.-] only: build metadata such as 1.2.3+45 becomes 1.2.3-45.
    tags=(-t "my-app:${VERSION//+/-}")
    if [ "$PRERELEASE" = false ] && [ "$MAJOR_MINOR" != . ]; then tags+=(-t "my-app:$MAJOR_MINOR"); fi
    docker build "${tags[@]}" .
```

### Build every project of a monorepo

With `discover: true` the action also inspects every directory up to `discover-max-depth` levels below `working-directory` and lists each project in `projects`, ready for a matrix. The regular outputs keep describing `working-directory` itself.

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
          working-directory: apps   # every app below apps/, not the monorepo root itself
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
      - working-directory: ${{ matrix.project.workspaceRoot }}
        env:
          INSTALL_COMMAND: ${{ matrix.project.installCommand }}
        run: $INSTALL_COMMAND
```

Hidden directories (`.git`, `.github`, `.venv`, …), dependency and build output (`node_modules`, `vendor`, `dist`, `build`, `target`, …) and test data (`testdata`, `fixtures`) are never descended into. A directory that is itself a project — such as a monorepo root with a `package.json` — is listed as `.`. `language` and `language-priority` apply to every directory; a matrix holds at most 256 jobs.

## How detection works

Each value comes from an ordered list of sources; the first one that has it wins, and `*-source` outputs (plus the [debug log](https://github.com/emilgruzalski/detect-project/blob/main/docs/troubleshooting.md)) say which one that was.

### Parent directories and workspaces

When `working-directory` points into a repository, parent directories up to the repository root (or `GITHUB_WORKSPACE`, whichever is nearer) are consulted too:

- **Workspace members** inherit the workspace root's lockfile, package manager declarations and shared settings, and `workspace-root` points at that root: members of `pnpm-workspace.yaml`, `package.json#workspaces` (npm, Yarn, Bun), `[tool.uv.workspace]`, cargo workspaces, pub workspaces (`resolution: workspace`), Maven `<modules>` aggregators and Gradle `settings.gradle(.kts)` `include`s. The project's own declarations always win. A nested project that is *not* a member keeps its own.
- **Runtime version files** (`.nvmrc`, `.python-version`, `.tool-versions`, …) are looked up in parent directories the way nvm, pyenv and asdf do — nearest first, after everything in the project directory. Toolchain pins that decide what gets installed — `rust-toolchain(.toml)`, FVM's `.fvmrc`, `global.json` — win over a package's own constraint wherever they sit.

### Versions

After the manifest's own version (and a plain `VERSION` file), release tooling is consulted for every language:

| Tool | Read from |
| --- | --- |
| [release-please](https://github.com/googleapis/release-please) | `.release-please-manifest.json` in the project directory or the nearest parent, entry keyed by the project's path |
| [bump-my-version](https://github.com/callowayproject/bump-my-version) / bump2version | `current_version` in `.bumpversion.toml`, `.bumpversion.cfg`, `pyproject.toml` or `setup.cfg` |
| [commitizen](https://commitizen-tools.github.io/commitizen/) | `version` in its configuration, unless `version_provider` points elsewhere |

The last resort for Go, Rust, PHP, .NET, Java and SCM-versioned Python projects is the latest **git tag**: `git describe --tags` restricted to release-shaped tags (`v1.2.3`, `1.2.3`), so `nightly` or a floating `v1` never count. A Go module in a subdirectory uses its `dir/v1.2.3` tags. `tag-pattern` selects other schemes (`release-*`, `api@v*`); the literal part before the first wildcard is stripped. With `actions/checkout`, use `fetch-depth: 0` (or `fetch-tags: true`) so tags are available.

### Mixed repositories

When a directory holds several languages, all are reported in `languages` and the primary one follows the order **node → python → go → rust → dart → ruby → php → dotnet → java**, with a warning. Use `language-priority` to change it — e.g. `python` for a Django app with a Tailwind `package.json`, `php` for a Laravel app with its Vite `package.json` — or `language` to consider one language only.

### Per-language rules

<details>
<summary><b>Node.js</b> — <code>package.json</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Version | `version` → release tooling |
| Package manager | `packageManager` (corepack) → `devEngines.packageManager` → lockfile (`bun.lock(b)`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json`) → the same from the workspace root (`pnpm-workspace.yaml` alone means pnpm) → `volta`/`engines` entry → `npm` |
| Package manager version | `packageManager` → `devEngines` → `volta.<pm>` → `.yarnrc.yml` `yarnPath` → `engines.<pm>` → lockfile format: pnpm `lockfileVersion` 5.3 → `6`, 5.4 → `7`, 6.x → `8`, 9.x → `>=9`; Yarn v1 lockfile → `1`, Berry → `>=2` |
| Runtime version | `.nvmrc` → `.node-version` → `volta.node` → `devEngines.runtime` → `engines.node` → `.tool-versions` → `mise.toml` |
| Install command | `npm ci` / `npm install`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (Berry) or `--frozen-lockfile` (Classic), `bun install --frozen-lockfile` |

</details>

<details>
<summary><b>Python</b> — <code>pyproject.toml</code>, <code>setup.cfg</code>, <code>setup.py</code>, <code>Pipfile</code> or <code>requirements.txt</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Version | `[project] version` → `[tool.poetry] version` → dynamic version (setuptools `attr:`/`file:`, hatch `path`, pdm, flit) → `setup.cfg` → `setup.py` → `VERSION` file → release tooling → `__version__` in the project's own package → git tag (SCM-versioned projects only) |
| Package manager | lockfile (`uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock`) → uv workspace membership → `[tool.uv]` / `[tool.poetry]` / `[tool.pdm]` / `[tool.hatch.envs]` → build backend → `Pipfile` → `pip` |
| Lockfile | the above, then PEP 751 `pylock.toml` / `pylock.<name>.toml`; uv workspace members get the root `uv.lock` |
| Package manager version | `poetry.lock` header → `requires-poetry` → `[tool.uv] required-version` |
| Runtime version | `.python-version` → `requires-python` → Poetry `python` → `Pipfile` `[requires]` → `setup.cfg` `python_requires` → `runtime.txt` → `.tool-versions` → `mise.toml` |
| Install command | `uv sync --locked` (`--package <name>` for workspace members), `poetry install`, `pdm sync`/`install`, `hatch env create`, `pipenv install --deploy`, `pip install -r requirements.txt` / `pip install .` |

The `__version__` scan only reads the project's own package — the module named after the project (`my-app` → `my_app`, in the root or `src/`) or the single top-level package — never `tests/`, `vendor/`, `third_party/` and the like.

</details>

<details>
<summary><b>Go</b> — <code>go.mod</code>, <code>go.work</code> or <code>Gopkg.toml</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Name | `module` directive |
| Version | `VERSION` file → release tooling → `Version` constant in `version.go`, `internal/version/version.go`, `cmd/**/version.go`, … (placeholders such as `"dev"` are ignored) → package-level `var version = "X.Y…"` in `main.go` / `cmd/*/main.go` → git tag |
| Package manager | `go`, or `dep` for `Gopkg.toml`; version from the `toolchain` directive |
| Runtime version | `go` directive → `toolchain` → `.tool-versions` → `mise.toml` |
| Install command | `go mod download` (`dep ensure`; none for a bare `go.work`) |

</details>

<details>
<summary><b>Rust</b> — <code>Cargo.toml</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Name | `[package] name` (empty for a virtual workspace root) |
| Version | `[package] version` → `[workspace.package] version` (`version.workspace = true`, virtual roots) → release tooling → git tag |
| Lockfile | `Cargo.lock` of the package, else of its cargo workspace root (own `[workspace]`, `package.workspace`, or the nearest parent `[workspace]` that does not `exclude` it) |
| Runtime version | `rust-toolchain.toml` / `rust-toolchain` up to the repository root, as rustup resolves them → `rust-version` (MSRV, incl. workspace inheritance) → `.tool-versions` → `mise.toml` |
| Install command | `cargo fetch --locked` with a `Cargo.lock`, else `cargo fetch` |

</details>

<details>
<summary><b>Dart / Flutter</b> — <code>pubspec.yaml</code></summary>

`language` is `dart` for both; `package-manager` is `flutter` when the project depends on the Flutter SDK, constrains `environment.flutter` or has a `flutter:` section.

| What | Sources, in priority order |
| --- | --- |
| Version | `version` as written (`1.4.0+27` → `version-build` `27`) → release tooling |
| Lockfile | `pubspec.lock`, else the [pub workspace](https://dart.dev/tools/pub/workspaces) root's (members declare `resolution: workspace`) |
| Runtime version (Flutter) | the Flutter SDK version: FVM `.fvmrc` / `.fvm/fvm_config.json` up to the repository root → `environment.flutter` → `.tool-versions` → `mise.toml` |
| Runtime version (Dart) | `environment.sdk` → `.tool-versions` → `mise.toml` |
| Install command | `flutter pub get` / `dart pub get`, `--enforce-lockfile` with a lockfile |

`pubspec.yaml` is read with the YAML failsafe schema, so `version: 1.10` stays `1.10`.

</details>

<details>
<summary><b>Ruby</b> — <code>Gemfile</code>, <code>gems.rb</code> or a <code>*.gemspec</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Name | gemspec `spec.name` or `Gem::Specification.new "…"` (empty for apps) |
| Version | gemspec literal → `VERSION` in `lib/<name>/version.rb` → `VERSION` file → release tooling |
| Package manager | `bundler`, version from `BUNDLED WITH` |
| Runtime version | `.ruby-version` → Gemfile `ruby "…"` / `ruby file:` → `Gemfile.lock` `RUBY VERSION` → `.tool-versions` → `mise.toml` |
| Install command | `bundle install` (none for a gemspec without a Gemfile) |

</details>

<details>
<summary><b>PHP</b> — <code>composer.json</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Version | `version` → release tooling → git tag |
| Runtime version | `.php-version` → `composer.lock` `platform-overrides.php` → `config.platform.php` (setup-php's order) → `require.php` → `.tool-versions` → `mise.toml` |
| Install command | `composer install --no-interaction` |

</details>

<details>
<summary><b>.NET</b> — <code>*.sln</code> / <code>*.slnx</code>, else <code>*.csproj</code> / <code>*.fsproj</code> / <code>*.vbproj</code></summary>

| What | Sources, in priority order |
| --- | --- |
| Name | `PackageId` → `AssemblyName` → file name |
| Version | project `Version` / `VersionPrefix`[-`VersionSuffix`] → the same in the nearest `Directory.Build.props` and the local files it imports → Nerdbank.GitVersioning `version.json` → release tooling → git tag; conditional and computed (`$(…)`) values are skipped |
| Lockfile | `packages.lock.json` |
| Runtime version | `global.json` `sdk.version` up to the repository root → highest target framework (`net8.0` → `8.0`) → `.tool-versions` → `mise.toml` |
| Install command | `dotnet restore` (naming the file when there are several; `--locked-mode` with a lockfile) |

</details>

<details>
<summary><b>Java / JVM</b> — <code>pom.xml</code>, else <code>build.gradle(.kts)</code> / <code>settings.gradle(.kts)</code></summary>

`language` is `java` for every Maven or Gradle build, Kotlin and Android included; a directory with both is reported as Maven.

| What | Maven | Gradle |
| --- | --- | --- |
| Name | `artifactId` | `rootProject.name`, else the directory name |
| Version | `version` (`${revision}` resolved from properties and `.mvn/maven.config`) → in-repo parent's version → release tooling → git tag | `gradle.properties` `version` → `version = "…"` → Android `versionName+versionCode` → the build root's → release tooling → git tag |
| Tool version | `.mvn/wrapper/maven-wrapper.properties` | `gradle/wrapper/gradle-wrapper.properties` |
| `workspace-root` | top of the `<modules>` aggregator chain | the directory whose settings file `include`s the project |
| Runtime version | `.java-version` → `.sdkmanrc` → `maven.compiler.release` / `java.version` / `…target` / `…source` → `.tool-versions` → `mise.toml` | `.java-version` → `.sdkmanrc` → `JavaLanguageVersion.of(…)` / `jvmToolchain(…)` / `sourceCompatibility` → `.tool-versions` → `mise.toml` |
| Install command | `./mvnw -B dependency:go-offline` (or `mvn`) for single-module builds | none |

</details>
