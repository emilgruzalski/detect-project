import type { Detector, Language } from '../types.js'
import { goDetector } from './go.js'
import { nodeDetector } from './node.js'
import { pythonDetector } from './python.js'

/** Detection order also defines which language wins when several are present in one directory. */
export const detectors: readonly Detector[] = [nodeDetector, pythonDetector, goDetector]

export const languages: readonly Language[] = detectors.map((d) => d.language)

export function isLanguage(value: string): value is Language {
  return (languages as readonly string[]).includes(value)
}
