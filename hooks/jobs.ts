import type { AgentsActivity, AgentsJob, AgentsOutcome, AgentsRun } from 'cc-agents'
import type { ProvidersReadSpec } from 'cc-providers'

import { type Change, type ChangeSpec, changeOf } from './changes.ts'
import type { Effective } from './config.ts'
import type { Io } from './io.ts'
import { type Reading, readingOf } from './liveness.ts'
import { folderOf, join } from './paths.ts'
import { taskText } from './prompt.ts'
import { findingCount, findingsText, fullReport, type Left, type Merged, merge, parseAnswer, REPORT_SCHEMA, scopeList, scopeReport } from './report.ts'

/** The `$.agents` calls crew makes, spelled out in register.ts. */
export type AgentsPort = {
  start: (input: { session: string; provider: string; kind: string; job: Omit<AgentsJob, 'cacheTtl'>; group: string; label: string }) => Promise<AgentsRun>
  followUp: (input: { session: string; id: string; message: string }) => Promise<AgentsRun>
  stop: (input: { id: string }) => Promise<{ isStopping: boolean }>
  activity: (input: { id: string }) => Promise<AgentsActivity | null>
  get: (input: { id: string }) => Promise<AgentsRun>
  list: (input: { session: string }) => Promise<AgentsRun[]>
}

/** The `$.providers` calls crew makes before a job starts, spelled out in register.ts. */
export type ProvidersPort = {
  refusal: (input: { session: string; key: string }) => Promise<{ refusal: string | null }>
  roots: (input: { read: ProvidersReadSpec; project: string }) => Promise<{ roots: string[]; files: string[] }>
  secretPaths: (input: { paths: string[] }) => Promise<{ secret: string[] }>
}

/** Tells the person a provider needs them; answers why the message failed, or undefined. */
export type Alert = (provider: string, detail: string) => Promise<string | undefined>

/** Why crew turns a call down: the caller's to fix, said as is. */
export class Refused extends Error {}

/** A model of the job and the provider picked for it. */
export type Picked = Effective & { provider: string; model: string; key: string }

/**
 * One agent of a job. The conversation knows it by `label` alone; the rest stays in the file and the tab, so reports
 * are read without knowing which model wrote them. How it runs, what it spent and until when its cache is warm are
 * its agents run's (`agent`), set once `$.agents` took it.
 */
export type JobAgent = Picked & {
  label: string
  agent?: string
  /** Why `$.agents` did not take it. */
  error?: string
  /** It left an answer, in the format or not. */
  hasAnswer?: boolean
  findings?: number
}

export type Job = {
  /** `review-3`: numbered within the session, as the conversation names it. */
  id: string
  /** The job's name in crew's config. */
  job: string
  title: string
  createdAt: number
  session: string
  /** Where its record and reports are. */
  dir: string
  /** The real paths it may read, as the brief names them. */
  roots: string[]
  diff?: string
  agents: JobAgent[]
  /** The models that could not run, and why. */
  skipped: { serves: string; why: string }[]
  /** A full read of the report acked it. */
  isAcked: boolean
  /** Why a message to the person's messenger failed. */
  courier?: string
}

export type BeginInput = {
  session: string
  job: string
  brief: string
  picks: readonly Picked[]
  skipped: readonly { serves: string; why: string }[]
  /** The cc-agents kind every agent runs as. */
  kind: string
  read: ProvidersReadSpec
  project: string
  diff?: ChangeSpec
  system: string
}

/** An agent's state: its agents run's, `failed` when it never got one, `starting` until it does. */
export type AgentStatus = AgentsRun['status'] | 'starting'

/** A job with each agent's run as it stands, for the views. */
export type JobView = { job: Job; agents: { entry: JobAgent; run?: AgentsRun; status: AgentStatus; reading?: Reading }[] }

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** `A`, `B`, … `Z`, then `A2`. */
export const labelOf = (n: number): string => `${LETTERS[n % 26]}${n < 26 ? '' : Math.floor(n / 26) + 1}`

