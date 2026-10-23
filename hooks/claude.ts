import type { Io } from './io.ts'

import { profile } from './codex.ts'
import type { FollowUp, Job, Outcome } from './job.ts'
import { parseFindings } from './prompt.ts'
import { SECRET_NAME, isInside } from './scope.ts'

export const AGENT = 'reviewer'
export const AGENT_WEB = 'reviewer-web'

export function agentSpecs(system: string) {
  const base = {
    prompt: system,
    omitClaudeMd: true as const,
    maxTurns: 80,
  }
  return [
    { ...base, name: AGENT, description: 'Read-only reviewer run by the crew review tool', tools: ['Read', 'Bash'] },
    {
      ...base,
      name: AGENT_WEB,
      description: 'Read-only reviewer with web access run by the crew review tool',
      tools: ['Read', 'Bash', 'WebSearch', 'WebFetch'],
    },
  ]
}

/** What a running Claude reviewer may reach; keyed by its agentId. */
export type Fence = { roots: readonly string[]; secrets: readonly string[]; codexBin: string }

export const fences = new Map<string, Fence>()

/**
 * The fence of a crew reviewer, `not-ours` for any other agent, or undefined for a crew
 * reviewer whose fence never arrived. A spawn answers its agentId only once the agent runs,
 * so a first call may come before the fence is set: it waits for it up to 5 s.
 */
export async function fenceFor(io: Io, agentId: string): Promise<Fence | 'not-ours' | undefined> {
  const known = fences.get(agentId)
  if (known !== undefined) return known
  const info = (await io.agents()).find(a => a.id === agentId)
  if (info === undefined || !info.type.startsWith('crew:')) return 'not-ours'
  for (let i = 0; i < 50; i++) {
    await io.sleep(100)
    const fence = fences.get(agentId)
    if (fence !== undefined) return fence
  }
  return undefined
}

type Ending = { answer: string; reason: string; usage: unknown }

const answers = new Map<string, (end: Ending) => void>()

export function settle(agentId: string, end: Ending): boolean {
  const done = answers.get(agentId)
  if (done === undefined) return false
  answers.delete(agentId)
  done(end)
  return true
}

/** Why a Read of `path` by a fenced reviewer is refused, or undefined when it may go. */
export async function readRefusal(io: Io, fence: Fence, path: string): Promise<string | undefined> {
  const stat = await io.stat(path, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  if (real === undefined) return `${path} does not resolve`
  if (!fence.roots.some(r => isInside(real, r))) return `${path} is outside the paths this review may read`
  const name = real.slice(real.lastIndexOf('/') + 1)
  if (SECRET_NAME.test(name) || fence.secrets.includes(real)) return `${path} is a secret file`
  return undefined
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * The reviewer's shell command, run inside Codex's sandbox under the same profile as a Codex
 * reviewer: read roots readable, secrets denied, nothing writable, no network.
 */
export function fencedCommand(fence: Fence, command: string): string | undefined {
  const root = fence.roots[0]
  if (root === undefined) return undefined
  const args = [
    fence.codexBin,
    'sandbox',
    '-c',
    'default_permissions="crew"',
    '-c',
    `permissions.crew.filesystem=${profile(fence.roots, fence.secrets)}`,
    '--',
    'sh',
    '-c',
    command,
  ]
  return `cd ${shq(root)} && ${args.map(shq).join(' ')}`
}

/** A reviewer turn under way; `wait` resolves with how it ended and lifts its fence. */
export type Pending = { wait: () => Promise<Outcome> }

const failed = (model: string, detail: string, continueId?: string): Pending => ({
  wait: async () => ({ status: 'failed', text: '', model, detail, ...(continueId !== undefined ? { continueId } : {}) }),
})

function arm(io: Io, agentId: string, model: string, fence: Fence, j: Pick<Job, 'dir' | 'timeoutMs'>): Pending & { drop: () => void } {
  fences.set(agentId, fence)
  const answered = new Promise<Outcome>(resolve => {
    answers.set(agentId, end => {
      if (end.reason !== 'answer' || end.answer.trim() === '') {
        resolve({ status: 'failed', text: end.answer, model, usage: end.usage, continueId: agentId, detail: `its turn ended: ${end.reason}` })
        return
      }
      resolve({ status: 'ok', text: end.answer, findings: parseFindings(end.answer), model, usage: end.usage, continueId: agentId })
    })
  })
  let stop: (o: Outcome) => void = () => {}
  const stopped = new Promise<Outcome>(resolve => (stop = resolve))
  const timer = io.after(j.timeoutMs, () =>
    stop({ status: 'timeout', text: '', model, continueId: agentId, detail: `no answer within ${j.timeoutMs / 1000} s` }),
  )
  const drop = () => {
    timer.cancel()
    answers.delete(agentId)
    fences.delete(agentId)
  }
  return {
    drop,
    wait: async () => {
      try {
        const outcome = await Promise.race([answered, stopped])
        await io.write(`${j.dir}/answer.txt`, outcome.text)
        return outcome
      } finally {
        drop()
      }
    },
  }
}

/**
 * Starts a reviewer. Called inside the tool call that asked for it: the engine runs this
 * plugin's hooks on the calls of an agent started there, and not on one started from a timer.
 */
export async function begin(io: Io, j: Job, codexBin: string, description: string): Promise<Pending> {
  const spawned = await io.spawnAgent({
    subagentType: `crew:${j.web ? AGENT_WEB : AGENT}`,
    prompt: j.task,
    description,
    ...(j.model !== undefined ? { model: j.model } : {}),
  })
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    return failed(j.model ?? 'inherit', `the reviewer agent did not start: ${spawned.deny ?? 'no agent id'}`)
  }
  return arm(io, spawned.agentId, spawned.model, { roots: j.roots, secrets: j.secrets, codexBin }, j)
}

let resuming = 0

/**
 * Whether the reviewer types are offered: only while crew resumes one of its reviewers, since the
 * engine checks the offer on a resume as it does when the model dispatches.
 */
export const isOffered = (): boolean => resuming > 0

/** Sends a follow-up; called inside the tool call, as `begin` is. */
export async function beginFollowUp(io: Io, f: FollowUp, codexBin: string): Promise<Pending> {
  const model = f.model ?? 'inherit'
  const pending = arm(io, f.continueId, model, { roots: f.roots, secrets: f.secrets, codexBin }, f)
  resuming++
  let sent
  try {
    sent = await io.send({ to: { agentId: f.continueId }, text: f.message })
  } finally {
    resuming--
  }
  if (sent.isDelivered) return pending
  pending.drop()
  return failed(model, `the message did not reach the reviewer: ${sent.reason}`, f.continueId)
}
