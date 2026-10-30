import type { JobChoice } from './config.ts'
import type { Io } from './io.ts'

/** What crew keeps of one session beside its jobs: what the tab changed of each job for it. */
export type SessionRecord = { jobs: Record<string, JobChoice> }

export const emptyRecord = (): SessionRecord => ({ jobs: {} })

export const recordPath = (cacheDir: string, sessionId: string) => `${cacheDir}/sessions/${sessionId}.json`

/** The session's record, or an empty one for a session crew has not kept yet. */
export async function loadRecord(io: Io, path: string): Promise<SessionRecord> {
  if (!(await io.exists(path))) return emptyRecord()
  // a record from before cc-agents held the agents has more in it, which goes
  return { jobs: (JSON.parse(await io.read(path)) as Partial<SessionRecord>).jobs ?? {} }
}

export async function saveRecord(io: Io, path: string, record: SessionRecord): Promise<void> {
  await io.write(path, JSON.stringify(record, null, 2))
}