/** The brief's first line, short enough for a list. */
export function titleOf(brief: string): string {
  const line = brief.trim().split('\n')[0]!.trim()
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`
}

export function clockText(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const LOUD: Partial<Record<AgentStatus, string>> = {
  signed_out: 'SIGNED OUT',
  quota: 'OUT OF QUOTA',
  limit: 'REFUSED AT ITS LIMIT',
  failed: 'FAILED',
  timeout: 'TIMED OUT',
  stopped: 'STOPPED',
  left_roots: 'LEFT ITS READ PATHS',
}

/** The outcome a run ended with at once, refused before it ran: there is no `ended` call for it. */
const refusedOutcome = (run: AgentsRun): AgentsOutcome => ({
  status: run.status === 'running' ? 'failed' : run.status,
  text: '',
  model: run.usedModel ?? run.job.model ?? 'default',
  ...(run.detail === undefined ? {} : { detail: run.detail }),
})

/** `root`: the folder of reports, by session. `cacheDir`: the harnesses' working folders. */
export function makeJobs(root: string, cacheDir: string) {
  /** By `<session>/<id>`, which is also their agents' group. */
  const jobs = new Map<string, Job>()
  /** The agents runs of crew's agents, as the last start, follow-up or end left each. */
  const runs = new Map<string, AgentsRun>()
  /** A follow-up's message until its answer is kept, by agents run id. */
  const asked = new Map<string, string>()
  const doneWaiters = new Map<string, (() => void)[]>()
  const answerWaiters = new Map<string, (() => void)[]>()
  /** The last liveness reading of each running agent, by agents run id. */
  const readings = new Map<string, Reading>()
  /** What this session has been told of a running job: the stalls and ends, and when it last heard. */
  const told = new Map<string, { marks: Set<string>; at: number }>()

  const keyOf = (job: Pick<Job, 'session' | 'id'>) => `${job.session}/${job.id}`
  const dirOf = (session: string, id: string) => join(join(root, session), id)
  const recordOf = (dir: string) => join(dir, 'job.json')

  const save = (io: Io, job: Job) => io.write(recordOf(job.dir), JSON.stringify(job, null, 2))

  /** A job from memory, or from disk with its agents' runs, so one from another session reads as it ended. */
  async function load(io: Io, agents: AgentsPort, session: string, id: string): Promise<Job> {
    // a full `<session>/<id>` reaches an older session's job
    const key = id.includes('/') ? id : `${session}/${id}`
    const known = jobs.get(key)
    if (known !== undefined) return known
    const path = recordOf(join(root, key))
    if (!(await io.exists(path))) throw new Refused(`no job ${id}; jobs lists this session's`)
    const job = JSON.parse(await io.read(path)) as Job
    for (const entry of job.agents) {
      if (entry.agent !== undefined && !runs.has(entry.agent)) runs.set(entry.agent, await agents.get({ id: entry.agent }))
    }
    jobs.set(key, job)
    return job
  }

  /** The runs and follow-ups whose `ended` call crew took, by run id and follow-up number. */
  const endedSeen = new Set<string>()
  const endOf = (run: AgentsRun) => `${run.id}#${run.followUps}`

  function statusOf(entry: JobAgent): AgentStatus {
    if (entry.error !== undefined) return 'failed'
    if (entry.agent === undefined) return 'starting'
    return runs.get(entry.agent)?.status ?? 'starting'
  }

  const isDone = (job: Job) => job.agents.every(e => !['running', 'starting'].includes(statusOf(e)))

  function wake(waiters: Map<string, (() => void)[]>, key: string): void {
    for (const w of waiters.get(key) ?? []) w()
    waiters.delete(key)
  }

  const answerPath = (job: Job, entry: JobAgent, run: AgentsRun) => join(job.dir, `${entry.label}${run.followUps === 0 ? '' : `-followup-${run.followUps}`}.json`)

  /** Keeps what the agent left and tells the person when its provider needs them. */
  async function keepAnswer(io: Io, alert: Alert, job: Job, entry: JobAgent, run: AgentsRun, o: AgentsOutcome): Promise<void> {
    const message = asked.get(run.id)
    asked.delete(run.id)
    const answer = parseAnswer(o.text)
    const left = { status: o.status, model: o.model, ...(o.detail === undefined ? {} : { detail: o.detail }), ...(message === undefined ? {} : { message }), ...(answer === undefined ? { text: o.text } : { answer }) }
    await io.write(answerPath(job, entry, run), JSON.stringify(left, null, 2))
    if (o.text.trim() !== '') entry.hasAnswer = true
    if (answer !== undefined) entry.findings = answer.scopes.reduce((n, s) => n + s.findings.length, 0)
    if (o.status === 'signed_out' || o.status === 'quota') {
      const failed = await alert(entry.provider, o.detail ?? o.status)
      if (failed !== undefined) job.courier = failed
    }
  }

  /**
   * Keeps a start or follow-up answer. Refused, it is kept now. Ended without being refused, its `ended` call came
   * before this answer, or will come after it with the outcome, until which it counts as running.
   */
  async function answered(io: Io, alert: Alert, job: Job, entry: JobAgent, run: AgentsRun): Promise<void> {
    if (endedSeen.has(endOf(run))) return
    if (run.status === 'running' || run.isRefused !== true) {
      runs.set(run.id, { ...run, status: 'running' })
      return
    }
    runs.set(run.id, run)
    await keepAnswer(io, alert, job, entry, run, refusedOutcome(run))
  }

  async function newId(io: Io, session: string, job: string): Promise<string> {
    for (let n = 1; ; n++) {
      const id = `${job}-${n}`
      if (!jobs.has(`${session}/${id}`) && !(await io.exists(recordOf(dirOf(session, id))))) return id
    }
  }

  /** What every agent left, read from the job's folder. */
  async function merged(io: Io, job: Job): Promise<Merged> {
    const left: Left[] = []
    for (const entry of job.agents) {
      const path = join(job.dir, `${entry.label}.json`)
      if (!(await io.exists(path))) continue
      const kept = JSON.parse(await io.read(path)) as { answer?: Left['answer']; text?: string }
      left.push({ agent: entry.label, ...(kept.answer === undefined ? {} : { answer: kept.answer }), ...(kept.text === undefined ? {} : { text: kept.text }) })
    }
    return merge(left)
  }

  /** How each agent stands, by its label alone. */
  function standing(job: Job): string[] {
    return job.agents.map(entry => {
      const status = statusOf(entry)
      const reading = entry.agent === undefined ? undefined : readings.get(entry.agent)
      if (status === 'running') return `agent ${entry.label}: ${reading?.text ?? 'working'}`
      if (status === 'ok') return `agent ${entry.label}: done`
      return `agent ${entry.label}: ${LOUD[status] ?? status}`
    })
  }

  const noteOf = (job: Job) => (job.skipped.length === 0 ? [] : [`${job.skipped.length} model${job.skipped.length === 1 ? '' : 's'} could not run, as the crew tab shows.`])

  return {
    load,
    statusOf,
    isDone,
    runOf: (agent: string | undefined): AgentsRun | undefined => (agent === undefined ? undefined : runs.get(agent)),
    sessionJobs: (session: string): Job[] => [...jobs.values()].filter(r => r.session === session),
    viewOf: (job: Job): JobView => ({
      job,
      agents: job.agents.map(entry => {
        const run = entry.agent === undefined ? undefined : runs.get(entry.agent)
        const reading = entry.agent === undefined ? undefined : readings.get(entry.agent)
        return { entry, ...(run === undefined ? {} : { run }), status: statusOf(entry), ...(reading === undefined ? {} : { reading }) }
      }),
    }),

    /** This session's jobs from disk and their agents' runs, so a reload or a resume still shows them. */
    async restore(io: Io, agents: AgentsPort, session: string): Promise<void> {
      const dir = join(root, session)
      if (await io.exists(dir)) {
        for (const entry of await io.list(dir)) {
          if (entry.kind !== 'dir' || jobs.has(`${session}/${entry.name}`)) continue
          const path = recordOf(join(dir, entry.name))
          // the folder's record is written once the job began
          if (!(await io.exists(path))) continue
          jobs.set(`${session}/${entry.name}`, JSON.parse(await io.read(path)) as Job)
        }
      }
      const listed = await agents.list({ session })
      for (const run of listed) runs.set(run.id, run)
      // a reload while a job started can leave agents whose runs started but were never written into the job
      for (const job of jobs.values()) {
        if (job.session !== session) continue
        let isBound = false
        for (const entry of job.agents) {
          if (entry.agent !== undefined || entry.error !== undefined) continue
          const run = listed.find(r => r.group === keyOf(job) && r.label === entry.label)
          if (run === undefined) continue
          entry.agent = run.id
          isBound = true
        }
        if (isBound) await save(io, job)
      }
    },

    /** Starts every agent; one refused at once is kept at once. */
    async begin(io: Io, agents: AgentsPort, providers: ProvidersPort, alert: Alert, input: BeginInput): Promise<Job> {
      const { roots } = await providers.roots({ read: input.read, project: input.project })
      let change: Change | undefined
      if (input.diff !== undefined) {
        // the repository is the first read path as the call names it: the resolved roots come back sorted
        const first = input.read === 'none' ? undefined : await providers.roots({ read: input.read === 'project' ? 'project' : input.read.slice(0, 1), project: input.project })
        const repo = first?.roots[0]
        if (first === undefined || repo === undefined) throw new Refused('diff needs paths, the first of them in the repository')
        const secretsOf = async (paths: string[]) => (await providers.secretPaths({ paths })).secret
        change = await changeOf(io, folderOf(repo, first.files), roots, input.diff, secretsOf)
      }
      const id = await newId(io, input.session, input.job)
      const dir = dirOf(input.session, id)
      const job: Job = {
        id,
        job: input.job,
        title: titleOf(input.brief),
        createdAt: await io.now(),
        session: input.session,
        dir,
        roots,
        ...(change !== undefined ? { diff: change.label } : {}),
        agents: input.picks.map((p, i) => ({ ...p, label: labelOf(i) })),
        skipped: [...input.skipped],
        isAcked: false,
      }
      jobs.set(keyOf(job), job)
      await io.write(join(dir, 'brief.md'), input.brief)
      await save(io, job)
      await Promise.all(
        job.agents.map(async entry => {
          const task = taskText({ brief: input.brief, roots, web: entry.web, ...(change !== undefined ? { changes: change } : {}) })
          const spec: Omit<AgentsJob, 'cacheTtl'> = {
            dir: join(join(cacheDir, 'runs'), `${input.session}-${id}-${entry.label}`),
            read: input.read,
            project: input.project,
            system: input.system,
            task,
            web: entry.web,
            helpers: entry.helpers,
            model: entry.model,
            ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
            schema: REPORT_SCHEMA,
            timeoutMs: entry.timeoutMs,
          }
          let run: AgentsRun
          try {
            run = await agents.start({ session: input.session, provider: entry.provider, kind: input.kind, job: spec, group: keyOf(job), label: entry.label })
          } catch (err) {
            entry.error = `agents did not take it: ${err instanceof Error ? err.message : String(err)}`
            return
          }
          entry.agent = run.id
          await answered(io, alert, job, entry, run)
        }),
      )
      await save(io, job)
      return job
    },

    /** Resolves once no agent of the job runs. */
    whenDone(job: Job): Promise<void> {
      if (isDone(job)) return Promise.resolve()
      const key = keyOf(job)
      return new Promise(resolve => doneWaiters.set(key, [...(doneWaiters.get(key) ?? []), resolve]))
    },

    /** Resolves once the agent's run is no longer running. */
    whenAnswered(agent: string): Promise<void> {
      if (runs.get(agent)?.status !== 'running') return Promise.resolve()
      return new Promise(resolve => answerWaiters.set(agent, [...(answerWaiters.get(agent) ?? []), resolve]))
    },

    /** Asks a finished agent a follow-up in its own conversation; answers its agents run, running, or ended at once when refused. */
    async ask(io: Io, agents: AgentsPort, providers: ProvidersPort, alert: Alert, session: string, id: string, label: string, message: string): Promise<{ job: Job; run: AgentsRun }> {
      const job = await load(io, agents, session, id)
      const entry = job.agents.find(x => x.label === label)
      if (entry === undefined) throw new Refused(`${job.id} has no agent ${label}; it has ${job.agents.map(x => x.label).join(', ')}`)
      if (entry.agent === undefined) throw new Refused(`agent ${label} never started: ${entry.error ?? 'its start did not finish'}`)
      const run = runs.get(entry.agent) ?? (await agents.get({ id: entry.agent }))
      if (run.status === 'running') throw new Refused(`agent ${label} is still running`)
      if (run.continueId === undefined) {
        throw new Refused(`agent ${label} ended ${run.status}${run.detail === undefined ? '' : ` (${run.detail})`} before its conversation began, so a follow-up has nothing to continue; start a new one instead`)
      }
      const { refusal } = await providers.refusal({ session, key: run.key })
      if (refusal !== null) throw new Refused(`agent ${label}: ${refusal}`)
      asked.set(run.id, message)
      let going: AgentsRun
      try {
        going = await agents.followUp({ session, id: run.id, message })
      } catch (err) {
        asked.delete(run.id)
        throw err
      }
      await answered(io, alert, job, entry, going)
      if (going.isRefused === true) await save(io, job)
      return { job, run: going }
    },

    /** Stops the job's running agents, or the one labelled; answers how many it asked to stop. */
    async stop(agents: AgentsPort, session: string, id: string, label?: string): Promise<number> {
      const job = jobs.get(id.includes('/') ? id : `${session}/${id}`)
      if (job === undefined) throw new Refused(`no job ${id} in this session; jobs lists them`)
      if (label !== undefined && !job.agents.some(e => e.label === label)) throw new Refused(`${job.id} has no agent ${label}; it has ${job.agents.map(x => x.label).join(', ')}`)
      let count = 0
      for (const entry of job.agents) {
        if (entry.agent === undefined || statusOf(entry) !== 'running' || (label !== undefined && label !== entry.label)) continue
        await agents.stop({ id: entry.agent })
        count += 1
      }
      return count
    },

    /** Takes an agent's run that ended; undefined for a run that is no agent of crew's in this load. */
    async ended(io: Io, alert: Alert, run: AgentsRun, outcome: AgentsOutcome): Promise<Job | undefined> {
      const job = run.group === undefined ? undefined : jobs.get(run.group)
      if (job === undefined) return undefined
      // an end can come before the start's answer bound the agent to its run
      const entry = job.agents.find(e => e.agent === run.id) ?? job.agents.find(e => e.agent === undefined && e.label === run.label)
      if (entry === undefined) throw new Error(`crew: ${job.id} has no agent on agents run ${run.id}, which ended`)
      entry.agent = run.id
      endedSeen.add(endOf(run))
      runs.set(run.id, run)
      readings.delete(run.id)
      await keepAnswer(io, alert, job, entry, run, outcome)
      await save(io, job)
      wake(answerWaiters, run.id)
      if (isDone(job)) wake(doneWaiters, keyOf(job))
      return job
    },

    /** Reads each running agent's activity; a stall stays in `readings` for the views and the next poke. */
    async read(agents: AgentsPort, session: string, now: number): Promise<void> {
      for (const job of jobs.values()) {
        if (job.session !== session || isDone(job)) continue
        for (const entry of job.agents) {
          if (entry.agent === undefined || statusOf(entry) !== 'running') continue
          readings.set(entry.agent, readingOf(await agents.activity({ id: entry.agent }), entry.stallMs, now))
        }
      }
    },

    /**
     * What the idle conversation should hear of this running job now, or undefined: an agent stalled or ended badly
     * that it was not told of, or its status when the job's shortest poke has passed since it last heard.
     */
    poke(job: Job, now: number): string | undefined {
      if (isDone(job)) return undefined
      const key = keyOf(job)
      const state = told.get(key) ?? { marks: new Set<string>(), at: job.createdAt }
      const fresh: string[] = []
      for (const entry of job.agents) {
        const status = statusOf(entry)
        const mark = status === 'running' ? (entry.agent === undefined ? undefined : readings.get(entry.agent))?.mark : ['ok', 'starting'].includes(status) ? '' : `ended:${entry.label}`
        if (mark !== undefined && mark !== '' && !state.marks.has(mark)) fresh.push(mark)
      }
      const running = job.agents.filter(e => statusOf(e) === 'running')
      const isDue = running.length > 0 && now - state.at >= Math.min(...running.map(e => e.pokeMs))
      if (fresh.length === 0 && !isDue) return undefined
      told.set(key, { marks: new Set([...state.marks, ...fresh]), at: now })
      const minutes = Math.round((now - job.createdAt) / 60_000)
      return [`${job.id} "${job.title}", running ${minutes}m:`, ...standing(job).map(s => `- ${s}`), `Leave it, or give up on one with stop { id: "${job.id}", agent: "<letter>" }.`].join('\n')
    },

    /** The job as the conversation hears of it: one line, then each agent while it runs. */
    async line(io: Io, job: Job, now: number): Promise<string> {
      if (!isDone(job)) return [`${job.id} running ${Math.round((now - job.createdAt) / 60_000)}m "${job.title}"`, ...standing(job).map(s => `  ${s}`)].join('\n')
      const m = await merged(io, job)
      const read = job.isAcked ? 'read' : 'unread'
      return `${job.id} done, ${read}, "${job.title}": ${findingCount(m)} findings${m.scopes.length === 0 ? '' : ` in ${scopeList(m)}`}`
    },

    /** What the conversation hears when the job ends. */
    async summary(io: Io, job: Job): Promise<string> {
      const m = await merged(io, job)
      const bad = job.agents.filter(e => !['ok', 'running', 'starting'].includes(statusOf(e)))
      return [
        `${job.id} "${job.title}" finished: ${findingCount(m)} findings${m.scopes.length === 0 ? '' : ` in ${scopeList(m)}`}.`,
        ...bad.map(e => `agent ${e.label}: ${LOUD[statusOf(e)] ?? statusOf(e)}.`),
        ...noteOf(job),
        ...(job.courier === undefined ? [] : [`Courier alert failed: ${job.courier}`]),
        `Read it with report { id: "${job.id}" }, or findings_only / scope for less.`,
      ].join('\n')
    },

    /** The report: whole (which acks the job), one scope, or the findings with their references. */
    async report(io: Io, agents: AgentsPort, session: string, id: string, read: { scope?: string; findingsOnly?: boolean }): Promise<string> {
      const job = await load(io, agents, session, id)
      const m = await merged(io, job)
      if (read.scope !== undefined) {
        const text = scopeReport(m, read.scope)
        if (text === undefined) throw new Refused(`${job.id} has no scope "${read.scope}"; it has ${m.scopes.map(s => s.scope).join(', ') || 'none'}`)
        return text
      }
      if (read.findingsOnly === true) return findingsText(m)
      const text = fullReport(m)
      if (isDone(job) && !job.isAcked) {
        job.isAcked = true
        await save(io, job)
      }
      return isDone(job) ? text : `${job.id} is still running; this is what it has so far.\n\n${text}`
    },
  }
}

export type Jobs = ReturnType<typeof makeJobs>
