import type { Detector, Language } from '../types.js'
import { dartDetector } from './dart.js'
import { dotnetDetector } from './dotnet.js'
import { goDetector } from './go.js'
import { javaDetector } from './java.js'
import { nodeDetector } from './node.js'
import { phpDetector } from './php.js'
import { pythonDetector } from './python.js'
import { rubyDetector } from './ruby.js'
import { rustDetector } from './rust.js'

/**
 * Detection order also defines which language wins when several are present in one directory.
 * New languages are appended so that the primary language of existing mixed projects never changes.
 */
export const detectors: readonly Detector[] = [
  nodeDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  dartDetector,
  rubyDetector,
  phpDetector,
  dotnetDetector,
  javaDetector,
]

export const languages: readonly Language[] = detectors.map((d) => d.language)

/** Human-readable names for messages and the job summary. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  node: 'Node.js',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  dart: 'Dart/Flutter',
  ruby: 'Ruby',
  php: 'PHP',
  dotnet: '.NET',
  java: 'Java/JVM',
}

/** "Node.js, Python, Go, Rust, Dart/Flutter, Ruby, PHP, .NET and Java/JVM" */
export function supportedLanguagesText(): string {
  const names = languages.map((l) => LANGUAGE_NAMES[l])
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export function isLanguage(value: string): value is Language {
  return (languages as readonly string[]).includes(value)
}
