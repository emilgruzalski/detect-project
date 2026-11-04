import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dartDetector, isFlutter } from '../src/detectors/dart.js'
import { cleanup, makeProject } from './helpers.js'

const dirs: string[] = []
const project = async (files: Record<string, string>) => {
  const dir = await makeProject(files)
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

const flutterApp = `name: slupki
description: Boundary post finder
publish_to: none
version: 1.4.0+27

environment:
  sdk: ^3.5.0
  flutter: 3.24.3

dependencies:
  flutter:
    sdk: flutter
  geolocator: ^13.0.0

flutter:
  uses-material-design: true
`

describe('dartDetector', () => {
  it('returns undefined without pubspec.yaml', async () => {
    const dir = await project({ 'lib/main.dart': 'void main() {}' })
    expect(await dartDetector.detect({ dir })).toBeUndefined()
  })

  it('reads a pure Dart package', async () => {
    const dir = await project({ 'pubspec.yaml': 'name: http\nversion: 1.10.0\nenvironment:\n  sdk: ">=3.4.0 <4.0.0"\ndependencies:\n  meta: ^1.15.0\n' })
    expect(await dartDetector.detect({ dir })).toEqual({
      language: 'dart',
      name: 'http',
      version: '1.10.0',
      versionSource: 'pubspec.yaml',
      packageManager: 'dart',
      packageManagerVersion: '',
      languageVersion: '>=3.4.0 <4.0.0',
      languageVersionSource: 'pubspec.yaml:environment.sdk',
      // dart-lang/setup-dart has no version-file input.
      languageVersionFile: '',
      manifest: 'pubspec.yaml',
      lockfile: '',
      workspaceRoot: '.',
      installCommand: 'dart pub get',
      cacheDependencyPath: '',
    })
  })

  // A YAML core-schema parser would turn `version: 1.10` into the number 1.1.
  it.each([
    ['1.10', '1.10'],
    ['2.0', '2.0'],
    ['"3.1.0"', '3.1.0'],
    ['1.0.0-dev.1+5', '1.0.0-dev.1+5'],
  ])('keeps version %s as written', async (raw, version) => {
    const dir = await project({ 'pubspec.yaml': `name: x\nversion: ${raw}\n` })
    expect((await dartDetector.detect({ dir }))?.version).toBe(version)
  })

  it('reads a Flutter app with its build number and pinned Flutter version', async () => {
    const dir = await project({ 'pubspec.yaml': flutterApp, 'pubspec.lock': 'packages:\n' })
    expect(await dartDetector.detect({ dir })).toMatchObject({
      name: 'slupki',
      version: '1.4.0+27',
      packageManager: 'flutter',
      languageVersion: '3.24.3',
      languageVersionSource: 'pubspec.yaml:environment.flutter',
      languageVersionFile: 'pubspec.yaml',
      lockfile: 'pubspec.lock',
      installCommand: 'flutter pub get --enforce-lockfile',
      cacheDependencyPath: 'pubspec.lock',
    })
  })

  it('survives malformed YAML', async () => {
    const dir = await project({ 'pubspec.yaml': 'name: [broken\n' })
    expect(await dartDetector.detect({ dir })).toMatchObject({ language: 'dart', name: '', packageManager: 'dart' })
  })

  it('falls back to release tooling when the pubspec has no version (apps)', async () => {
    const dir = await project({ 'pubspec.yaml': 'name: app\npublish_to: none\n', '.release-please-manifest.json': '{".": "0.8.0"}' })
    expect(await dartDetector.detect({ dir })).toMatchObject({ version: '0.8.0', versionSource: '.release-please-manifest.json:.' })
  })
})

describe('isFlutter', () => {
  it.each([
    [{ dependencies: { flutter: { sdk: 'flutter' } } }, true],
    [{ environment: { sdk: '^3.0.0', flutter: '>=3.19.0' } }, true],
    [{ flutter: '' }, true],
    [{ dependencies: { http: '^1.0.0' }, environment: { sdk: '^3.0.0' } }, false],
    [{ dependencies: { flutter_lints: '^4.0.0' } }, false],
  ])('%j → %s', (pubspec, expected) => {
    expect(isFlutter(pubspec)).toBe(expected)
  })
})

describe('dartDetector: Flutter SDK version', () => {
  const pubspec = 'name: app\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  flutter:\n    sdk: flutter\n'

  it.each([
    [{ '.fvmrc': '{"flutter": "3.27.1", "flavors": {}}' }, '3.27.1', '.fvmrc:flutter', '.fvmrc'],
    [{ '.fvm/fvm_config.json': '{"flutterSdkVersion": "3.22.0"}' }, '3.22.0', '.fvm/fvm_config.json:flutterSdkVersion', '.fvm/fvm_config.json'],
    [{ '.tool-versions': 'flutter 3.24.5-stable\n' }, '3.24.5-stable', '.tool-versions', ''],
    [{ 'mise.toml': '[tools]\nflutter = "3.24.5"\n' }, '3.24.5', 'mise.toml:tools.flutter', ''],
  ])('%j', async (files, version, source, file) => {
    const dir = await project({ 'pubspec.yaml': pubspec, ...files })
    expect(await dartDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: source, languageVersionFile: file })
  })

  it('prefers the FVM pin over the pubspec constraint', async () => {
    const dir = await project({ 'pubspec.yaml': flutterApp, '.fvmrc': '{"flutter": "3.27.1"}' })
    expect((await dartDetector.detect({ dir }))?.languageVersionSource).toBe('.fvmrc:flutter')
  })

  // subosito/flutter-action needs an exact version in environment.flutter.
  it('offers pubspec.yaml as version file only for an exact Flutter version', async () => {
    const dir = await project({ 'pubspec.yaml': `${pubspec.replace('sdk: ^3.5.0', 'sdk: ^3.5.0\n  flutter: ">=3.19.0"')}` })
    expect(await dartDetector.detect({ dir })).toMatchObject({ languageVersion: '>=3.19.0', languageVersionFile: '' })
  })

  it('reports no runtime rather than the Dart constraint when no Flutter version is declared', async () => {
    const dir = await project({ 'pubspec.yaml': pubspec })
    expect(await dartDetector.detect({ dir })).toMatchObject({ packageManager: 'flutter', languageVersion: '', languageVersionSource: '' })
  })

  it('finds an FVM pin in a parent directory (monorepo)', async () => {
    const root = await project({ '.fvmrc': '{"flutter": "3.27.1"}', 'apps/mobile/pubspec.yaml': pubspec })
    expect(await dartDetector.detect({ dir: path.join(root, 'apps/mobile'), boundary: root })).toMatchObject({
      languageVersion: '3.27.1',
      languageVersionSource: '../../.fvmrc:flutter',
      languageVersionFile: '../../.fvmrc',
    })
  })

  // Found by the corpus test (localsend): app/pubspec.yaml says flutter: ^3.41.0, the repository's .fvmrc pins 3.41.9.
  it('prefers a parent directory FVM pin over the package constraint', async () => {
    const root = await project({
      '.fvmrc': '{"flutter": "3.41.9"}',
      'app/pubspec.yaml': 'name: app\nenvironment:\n  sdk: ^3.5.0\n  flutter: ^3.41.0\ndependencies:\n  flutter:\n    sdk: flutter\n',
    })
    expect(await dartDetector.detect({ dir: path.join(root, 'app'), boundary: root })).toMatchObject({
      languageVersion: '3.41.9',
      languageVersionSource: '../.fvmrc:flutter',
      languageVersionFile: '../.fvmrc',
    })
  })

  it('prefers the pubspec constraint over asdf / mise', async () => {
    const dir = await project({ 'pubspec.yaml': flutterApp, '.tool-versions': 'flutter 3.10.0\n' })
    expect((await dartDetector.detect({ dir }))?.languageVersionSource).toBe('pubspec.yaml:environment.flutter')
  })

  it('ignores an empty or malformed FVM config', async () => {
    const dir = await project({ 'pubspec.yaml': flutterApp, '.fvmrc': '{not json' })
    expect((await dartDetector.detect({ dir }))?.languageVersionSource).toBe('pubspec.yaml:environment.flutter')
  })
})

