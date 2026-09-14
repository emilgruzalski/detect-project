import { detectors } from './detectors/index.js'
import type { Detection, Language } from './types.js'

export interface DetectResult {
  /** The language the outputs are based on, or undefined when nothing matched. */
  primary: Detection | undefined
  /** Every language detected in the directory, in detector order. */
  all: Detection[]
}

/**
 * Runs every detector against `dir`.
 *
 * When `language` is given only that detector is considered. Otherwise the first detector
 * (in registry order) that matches becomes the primary result and the rest are still reported in `all`.
 */
export async function detectProject(dir: string, language?: Language): Promise<DetectResult> {
  const selected = language ? detectors.filter((d) => d.language === language) : detectors
  const all: Detection[] = []
  for (const detector of selected) {
    const result = await detector.detect({ dir })
    if (result) all.push(result)
  }
  return { primary: all[0], all }
}
