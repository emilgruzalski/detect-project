import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** Creates a temporary project directory from a `{ 'relative/path': 'content' }` map. */
export async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-project-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }
  return dir
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}
