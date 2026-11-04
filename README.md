# Detect Project

GitHub Action that inspects a directory and reports **which language it is**, **what version the application is** and **which package manager it uses**. Supports **Node.js**, **Python** and **Go**.

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
| `language` | `auto` | Force a language (`node`, `python`, `go`) instead of auto-detecting. |
| `language-priority` | | Languages to prefer as primary when several are detected, comma separated (`python,node`). Unlisted languages follow in the default order. |
| `fail-on-unknown` | `false` | Fail the step when no supported project is found. |

### Outputs

| Output | Example | Description |
| --- | --- | --- |
| `language` | `node` | `node`, `python`, `go` or `unknown`. |
| `name` | `my-app` | `package.json` name, pyproject name or Go module path. |
| `version` | `1.4.2-rc.1` | Application version. Empty when it cannot be determined. |
| `version-source` | `package.json` | Where the version came from (`pyproject.toml:project.version`, `VERSION`, `internal/version/version.go`, `git-tag`, …). |
| `version-major` / `version-minor` / `version-patch` | `1` / `4` / `2` | Version components; minor and patch are `0` when absent (`1.4` → `1`/`4`/`0`). Empty without a version. |
| `version-prerelease` | `rc.1` | Pre-release part (`rc.1`, `beta2`, PEP 440 `dev3`); empty for final releases, including PEP 440 post-releases. |
| `version-build` | `45` | Build metadata after `+` (`1.2.3+45`, PEP 440 local version). |
| `is-prerelease` | `true` | `true` when `version-prerelease` is set, otherwise `false`. |
| `package-manager` | `pnpm` | See the table below. |
| `package-manager-version` | `9.12.0` | Only when declared somewhere (see below), otherwise empty. |
| `language-version` | `>=20` | Runtime version or constraint (`.nvmrc`, `requires-python`, `go` directive, …), passed through as written. |
| `language-version-source` | `package.json:engines.node` | Where `language-version` came from, relative to `working-directory` (`.nvmrc`, `../../.python-version`, `go.mod:go`, …). |
| `language-version-file` | `apps/api/.nvmrc` | The file `language-version` was read from, relative to the workspace root, **only** when the official setup action reads the same value from it (see [below](#passing-the-runtime-to-setup-actions)); otherwise empty. |
| `manifest` | `package.json` | Manifest the detection is based on, relative to `working-directory`. |
| `lockfile` | `../../pnpm-lock.yaml` | Lockfile relative to `working-directory` — for workspace members that is the workspace root's lockfile. Empty when there is none. |
| `workspace-root` | `.` | Where to install dependencies, relative to the workspace root: the monorepo root for workspace members, otherwise `working-directory` itself. |
| `install-command` | `pnpm install --frozen-lockfile` | Dependency install command for the detected package manager, meant to run in `workspace-root` (table below). Empty when there is no safe default. |
| `cache-dependency-path` | `pnpm-lock.yaml` | Dependency file for `cache-dependency-path` of the setup actions, relative to the workspace root: the lockfile, or for pip `requirements.txt` / the manifest. Empty when there is none. |
| `languages` | `[{…}, {…}]` | JSON array with the full result for **every** language found (same fields as the outputs, camelCase) — useful for mixed repos. |

Leading `v` is stripped from versions (`v1.2.3` → `1.2.3`); constraints such as `>=3.11` or `^9` are passed through unchanged.

## Detection rules

### Node.js — manifest: `package.json`

| What | Sources, in priority order |
| --- | --- |
| Version | `version` field |
| Package manager | `packageManager` field (corepack) → `devEngines.packageManager` → lockfile (`bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json`) → the same from the workspace root (`pnpm-workspace.yaml` alone means pnpm) → `volta`/`engines` entry → `npm` |
| Package manager version | `packageManager` field → `devEngines` → `volta.<pm>` → `.yarnrc.yml` `yarnPath` (Yarn Berry) → `engines.<pm>` (project first, then workspace root) |
| Runtime version | `.nvmrc` → `.node-version` → `volta.node` → `devEngines.runtime` → `engines.node` → `.tool-versions` → `mise.toml` |
| Install command | `npm ci` / `npm install`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (Berry) or `--frozen-lockfile` (Classic), `bun install --frozen-lockfile` — the frozen form only when the lockfile belongs to the detected package manager |

### Python — manifest: `pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile` or `requirements.txt` (first found)

| What | Sources, in priority order |
| --- | --- |
| Version | `[project] version` → `[tool.poetry] version` → dynamic version (`[tool.setuptools.dynamic]` `attr:`/`file:`, `[tool.hatch.version] path`, `[tool.pdm.version]`, flit module) → `setup.cfg` `[metadata] version` (incl. `attr:`/`file:`) → `setup.py` `version=` → `VERSION` file → `__version__` in the project's own package (see below) → latest git tag (only for SCM-versioned projects) |
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
| Version | `VERSION` file → `Version = "…"` / `Version string = "…"` constant in `version.go`, `internal/version/version.go`, `cmd/**/version.go`, … (placeholders like `"dev"` are ignored) → latest git tag |
| Package manager | `go` (modules), `dep` for `Gopkg.toml` |
| Package manager version | `toolchain` directive |
| Runtime version | `go` directive → `toolchain` → `.tool-versions` → `mise.toml` |
| Install command | `go mod download` (`dep ensure` for dep; none for a bare `go.work`) |

### Git tags

The git-tag fallback uses `git describe --tags --abbrev=0` restricted to release-shaped tags (`v1.2.3`, `1.2.3`, at least `MAJOR.MINOR`), so tags such as `nightly`, `latest` or a floating major tag (`v1`) are never reported as the version. A Go module in a subdirectory uses Go's tag convention — the module in `tools/` is versioned by `tools/v1.2.3` tags — and the prefix is stripped. With `actions/checkout` you need `fetch-depth: 0` (or `fetch-tags: true`) for it to see any tags.

### Monorepos and parent directories

When `working-directory` points into a repository, parent directories up to the repository root (or `GITHUB_WORKSPACE`, whichever is nearer) are consulted as well:

- **Workspace members** — a directory listed in a parent's `pnpm-workspace.yaml`, `package.json#workspaces` (npm, Yarn, Bun; globs and `!` negations) or `[tool.uv.workspace] members` (minus `exclude`) — inherit the workspace root's lockfile, `packageManager` / `devEngines` / `volta` / `engines` declarations and uv settings. `workspace-root` then points at that root and `install-command` is meant to run there. Declarations of the project itself always win over the root's.
- **Runtime version files** (`.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`, `mise.toml`) are looked up in parent directories the way nvm, pyenv, asdf and mise do — nearest first, after everything declared in the project directory.

A nested project that is *not* a workspace member keeps its own package manager and lockfile.

### Mixed repositories

If several languages are found in one directory, they are all reported in the `languages` output and the primary one is chosen in the order **node → python → go**, with a warning. Set `language-priority:` (e.g. `python,node` for a Django app with a Tailwind `package.json`) to change the order, `language:` to consider a single language only, or point `working-directory` at the sub-project.

## Passing the runtime to setup actions

`language-version` is passed through exactly as written, which is not always valid input for `node-version` / `python-version` — a PEP 440 constraint such as `>=3.10,<3.13` is not a SemVer range. Prefer the `*-version-file` inputs with `language-version-file`: the setup action then reads the file itself. The output is only set for files that the official actions read the same value from:

| Language | `language-version-file` is set for |
| --- | --- |
| Node.js (`node-version-file`) | `.nvmrc`, `.node-version`, `package.json` (`volta.node`, `devEngines.runtime`, `engines.node`), `.tool-versions`, `mise.toml` (`tools.node` as a string or `{ version }`) |
| Python (`python-version-file`) | `.python-version`, `pyproject.toml` (`requires-python`, or Poetry's `python` when there is no `[project]` table), `Pipfile`, `.tool-versions` |
| Go (`go-version-file`) | `go.mod` / `go.work` (setup-go prefers the `toolchain` directive), `.tool-versions` (`golang` entry) |

For sources such as `setup.cfg`, `runtime.txt` or a mise file for Python/Go it is empty, so fall back to `language-version` or a default.

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
    tags=(-t "my-app:$VERSION")
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
bun run local-action  # runs the action locally via @github/local-action using inputs from .env
```

`dist/` is committed (GitHub runs the action straight from it, no dependency install on the runner); CI fails if it is out of date, so run `bun run package` before committing source changes. To try the action locally, copy `.env.example` to `.env` and run `bun run local-action`.

Source layout:

```
src/
  index.ts             # runtime entry: calls run() and reports failures
  main.ts              # run(): inputs → detection → outputs + job summary
  detect.ts            # runs the detectors, picks the primary language
  detectors/
    node.ts python.ts go.ts
  utils/               # fs helpers, TOML/INI parsing, version normalisation, runtime files, workspace globs
__tests__/             # vitest suites (e2e.test.ts runs dist/) + fixtures used by the e2e tests and the CI `e2e` job
```

Adding a language means implementing the `Detector` interface from `src/types.ts` and registering it in `src/detectors/index.ts`.

## Releasing

1. Bump `version` in `package.json`, add an entry to [CHANGELOG.md](CHANGELOG.md), run `bun run all`, commit (including `dist/`).
2. Create a GitHub release with a `vMAJOR.MINOR.PATCH` tag (e.g. `v1.2.0`). Tick **Publish this Action to the GitHub Marketplace** on the release form if you want it listed.
3. The [Release workflow](.github/workflows/release.yml) verifies that `dist/` is fresh and force-moves the floating major tag (`v1`) to that release, so `uses: …@v1` users get the update.

Pre-releases (e.g. `v2.0.0-rc.1`) never move a major tag. Major tags are plain git tags without a GitHub release, which keeps them movable even with immutable releases enabled.
