import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dotnetDetector, dotnetVersionFromTargetFrameworks } from '../src/detectors/dotnet.js'
import { msbuildProperty, removeXmlBlocks, stripXmlComments, xmlList, xmlText } from '../src/utils/xml.js'
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

const csproj = (props: string) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
${props}
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="4.0.0" />
  </ItemGroup>
</Project>
`

describe('dotnetDetector', () => {
  it('returns undefined without a solution or project file', async () => {
    expect(await dotnetDetector.detect({ dir: await project({ 'Program.cs': '' }) })).toBeUndefined()
  })

  it('reads a project file', async () => {
    const dir = await project({
      'Api.csproj': csproj('    <TargetFramework>net8.0</TargetFramework>\n    <PackageId>Acme.Api</PackageId>\n    <VersionPrefix>2.1.0</VersionPrefix>\n    <VersionSuffix>beta.3</VersionSuffix>'),
      'packages.lock.json': '{"version": 1}',
    })
    expect(await dotnetDetector.detect({ dir })).toEqual({
      language: 'dotnet',
      name: 'Acme.Api',
      version: '2.1.0-beta.3',
      versionSource: 'Api.csproj:VersionPrefix',
      packageManager: 'dotnet',
      packageManagerVersion: '',
      languageVersion: '8.0',
      languageVersionSource: 'Api.csproj:TargetFramework',
      languageVersionFile: '',
      manifest: 'Api.csproj',
      lockfile: 'packages.lock.json',
      workspaceRoot: '.',
      installCommand: 'dotnet restore --locked-mode',
      cacheDependencyPath: 'packages.lock.json',
    })
  })

  it('skips conditional and computed properties', async () => {
    const dir = await project({
      'Lib.fsproj': csproj(
        '    <Version Condition="\'$(Configuration)\' == \'Release\'">9.9.9</Version>\n    <Version>$(BaseVersion)</Version>\n    <AssemblyName>Acme.Lib</AssemblyName>',
      ),
    })
    expect(await dotnetDetector.detect({ dir })).toMatchObject({ name: 'Acme.Lib', version: '' })
  })

  it('prefers a solution and names it after the file', async () => {
    const dir = await project({ 'Acme.sln': '', 'src/Acme.Api/Acme.Api.csproj': csproj('<Version>1.0.0</Version>') })
    expect(await dotnetDetector.detect({ dir })).toMatchObject({ name: 'Acme', manifest: 'Acme.sln', version: '', installCommand: 'dotnet restore' })
  })

  it('names the file to restore when the directory holds several', async () => {
    const dir = await project({ 'Acme.slnx': '<Solution />', 'Tools.csproj': csproj('') })
    expect((await dotnetDetector.detect({ dir }))?.installCommand).toBe('dotnet restore Acme.slnx')
    const spaced = await project({ 'My App.sln': '', 'Other.sln': '' })
    expect((await dotnetDetector.detect({ dir: spaced }))?.installCommand).toBe('')
  })

  it('reads the nearest Directory.Build.props and Nerdbank version.json', async () => {
    const root = await project({
      'Directory.Build.props': '<Project><PropertyGroup><Version>3.2.1</Version><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup></Project>',
      'src/Api/Api.csproj': csproj('<OutputType>Exe</OutputType>'),
    })
    expect(await dotnetDetector.detect({ dir: path.join(root, 'src/Api'), boundary: root })).toMatchObject({
      version: '3.2.1',
      versionSource: '../../Directory.Build.props:Version',
    })
    const nbgv = await project({ 'version.json': '{"version": "1.4-beta", "publicReleaseRefSpec": []}', 'A.csproj': csproj('') })
    expect(await dotnetDetector.detect({ dir: nbgv })).toMatchObject({ version: '1.4-beta', versionSource: 'version.json:version' })
  })

  it('takes the SDK from global.json, up to the repository root, before the target framework', async () => {
    const root = await project({
      'global.json': '{"sdk": {"version": "9.0.100", "rollForward": "latestFeature"}}',
      'src/Api/Api.csproj': csproj('<TargetFramework>net8.0</TargetFramework>'),
    })
    expect(await dotnetDetector.detect({ dir: path.join(root, 'src/Api'), boundary: root })).toMatchObject({
      languageVersion: '9.0.100',
      languageVersionSource: '../../global.json:sdk.version',
      languageVersionFile: '../../global.json',
    })
  })

  it('reads the target framework from Directory.Build.props and asdf', async () => {
    const props = await project({ 'Directory.Build.props': '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>', 'X.csproj': csproj('') })
    expect(await dotnetDetector.detect({ dir: props })).toMatchObject({ languageVersion: '9.0', languageVersionSource: 'Directory.Build.props:TargetFramework' })
    const asdf = await project({ 'X.csproj': csproj('<TargetFramework>netstandard2.0</TargetFramework>'), '.tool-versions': 'dotnet 8.0.404\n' })
    expect(await dotnetDetector.detect({ dir: asdf })).toMatchObject({ languageVersion: '8.0.404', languageVersionFile: '' })
  })
})

describe('dotnetVersionFromTargetFrameworks', () => {
  it.each([
    ['net8.0', '8.0'],
    ['net8.0-android', '8.0'],
    ['net6.0;net8.0;netstandard2.0', '8.0'],
    ['netcoreapp3.1', '3.1'],
    ['net10.0;net9.0', '10.0'],
    ['net48', undefined],
    ['netstandard2.1', undefined],
  ])('%s → %s', (tfm, expected) => {
    expect(dotnetVersionFromTargetFrameworks(tfm)).toBe(expected)
  })
})

describe('xml helpers', () => {
  it('strips comments and blocks, reads text, lists and MSBuild properties', () => {
    const xml = stripXmlComments('<a><!-- <version>0</version> --><b><version>1</version></b><version>2</version><m><i>x</i><i> y </i></m></a>')
    expect(xmlText(xml, 'version')).toBe('1')
    expect(xmlText(removeXmlBlocks(xml, ['b']), 'version')).toBe('2')
    expect(xmlList(xml, 'm', 'i')).toEqual(['x', 'y'])
    expect(removeXmlBlocks('<a><b/><b x="1"><b>nested</b></b>keep</a>', ['b'])).toBe('<a>keep</a>')
    expect(msbuildProperty('<V Condition="x">1</V><V>$(Y)</V><V> 3 </V>', 'V')).toBe('3')
  })
})
