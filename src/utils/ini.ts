/** Minimal INI parser sufficient for `setup.cfg` (sections, `key = value`, `key: value`, indented continuations). */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  let section: Record<string, string> | undefined
  let lastKey: string | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(rawLine) || rawLine.trim() === '') continue
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine)
    if (sectionMatch?.[1]) {
      section = result[sectionMatch[1].trim()] ??= {}
      lastKey = undefined
      continue
    }
    if (!section) continue
    if (/^\s/.test(rawLine) && lastKey !== undefined) {
      // continuation line of a multi-line value
      section[lastKey] = `${section[lastKey] ?? ''}\n${rawLine.trim()}`.trim()
      continue
    }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(rawLine)
    if (kv?.[1] !== undefined) {
      lastKey = kv[1].trim()
      section[lastKey] = (kv[2] ?? '').trim()
    }
  }
  return result
}
