import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { interpolate, javaDetector, normalizeJavaVersion, parseGradleIncludes } from '../src/detectors/java.js'
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

const pom = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
${body}
</project>
`

const springParent = `  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.1</version>
    <relativePath/>
  </parent>`

const dependencies = `  <dependencies>
    <dependency>
      <groupId>org.junit</groupId>
      <artifactId>junit-bom</artifactId>
      <version>5.11.0</version>
    </dependency>
  </dependencies>
  <build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin></plugins></build>`

const wrapper = 'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip\n'

describe('javaDetector: Maven', () => {
  it('returns undefined without pom.xml or a Gradle build', async () => {
    expect(await javaDetector.detect({ dir: await project({ 'src/Main.java': '' }) })).toBeUndefined()
  })

  it('reads a single-module project and ignores versions of the parent, dependencies and plugins', async () => {
    const dir = await project({
      'pom.xml': pom(`${springParent}
  <groupId>com.acme</groupId>
  <artifactId>billing</artifactId>
  <version>1.7.0-SNAPSHOT</version>
  <properties>
    <java.version>21</java.version>
  </properties>
${dependencies}`),
      'mvnw': '#!/bin/sh\n',
      '.mvn/wrapper/maven-wrapper.properties': wrapper,
    })
    expect(await javaDetector.detect({ dir })).toEqual({
      language: 'java',
      name: 'billing',
      version: '1.7.0-SNAPSHOT',
      versionSource: 'pom.xml:version',
      packageManager: 'maven',
      packageManagerVersion: '3.9.9',
      languageVersion: '21',
      languageVersionSource: 'pom.xml:properties.java.version',
      languageVersionFile: '',
      manifest: 'pom.xml',
      lockfile: '',
      workspaceRoot: '.',
      installCommand: './mvnw -B dependency:go-offline',
      cacheDependencyPath: '',
    })
  })

  it('does not inherit the version of an external parent', async () => {
    const dir = await project({ 'pom.xml': pom(`${springParent}\n  <artifactId>app</artifactId>`) })
    expect(await javaDetector.detect({ dir })).toMatchObject({ name: 'app', version: '', installCommand: 'mvn -B dependency:go-offline' })
  })

  it('resolves CI-friendly ${revision} versions from properties and .mvn/maven.config', async () => {
    const props = await project({ 'pom.xml': pom('  <artifactId>a</artifactId>\n  <version>${revision}</version>\n  <properties><revision>2.0.0</revision></properties>') })
    expect((await javaDetector.detect({ dir: props }))?.version).toBe('2.0.0')
    const config = await project({
      'pom.xml': pom('  <artifactId>a</artifactId>\n  <version>${revision}${changelist}</version>\n  <properties><revision>2.0.0</revision><changelist>-SNAPSHOT</changelist></properties>'),
      '.mvn/maven.config': '-Drevision=2.1.0 -Dchangelist=\n',
    })
    expect((await javaDetector.detect({ dir: config }))?.version).toBe('2.1.0')
    const unresolved = await project({ 'pom.xml': pom('  <artifactId>a</artifactId>\n  <version>${revision}</version>') })
    expect((await javaDetector.detect({ dir: unresolved }))?.version).toBe('')
  })

  it.each([
    ['<maven.compiler.release>17</maven.compiler.release><java.version>21</java.version>', '17', 'properties.maven.compiler.release'],
    ['<maven.compiler.source>1.8</maven.compiler.source>', '8', 'properties.maven.compiler.source'],
    ['<jdk>21</jdk><maven.compiler.release>${jdk}</maven.compiler.release>', '21', 'properties.maven.compiler.release'],
  ])('runtime from %s', async (properties, version, field) => {
    const dir = await project({ 'pom.xml': pom(`  <artifactId>a</artifactId>\n  <properties>${properties}</properties>`) })
    expect(await javaDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: `pom.xml:${field}` })
  })

  const multiModule = {
    'pom.xml': pom(`  <groupId>com.acme</groupId>
  <artifactId>platform</artifactId>
  <version>4.2.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>core</module>
    <module>services/api</module>
  </modules>
  <properties><maven.compiler.release>21</maven.compiler.release></properties>`),
    'mvnw': '',
    '.mvn/wrapper/maven-wrapper.properties': wrapper,
    'core/pom.xml': pom(`  <parent><groupId>com.acme</groupId><artifactId>platform</artifactId><version>4.2.0</version></parent>
  <artifactId>core</artifactId>`),
    'services/api/pom.xml': pom(`  <parent><groupId>com.acme</groupId><artifactId>platform</artifactId><version>4.2.0</version><relativePath>../../pom.xml</relativePath></parent>
  <artifactId>api</artifactId>
  <version>4.3.0-SNAPSHOT</version>`),
  }

  it('resolves a module of a multi-module build', async () => {
    const root = await project(multiModule)
    expect(await javaDetector.detect({ dir: path.join(root, 'core'), boundary: root })).toMatchObject({
      name: 'core',
      version: '4.2.0',
      versionSource: 'pom.xml:parent.version',
      packageManagerVersion: '3.9.9',
      languageVersion: '21',
      languageVersionSource: '../pom.xml:properties.maven.compiler.release',
      workspaceRoot: '..',
      // dependency:go-offline cannot resolve unbuilt sibling modules.
      installCommand: '',
    })
    expect(await javaDetector.detect({ dir: path.join(root, 'services/api'), boundary: root })).toMatchObject({
      name: 'api',
      version: '4.3.0-SNAPSHOT',
      workspaceRoot: '../..',
    })
    expect(await javaDetector.detect({ dir: root, boundary: root })).toMatchObject({ name: 'platform', version: '4.2.0', installCommand: '' })
  })

  // .java-version and .sdkmanrc are pins and beat the build file; asdf/mise come after it (as for every language).
  it.each([
    [{ '.java-version': '17\n' }, '17', '.java-version', '.java-version'],
    [{ '.java-version': '1.8\n' }, '8', '.java-version', '.java-version'],
    [{ '.sdkmanrc': '# sdk env\njava=21.0.5-tem\nmaven=3.9.9\n' }, '21.0.5', '.sdkmanrc:java', '.sdkmanrc'],
    [{ '.tool-versions': 'java temurin-21.0.2+13.0.LTS\n' }, '11', 'pom.xml:properties.java.version', ''],
  ])('version files over pom.xml properties: %j', async (files, version, source, file) => {
    const dir = await project({ 'pom.xml': pom('  <artifactId>a</artifactId>\n  <properties><java.version>11</java.version></properties>'), ...files })
    expect(await javaDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: source, languageVersionFile: file })
  })

  it.each([
    [{ '.tool-versions': 'java temurin-21.0.2+13.0.LTS\n' }, '21.0.2+13.0.LTS', '.tool-versions', '.tool-versions'],
    [{ '.tool-versions': 'java openjdk-21\n' }, '21', '.tool-versions', '.tool-versions'],
    // setup-java does not read mise files.
    [{ 'mise.toml': '[tools]\njava = "21"\n' }, '21', 'mise.toml:tools.java', ''],
  ])('asdf / mise when the build declares nothing: %j', async (files, version, source, file) => {
    const dir = await project({ 'pom.xml': pom('  <artifactId>a</artifactId>'), ...files })
    expect(await javaDetector.detect({ dir })).toMatchObject({ languageVersion: version, languageVersionSource: source, languageVersionFile: file })
  })

  it('reports Maven when both pom.xml and a Gradle build exist', async () => {
    const dir = await project({ 'pom.xml': pom('  <artifactId>petclinic</artifactId>'), 'build.gradle': '' })
    expect((await javaDetector.detect({ dir }))?.packageManager).toBe('maven')
  })
})

describe('javaDetector: Gradle', () => {
  const gradleWrapper = 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip\n'

  it('reads a Kotlin DSL project', async () => {
    const dir = await project({
      'settings.gradle.kts': 'rootProject.name = "orders"\n',
      'build.gradle.kts': 'plugins {\n  id("org.springframework.boot") version "3.4.1"\n  kotlin("jvm") version "2.1.0"\n}\n\nversion = "0.5.0"\n\njava {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(21)\n  }\n}\n',
      'gradle/wrapper/gradle-wrapper.properties': gradleWrapper,
      'gradle.lockfile': '',
    })
    expect(await javaDetector.detect({ dir })).toEqual({
      language: 'java',
      name: 'orders',
      version: '0.5.0',
      versionSource: 'build.gradle.kts:version',
      packageManager: 'gradle',
      packageManagerVersion: '8.11.1',
      languageVersion: '21',
      languageVersionSource: 'build.gradle.kts:toolchain',
      languageVersionFile: '',
      manifest: 'build.gradle.kts',
      lockfile: 'gradle.lockfile',
      workspaceRoot: '.',
      installCommand: '',
      cacheDependencyPath: '',
    })
  })

  it.each([
    ["version '1.2.0'\nsourceCompatibility = JavaVersion.VERSION_17\n", '1.2.0', 'build.gradle:version', '17', 'build.gradle:sourceCompatibility'],
    ["sourceCompatibility = '11'\n", '', '', '11', 'build.gradle:sourceCompatibility'],
    ['kotlin {\n  jvmToolchain(17)\n}\n', '', '', '17', 'build.gradle:jvmToolchain'],
    ['sourceCompatibility = JavaVersion.VERSION_1_8\n', '', '', '8', 'build.gradle:sourceCompatibility'],
  ])('Groovy build %j', async (build, version, versionSource, java, javaSource) => {
    const dir = await project({ 'build.gradle': build })
    expect(await javaDetector.detect({ dir })).toMatchObject({ version, versionSource, languageVersion: java, languageVersionSource: javaSource })
  })

  it('prefers gradle.properties and reads an Android versionName + versionCode', async () => {
    const props = await project({ 'build.gradle.kts': 'version = "1.0.0"\n', 'gradle.properties': 'org.gradle.jvmargs=-Xmx2g\nversion=1.1.0\n' })
    expect(await javaDetector.detect({ dir: props })).toMatchObject({ version: '1.1.0', versionSource: 'gradle.properties:version' })
    const android = await project({
      'app/build.gradle.kts': 'android {\n  defaultConfig {\n    applicationId = "pl.example.app"\n    versionCode = 27\n    versionName = "1.4.0"\n  }\n}\n',
    })
    expect(await javaDetector.detect({ dir: path.join(android, 'app') })).toMatchObject({ version: '1.4.0+27', versionSource: 'build.gradle.kts:versionName' })
  })

  const multiProject = {
    'settings.gradle.kts': 'rootProject.name = "shop"\ninclude(":app", ":core:data")\ninclude(\n  ":feature:cart",\n)\nincludeBuild("build-logic")\n',
    'build.gradle.kts': 'allprojects {\n  version = "3.0.0"\n}\njava { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }\n',
    'gradle.properties': 'kotlin.code.style=official\n',
    'gradle/wrapper/gradle-wrapper.properties': gradleWrapper,
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
    'core/data/build.gradle.kts': '',
    'feature/cart/build.gradle': '',
    'build-logic/build.gradle.kts': '',
  }

  it('resolves a subproject against its settings file', async () => {
    const root = await project(multiProject)
    expect(await javaDetector.detect({ dir: path.join(root, 'core/data'), boundary: root })).toMatchObject({
      name: 'data',
      version: '3.0.0',
      versionSource: '../../build.gradle.kts:version',
      packageManagerVersion: '8.11.1',
      languageVersion: '17',
      languageVersionSource: '../../build.gradle.kts:toolchain',
      workspaceRoot: '../..',
    })
    expect((await javaDetector.detect({ dir: path.join(root, 'feature/cart'), boundary: root }))?.workspaceRoot).toBe('../..')
    expect(await javaDetector.detect({ dir: root, boundary: root })).toMatchObject({ name: 'shop', version: '3.0.0', workspaceRoot: '.' })
  })

  it('treats an included build as its own root', async () => {
    const root = await project(multiProject)
    expect(await javaDetector.detect({ dir: path.join(root, 'build-logic'), boundary: root })).toMatchObject({ name: 'build-logic', workspaceRoot: '.', version: '' })
  })

  it('detects a settings-only root', async () => {
    const dir = await project({ 'settings.gradle': "rootProject.name = 'umbrella'\ninclude 'a', 'b'\n" })
    expect(await javaDetector.detect({ dir })).toMatchObject({ name: 'umbrella', manifest: 'settings.gradle', packageManager: 'gradle' })
  })
})

describe('helpers', () => {
  it('parseGradleIncludes', () => {
    expect(parseGradleIncludes('include(":app", ":core:data")\n// include(":old")\ninclude \':lib\', "tools"\nincludeBuild("x")\n/* include(":gone") */')).toEqual([
      'app',
      'core/data',
      'lib',
      'tools',
    ])
  })

  it('interpolate', () => {
    expect(interpolate('${a}.${b}', { a: '1', b: '2' })).toBe('1.2')
    expect(interpolate('${a}', { a: '${b}', b: '3' })).toBe('3')
    expect(interpolate('${missing}', {})).toBeUndefined()
    expect(interpolate('${loop}', { loop: '${loop}' })).toBeUndefined()
  })

  it('normalizeJavaVersion', () => {
    expect(normalizeJavaVersion('1.8')).toBe('8')
    expect(normalizeJavaVersion('17')).toBe('17')
    expect(normalizeJavaVersion('21.0.2')).toBe('21.0.2')
  })
})
