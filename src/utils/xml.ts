/**
 * Just enough XML for MSBuild project files and Maven POMs: both keep the values we need in simple
 * `<Name>text</Name>` elements. Values that reference other properties (`$(...)`, `${...}`) are resolved
 * by the callers or ignored.
 */

export function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '')
}

/** Removes every `<name …>…</name>` block (and self-closing `<name/>`), e.g. `dependencies` or `build` in a POM. */
export function removeXmlBlocks(xml: string, names: readonly string[]): string {
  let result = xml
  for (const name of names) {
    result = result.replace(new RegExp(`<${name}(?:\\s[^>]*)?/>`, 'g'), '')
    // Innermost first so nested blocks of the same name (rare) are removed completely.
    const block = new RegExp(`<${name}(?:\\s[^>]*)?>(?:(?!<${name}[\\s>])[\\s\\S])*?</${name}\\s*>`, 'g')
    let previous: string
    do {
      previous = result
      result = result.replace(block, '')
    } while (result !== previous)
  }
  return result
}

/** Text of the first `<name>` element, or undefined. Attributes are allowed. */
export function xmlText(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}\\s*>`).exec(xml)
  return match?.[1]?.trim() || undefined
}

/**
 * MSBuild property value: the first `<name>` without a `Condition` attribute whose text does not refer
 * to other properties (`$(...)`), so per-configuration overrides and computed values are skipped.
 */
export function msbuildProperty(xml: string, name: string): string | undefined {
  for (const match of xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?>([^<]*)</${name}\\s*>`, 'g'))) {
    const attributes = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    if (/\bCondition\s*=/i.test(attributes) || !value || value.includes('$(')) continue
    return value
  }
  return undefined
}

/** Child element texts of `<container>`, e.g. the `<module>` entries of `<modules>`. */
export function xmlList(xml: string, container: string, item: string): string[] {
  const block = new RegExp(`<${container}(?:\\s[^>]*)?>([\\s\\S]*?)</${container}\\s*>`).exec(xml)?.[1] ?? ''
  return [...block.matchAll(new RegExp(`<${item}(?:\\s[^>]*)?>([^<]*)</${item}\\s*>`, 'g'))].map((m) => (m[1] ?? '').trim()).filter(Boolean)
}
