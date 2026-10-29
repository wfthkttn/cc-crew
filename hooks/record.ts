import type { ClaudeAgent } from './agents.ts'
import type { JobChoice } from './config.ts'
import type { Io } from './io.ts'
import type { Tokens } from './usage.ts'

/** What crew keeps of one session beside its jobs, so a reload or a resume keeps the log. */
export type SessionRecord = {
  /** The main loop's turns: what Claude itself spent while crew was loaded. */
  main: Tokens
  turns: number
  agents: ClaudeAgent[]
  /** What the tab changed of each job for this session. */
  jobs: Record<string, JobChoice>
}

export function emptyRecord(): SessionRecord {
  return { main: { in: 0, cached: 0, out: 0 }, turns: 0, agents: [], jobs: {} }
}

export const recordPath = (cacheDir: string, sessionId: string) => `${cacheDir}/sessions/${sessionId}.json`

/** The session's record, or an empty one for a session crew has not kept yet. */
export async function loadRecord(io: Io, path: string): Promise<SessionRecord> {
  if (!(await io.exists(path))) return emptyRecord()
  // a record kept while crew held the limits has raises and switches too, which cc-providers holds now
  const kept = JSON.parse(await io.read(path)) as Partial<SessionRecord>
  const empty = emptyRecord()
  return { main: kept.main ?? empty.main, turns: kept.turns ?? empty.turns, agents: kept.agents ?? empty.agents, jobs: kept.jobs ?? empty.jobs }
}

export async function saveRecord(io: Io, path: string, record: SessionRecord): Promise<void> {
  await io.write(path, JSON.stringify(record, null, 2))
}
