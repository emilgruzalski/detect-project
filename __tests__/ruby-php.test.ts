import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { phpDetector } from '../src/detectors/php.js'
import { rubyDetector } from '../src/detectors/ruby.js'
import { cleanup, git, makeGitRepo, makeProject } from './helpers.js'

const dirs: string[] = []
const project = async (files: Record<string, string>) => {
  const dir = await makeProject(files)
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

const gemfileLock = `GEM
  remote: https://rubygems.org/
  specs:
    rack (3.1.8)

PLATFORMS
  ruby

DEPENDENCIES
  rack

RUBY VERSION
   ruby 3.3.5p100

BUNDLED WITH
   2.5.22
`

describe('rubyDetector', () => {
  it('returns undefined without Gemfile or gemspec', async () => {
    expect(await rubyDetector.detect({ dir: await project({ 'Rakefile': '' }) })).toBeUndefined()
  })

  it('reads a gem: name from the gemspec, version from lib/<name>/version.rb', async () => {
    const dir = await project({
      Gemfile: 'source "https://rubygems.org"\ngemspec\n',
      'Gemfile.lock': gemfileLock,
      'my-gem.gemspec': 'Gem::Specification.new do |spec|\n  spec.name = "my-gem"\n  spec.version = MyGem::VERSION\nend\n',
      'lib/my/gem/version.rb': 'module MyGem\n  VERSION = "2.4.1".freeze\nend\n',
      '.ruby-version': '3.3.5\n',
    })
    expect(await rubyDetector.detect({ dir })).toEqual({
      language: 'ruby',
      name: 'my-gem',
      version: '2.4.1',
      versionSource: 'lib/my/gem/version.rb',
      packageManager: 'bundler',
      packageManagerVersion: '2.5.22',
      languageVersion: '3.3.5',
      languageVersionSource: '.ruby-version',
      languageVersionFile: '.ruby-version',
      manifest: 'Gemfile',
      lockfile: 'Gemfile.lock',
      workspaceRoot: '.',
      installCommand: 'bundle install',
      cacheDependencyPath: 'Gemfile.lock',
    })
  })

  it('reads a literal gemspec version and a single lib/*/version.rb without a name match', async () => {
    const literal = await project({ 'x.gemspec': 'Gem::Specification.new { |s| s.name = "x"; s.version = "0.9.0" }\n' })
    expect(await rubyDetector.detect({ dir: literal })).toMatchObject({ version: '0.9.0', versionSource: 'x.gemspec:version', manifest: 'x.gemspec', installCommand: '' })
    const single = await project({ Gemfile: '', 'lib/tool/version.rb': "module Tool\n  VERSION = '1.1.0'\nend\n" })
    expect((await rubyDetector.detect({ dir: single }))?.version).toBe('1.1.0')
  })

  it('treats a Rails app without a version as versionless', async () => {
    const dir = await project({ Gemfile: 'source "https://rubygems.org"\nruby "3.3.5"\ngem "rails", "~> 8.0"\n', 'Gemfile.lock': gemfileLock, 'config/application.rb': '' })
    expect(await rubyDetector.detect({ dir })).toMatchObject({
      name: '',
      version: '',
      languageVersion: '3.3.5',
      languageVersionSource: 'Gemfile:ruby',
      languageVersionFile: '',
    })
  })

  it.each([
    [{ Gemfile: 'ruby file: ".ruby-version"\n', '.ruby-version': 'ruby-3.2.4\n' }, 'ruby-3.2.4', '.ruby-version', '.ruby-version'],
    [{ Gemfile: 'gem "rack"\n', 'Gemfile.lock': gemfileLock }, '3.3.5', 'Gemfile.lock:RUBY VERSION', ''],
    [{ Gemfile: '', '.tool-versions': 'ruby 3.4.1\n' }, '3.4.1', '.tool-versions', '.tool-versions'],
    [{ Gemfile: '', 'mise.toml': '[tools]\nruby = "3.4.1"\n' }, '3.4.1', 'mise.toml:tools.ruby', 'mise.toml'],
  ])('runtime %j', async (files, version, source, file) => {
    const dir = await project(files)
    expect(await rubyDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: source, languageVersionFile: file })
  })

  it('finds .ruby-version in a parent directory', async () => {
    const root = await project({ '.ruby-version': '3.3.0\n', 'services/api/Gemfile': '' })
    expect((await rubyDetector.detect({ dir: path.join(root, 'services/api'), boundary: root }))?.languageVersionSource).toBe('../../.ruby-version')
  })

  it('supports gems.rb / gems.locked', async () => {
    const dir = await project({ 'gems.rb': '', 'gems.locked': gemfileLock })
    expect(await rubyDetector.detect({ dir })).toMatchObject({ manifest: 'gems.rb', lockfile: 'gems.locked', packageManagerVersion: '2.5.22' })
  })
})

