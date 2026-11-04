/** Narrow accessors for parsed TOML / JSON / YAML documents whose shape is not trusted. */

export type Table = Record<string, unknown>

export function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Table) : undefined
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** `get(doc, 'a', 'b')` → `doc.a.b`, or undefined when any step is missing or not a table. */
export function get(root: unknown, ...keys: string[]): unknown {
  let current: unknown = root
  for (const key of keys) {
    current = table(current)?.[key]
    if (current === undefined) return undefined
  }
  return current
}
