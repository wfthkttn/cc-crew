import type {
  AgentInfo,
  AgentSpawnArgs,
  AgentSpawnResult,
  FsEntry,
  FsStat,
  FsStatOptions,
  HookStream,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  SessionSendArgs,
  SessionSendResult,
  Timer,
} from 'claude-code'

/** The engine calls the modules use, each spelled out on `$` in register.ts. */
export type Io = {
  stat: (path: string, options?: FsStatOptions) => Promise<FsStat>
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  sleep: (ms: number) => Promise<void>
  agents: () => Promise<AgentInfo[]>
  spawnAgent: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  send: (args: SessionSendArgs) => Promise<SessionSendResult>
  /** Posts to the person's crew thread on the messenger, with sound. */
  notify: (text: string) => Promise<void>
}