describe('dartDetector: pub workspaces', () => {
  const workspace = {
    'pubspec.yaml': 'name: _\npublish_to: none\nenvironment:\n  sdk: ^3.6.0\nworkspace:\n  - pkgs/http\n  - pkgs/cupertino_http\n',
    'pubspec.lock': 'packages:\n',
    'pkgs/http/pubspec.yaml': 'name: http\nversion: 1.3.0\nresolution: workspace\n',
    'pkgs/cupertino_http/pubspec.yaml': 'name: cupertino_http\nversion: 2.0.0\nresolution: workspace\ndependencies:\n  flutter:\n    sdk: flutter\n',
    'pkgs/standalone/pubspec.yaml': 'name: standalone\nversion: 0.1.0\nenvironment:\n  sdk: ^3.3.0\n',
  }

  it('uses the root lockfile and runtime for a workspace member', async () => {
    const root = await project(workspace)
    expect(await dartDetector.detect({ dir: path.join(root, 'pkgs/http'), boundary: root })).toMatchObject({
      name: 'http',
      version: '1.3.0',
      packageManager: 'dart',
      lockfile: '../../pubspec.lock',
      workspaceRoot: '../..',
      installCommand: 'dart pub get --enforce-lockfile',
      languageVersion: '^3.6.0',
      languageVersionSource: '../../pubspec.yaml:environment.sdk',
    })
  })

  it('installs a Flutter member with flutter pub get from the root', async () => {
    const root = await project(workspace)
    expect(await dartDetector.detect({ dir: path.join(root, 'pkgs/cupertino_http'), boundary: root })).toMatchObject({
      packageManager: 'flutter',
      workspaceRoot: '../..',
      installCommand: 'flutter pub get --enforce-lockfile',
    })
  })

  it('treats a package without resolution: workspace as standalone', async () => {
    const root = await project(workspace)
    expect(await dartDetector.detect({ dir: path.join(root, 'pkgs/standalone'), boundary: root })).toMatchObject({
      lockfile: '',
      workspaceRoot: '.',
      installCommand: 'dart pub get',
      languageVersion: '^3.3.0',
    })
  })

  it('does not join a workspace that does not list the package', async () => {
    const root = await project({ ...workspace, 'pkgs/other/pubspec.yaml': 'name: other\nresolution: workspace\n' })
    expect(await dartDetector.detect({ dir: path.join(root, 'pkgs/other'), boundary: root })).toMatchObject({ workspaceRoot: '.', lockfile: '' })
  })
})
