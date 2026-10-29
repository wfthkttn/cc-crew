import type { FsEntry, ProcessRunInit, ProcessRunResult } from 'claude-code'

/** The engine calls the modules use, each spelled out on `$` in register.ts. */
export type Io = {
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  now: () => Promise<number>
}
