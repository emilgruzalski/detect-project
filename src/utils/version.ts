import { exec } from '@actions/exec'

/** Normalises things like `v1.2.3`, `"1.2.3"`, `== 1.2.3` into `1.2.3`. Returns empty string for empty input. */
export function cleanVersion(raw: string | undefined | null): string {
  if (!raw) return ''
  let v = raw.trim()
  v = v.replace(/^["']|["']$/g, '').trim()
  v = v.replace(/^==\s*/, '')
  v = v.replace(/^v(?=\d)/i, '')
  return v
}

/**
 * Extracts `__version__ = "1.2.3"` / `Version = "1.2.3"` style assignments from source code.
 * Accepts type annotations in Python/TypeScript style (`__version__: str = …`, `version: string = …`)
 * and Go style (`var Version string = …`, `const Version string = …`).
 */
export function extractAssignedVersion(source: string, identifiers: readonly string[]): string | undefined {
  for (const id of identifiers) {
    const re = new RegExp(
      `(?:^|[\\s(,])${id}(?:\\s*:\\s*(?:str|string)|[ \\t]+string)?\\s*=\\s*["'\`]([^"'\`\\n]+)["'\`]`,
      'm',
    )
    const match = re.exec(source)
    if (match?.[1]) return cleanVersion(match[1])
  }
  return undefined
}

/**
 * True for values that look like a release version: at least `MAJOR.MINOR`, optionally followed by
 * a pre-release / build / PEP 440 suffix. Rejects tags such as `nightly`, `latest` or a floating `v1`.
 */
export function looksLikeReleaseVersion(value: string): boolean {
  return /^\d+(?:\.\d+)+(?:[-+._]?[0-9A-Za-z][0-9A-Za-z.+_-]*)?$/.test(value)
}

/** Escapes wildmatch metacharacters so a directory prefix is matched literally by `git describe --match`. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&')
}

/** The literal part of a glob before its first wildcard (`release-*` → `release-`, `api@v*` → `api@v`). */
export function staticGlobPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[\\]/)
  return wildcard < 0 ? pattern : pattern.slice(0, wildcard)
}

export interface TagOptions {
  /** Literal tag prefix of a nested module (Go convention: `sub/dir/` for the module in `sub/dir`). */
  prefix?: string | undefined
  /** Custom `--match` globs replacing the built-in ones; their literal prefix is stripped from the tag. */
  patterns?: readonly string[] | undefined
}

/**
 * Latest reachable release tag (via `git describe`), or undefined when the repository has no matching
 * tag or `cwd` is not inside a repository.
 *
 * By default only tags shaped like `vX.Y…` / `X.Y…` are considered, so `nightly` or a floating `v1` major
 * tag are never reported; `prefix` selects (and strips) the tags of a nested module. Custom `patterns`
 * (e.g. `release-*`, `api@*`) replace those defaults and the prefix; the literal part of the matching
 * pattern is stripped. Either way the result must look like a release version.
 */
export async function gitDescribeTag(cwd: string, options: TagOptions = {}): Promise<string | undefined> {
  const custom = (options.patterns ?? []).map((p) => p.trim()).filter(Boolean)
  const prefix = custom.length ? '' : (options.prefix ?? '')
  const escaped = escapeGlob(prefix)
  const patterns = custom.length ? custom : [`${escaped}v[0-9]*.[0-9]*`, `${escaped}[0-9]*.[0-9]*`]
  let out = ''
  try {
    const code = await exec('git', ['describe', '--tags', '--abbrev=0', ...patterns.flatMap((p) => ['--match', p])], {
      cwd,
      silent: true,
      ignoreReturnCode: true,
      listeners: { stdout: (d) => (out += d.toString()) },
    })
    if (code !== 0) return undefined
  } catch {
    return undefined
  }
  let tag = out.trim()
  if (!tag) return undefined
  const strip = custom.length
    ? custom
        .map(staticGlobPrefix)
        .filter((p) => tag.startsWith(p))
        .sort((a, b) => b.length - a.length)[0] ?? ''
    : prefix
  if (!tag.startsWith(strip)) return undefined
  tag = tag.slice(strip.length)
  const version = cleanVersion(tag)
  return looksLikeReleaseVersion(version) ? version : undefined
}

export interface VersionParts {
  major: string
  minor: string
  patch: string
  /** Pre-release identifier (`rc.1`, `beta2`, `dev3`), empty for final releases. */
  prerelease: string
  /** Build metadata after `+` (SemVer build / PEP 440 local version), e.g. `45` in `1.2.3+45`. */
  build: string
  isPrerelease: boolean
}

const NO_PARTS: VersionParts = { major: '', minor: '', patch: '', prerelease: '', build: '', isPrerelease: false }

/**
 * Splits a SemVer or PEP 440 version into its components. Missing minor/patch components are `0`
 * (`1.4` → 1/4/0); extra numeric components are ignored; a PEP 440 epoch (`1!`) is dropped.
 * PEP 440 post-releases (`1.0.post1`) count as final releases. Returns empty parts for values that do
 * not start with a number.
 */
export function splitVersion(version: string): VersionParts {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)*(.*)$/.exec(version.trim().replace(/^\d+!/, ''))
  if (!m) return { ...NO_PARTS }
  let rest = m[4] ?? ''
  let build = ''
  const plus = rest.indexOf('+')
  if (plus >= 0) {
    build = rest.slice(plus + 1)
    rest = rest.slice(0, plus)
  }
  let prerelease = rest.replace(/^[-._]/, '')
  if (/^(?:post|rev|r)\d*$/i.test(prerelease)) prerelease = ''
  return {
    major: m[1] ?? '',
    minor: m[2] ?? '0',
    patch: m[3] ?? '0',
    prerelease,
    build,
    isPrerelease: prerelease !== '',
  }
}