describe('phpDetector', () => {
  it('returns undefined without composer.json', async () => {
    expect(await phpDetector.detect({ dir: await project({ 'index.php': '' }) })).toBeUndefined()
  })

  it('reads composer.json and composer.lock', async () => {
    const dir = await project({
      'composer.json': JSON.stringify({ name: 'acme/app', require: { php: '^8.2', 'laravel/framework': '^11.0' } }),
      'composer.lock': '{"packages": []}',
    })
    expect(await phpDetector.detect({ dir })).toEqual({
      language: 'php',
      name: 'acme/app',
      version: '',
      versionSource: '',
      packageManager: 'composer',
      packageManagerVersion: '',
      languageVersion: '^8.2',
      languageVersionSource: 'composer.json:require.php',
      languageVersionFile: '',
      manifest: 'composer.json',
      lockfile: 'composer.lock',
      workspaceRoot: '.',
      installCommand: 'composer install --no-interaction',
      cacheDependencyPath: 'composer.lock',
    })
  })

  it.each([
    [{ '.php-version': '8.3\n' }, '8.3', '.php-version', '.php-version'],
    [{ 'composer.lock': '{"platform-overrides": {"php": "8.2.12"}}' }, '8.2.12', 'composer.lock:platform-overrides.php', ''],
    [{ '.tool-versions': 'php 8.4.1\n' }, '^8.1', 'composer.json:require.php', ''],
  ])('runtime %j', async (files, version, source, file) => {
    const dir = await project({ 'composer.json': JSON.stringify({ require: { php: '^8.1' } }), ...files })
    expect(await phpDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: source, languageVersionFile: file })
  })

  // Same order as setup-php: config.platform.php is the exact platform, require.php only a constraint.
  it('prefers config.platform.php over require.php, and .tool-versions only without both', async () => {
    const platform = await project({ 'composer.json': JSON.stringify({ require: { php: '^8.1' }, config: { platform: { php: '8.1.27' } } }) })
    expect((await phpDetector.detect({ dir: platform }))?.languageVersionSource).toBe('composer.json:config.platform.php')
    const asdf = await project({ 'composer.json': '{}', '.tool-versions': 'php 8.4.1\n' })
    expect(await phpDetector.detect({ dir: asdf })).toMatchObject({ languageVersion: '8.4.1', languageVersionFile: '.tool-versions' })
  })

  it('reads an explicit version and otherwise the latest release tag', async () => {
    const explicit = await project({ 'composer.json': '{"name":"a/b","version":"1.4.0"}' })
    expect(await phpDetector.detect({ dir: explicit })).toMatchObject({ version: '1.4.0', versionSource: 'composer.json:version' })
    const repo = await makeGitRepo({ 'composer.json': '{"name":"a/b"}' })
    dirs.push(repo)
    git(repo, 'tag', 'v2.3.0')
    expect(await phpDetector.detect({ dir: repo })).toMatchObject({ version: '2.3.0', versionSource: 'git-tag' })
  })

  it('survives a malformed composer.json', async () => {
    expect(await phpDetector.detect({ dir: await project({ 'composer.json': '{oops' }) })).toMatchObject({ language: 'php', name: '' })
  })
})
