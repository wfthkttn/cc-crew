import type { ClaudeAgent } from './agents.ts'
import type { Io } from './io.ts'
import type { Gate } from './limits.ts'
import type { Raise } from './overview-props.ts'
import type { Tokens } from './usage.ts'

/** What crew keeps of one session beside its runs, so a reload or a resume keeps the log and the limits. */
export type SessionRecord = {
  /** The main loop's turns: what Claude itself spent while crew was loaded. */
  main: Tokens
  turns: number
  agents: ClaudeAgent[]
  /** Added to the settings' limits for this session from the Limits tab. */
  raises: Record<Raise, number>
  closed: Gate[]
}

export function emptyRecord(): SessionRecord {
  return { main: { in: 0, cached: 0, out: 0 }, turns: 0, agents: [], raises: { reviewRuns: 0, reviewTokens: 0, agentTokens: 0 }, closed: [] }
}

export const recordPath = (cacheDir: string, sessionId: string) => `${cacheDir}/sessions/${sessionId}.json`

/** The session's record, or an empty one for a session crew has not kept yet. */
export async function loadRecord(io: Io, path: string): Promise<SessionRecord> {
  if (!(await io.exists(path))) return emptyRecord()
  return { ...emptyRecord(), ...(JSON.parse(await io.read(path)) as Partial<SessionRecord>) }
}

export async function saveRecord(io: Io, path: string, record: SessionRecord): Promise<void> {
  await io.write(path, JSON.stringify(record, null, 2))
}
