/**
 * Action entry point. Kept separate from `main.ts` so `run()` can be imported by tests
 * without executing on import.
 */
import * as core from '@actions/core'
import { run } from './main.js'

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
