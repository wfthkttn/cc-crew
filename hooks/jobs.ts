import type { Agents, AgentsJobSpec, AgentsOutcome, AgentsRun, AgentsTier } from 'cc-agents'
import type { ProvidersReadSpec } from 'cc-providers'

import { type Change, type ChangeSpec, changeOf } from './changes.ts'
import type { Effective } from './config.ts'
import type { Io } from './io.ts'
import { type Reading, readingOf } from './liveness.ts'
import { folderOf, join } from './paths.ts'
import { taskText } from './prompt.ts'
import { findingCount, findingsText, fullReport, type Left, type Merged, merge, parseAnswer, REPORT_SCHEMA, scopeList, scopeReport } from './report.ts'

/** The `$.agents` calls jobs make, spelled out in register.ts. */
export type AgentsPort = Pick<Agents, 'start' | 'followUp' | 'stop' | 'health' | 'get' | 'list' | 'outcome'>

/** The `$.providers` calls crew makes for a job's paths and diff, spelled out in register.ts. */
export type ProvidersPort = {
  roots: (input: { read: ProvidersReadSpec; project: string }) => Promise<{ roots: string[]; files: string[] }>
  secretPaths: (input: { paths: string[] }) => Promise<{ secret: string[] }>
}

/** Tells the person a provider needs them; answers why the message failed, or undefined. */
export type Alert = (provider: string, detail: string) => Promise<string | undefined>

/** Why crew turns a call down: the caller's to fix, said as is. */
export class Refused extends Error {}

/**
 * One agent of a job. The conversation knows it by `label` alone; the rest stays in the file and the tab, so reports
 * are read without knowing which model wrote them. Where it ran, how, what it spent and until when its cache is warm
 * are its agents run's (`agent`), set once `$.agents` took it.
 */
export type JobAgent = Effective & {
  label: string
  agent?: string
  /** Why `$.agents` did not take it. */
  error?: string
  /** It left an answer, in the format or not. */
  hasAnswer?: boolean
  findings?: number
  /** The run's follow-up count when crew last kept what it left. */
  kept?: number
  /** The same when the person was last told of an end that needs them. */
  alerted?: number
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
  /** The conversation was told it ended. */
  isAnnounced?: boolean
  /** Why a message to the person's messenger failed. */
  courier?: string
}

/** `<session>/<id>`: how crew keys a job, and the group its agents run under. */
export const jobKey = (job: Pick<Job, 'session' | 'id'>) => `${job.session}/${job.id}`

export type BeginInput = {
  session: string
  job: string
  brief: string
  models: readonly Effective[]
  skipped: readonly { serves: string; why: string }[]
  /** The cc-agents kind and profile every agent runs as, and the tiers it may run on. */
  kind: string
  profile: string
  prefer: readonly AgentsTier[]
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

const WHERE_JOBS_ARE = "jobs lists this session's, and an earlier session's job is named <session>/<job>-<n>"

/** `root`: the folder of reports, by session. */
export function makeJobs(root: string) {
  /** By `<session>/<id>`, which is also their agents' group. */
  const jobs = new Map<string, Job>()
  /** What cc-agents last said of crew's agents' runs, for the sync views; it holds them. */
  const runs = new Map<string, AgentsRun>()
  /** The ends being kept, so one heard twice, by its `ended` and by a restore, is kept once. */
  const keeping = new Set<string>()
  /** The jobs whose finish is being told, by folder: only a delivered one reads as announced, on disk too. */
  const announcing = new Set<string>()
  /** The jobs told whose record does not say so yet, by folder; the next try writes it, or a reload tells them again. */
  const announcedUnsaved = new Set<string>()
  const answerWaiters = new Map<string, (() => void)[]>()
  /** The last liveness reading of each running agent, by agents run id. */
  const readings = new Map<string, Reading>()
  /** What this session has been told of a running job: the stalls and ends, and when it last heard. */
  const told = new Map<string, { marks: Set<string>; at: number }>()
  /** Job keys taken in this load, so two calls at once can't share an id; one whose job never began stays taken. */
  const takenIds = new Set<string>()

  const keyOf = jobKey
  const dirOf = (session: string, id: string) => join(join(root, session), id)
  const recordOf = (dir: string) => join(dir, 'job.json')

  const save = (io: Io, job: Job) => io.write(recordOf(job.dir), JSON.stringify(job, null, 2))

  /** How the conversation in `session` names the job: another session's goes by its full id. */
  const refOf = (job: Job, session: string) => (job.session === session ? job.id : keyOf(job))

  /** A full `<session>/<id>` reaches an older session's job; nothing else leaves the session's folder. */
  function keyFor(session: string, id: string): string {
    const parts = id.split('/')
    if (parts.length > 2 || parts.some(p => p === '' || p === '.' || p === '..')) throw new Refused(`no job ${id}; ${WHERE_JOBS_ARE}`)
    return parts.length === 2 ? id : `${session}/${id}`
  }

  /** A job from memory, or from disk with its agents' runs, so one from another session reads as it ended. */
  async function load(io: Io, agents: AgentsPort, session: string, id: string): Promise<Job> {
    const key = keyFor(session, id)
    const known = jobs.get(key)
    if (known !== undefined) return known
    const path = recordOf(join(root, key))
    if (!(await io.exists(path))) throw new Refused(`no job ${id}; ${WHERE_JOBS_ARE}`)
    const job = JSON.parse(await io.read(path)) as Job
    for (const entry of job.agents) {
      if (entry.agent !== undefined && !runs.has(entry.agent)) runs.set(entry.agent, await agents.get({ id: entry.agent }))
    }
    await catchUp(io, agents, job)
    jobs.set(key, job)
    return job
  }

  function statusOf(entry: JobAgent): AgentStatus {
    if (entry.error !== undefined) return 'failed'
    if (entry.agent === undefined) return 'starting'
    const run = runs.get(entry.agent)
    if (run === undefined) return 'starting'
    // until its answer is kept the job must not read as done, or a full read acks it short of this answer
    return run.status !== 'running' && entry.kept !== run.followUps ? 'running' : run.status
  }

  const isDone = (job: Job) => job.agents.every(e => !['running', 'starting'].includes(statusOf(e)))

  function wake(waiters: Map<string, (() => void)[]>, key: string): void {
    for (const w of waiters.get(key) ?? []) w()
    waiters.delete(key)
  }

  const answerPath = (job: Job, entry: JobAgent, run: AgentsRun) => join(job.dir, `${entry.label}${run.followUps === 0 ? '' : `-followup-${run.followUps}`}.json`)

  /** Keeps what a run left at its end, once; `o` null: cc-agents kept nothing of it, and the run's record says why. */
  async function keepEnd(io: Io, job: Job, entry: JobAgent, run: AgentsRun, o: AgentsOutcome | null): Promise<void> {
    const end = `${run.id}#${run.followUps}`
    if (entry.kept === run.followUps || keeping.has(end)) return
    keeping.add(end)
    if (o !== null) {
      const message = run.attempts.at(-1)?.message
      const answer = parseAnswer(o.text)
      const left = { status: o.status, model: o.model, ...(o.detail === undefined ? {} : { detail: o.detail }), ...(message === undefined ? {} : { message }), ...(answer === undefined ? { text: o.text } : { answer }) }
      try {
        await io.write(answerPath(job, entry, run), JSON.stringify(left, null, 2))
        if (o.text.trim() !== '') entry.hasAnswer = true
        if (answer !== undefined) entry.findings = answer.scopes.reduce((n, s) => n + s.findings.length, 0)
      } catch (err) {
        // the engine refuses a write past 4 MiB; the job still has to end
        entry.error = `its answer could not be kept: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    entry.kept = run.followUps
    keeping.delete(end)
  }

  const isForPerson = (status: AgentStatus) => status === 'signed_out' || status === 'quota'

  /** Whether `a` is further along than `b`, a state of the same run: a run moves through follow-ups, then attempts, then its end. */
  function isAhead(a: AgentsRun, b: AgentsRun): boolean {
    if (a.followUps !== b.followUps) return a.followUps > b.followUps
    if (a.attempts.length !== b.attempts.length) return a.attempts.length > b.attempts.length
    return a.status !== 'running' && b.status === 'running'
  }

  /** Tells the person of an end their provider needs them for, once however it was heard. */
  async function tellPerson(alert: Alert, job: Job, entry: JobAgent, run: AgentsRun, how: { status: AgentStatus; detail?: string }): Promise<void> {
    if (!isForPerson(how.status) || entry.alerted === run.followUps) return
    entry.alerted = run.followUps
    const failed = await alert(run.provider, how.detail ?? how.status)
    if (failed !== undefined) job.courier = failed
  }

  /** Keeps what runs left that ended with nobody here to take their `ended` call; `alert` for a job of this session, whose person can act on it. */
  async function catchUp(io: Io, agents: AgentsPort, job: Job, alert?: Alert): Promise<void> {
    let isChanged = false
    for (const entry of job.agents) {
      const run = entry.agent === undefined ? undefined : runs.get(entry.agent)
      if (run === undefined || run.status === 'running') continue
      // another session can read a job's report and keep its answer; the alert still waits for this one
      const owesAlert = alert !== undefined && isForPerson(run.status) && entry.alerted !== run.followUps
      if (entry.kept === run.followUps && !owesAlert) continue
      const outcome = await agents.outcome({ id: run.id })
      await keepEnd(io, job, entry, run, outcome)
      if (alert !== undefined) await tellPerson(alert, job, entry, run, outcome ?? run)
      isChanged = true
    }
    if (isChanged) await save(io, job)
  }

  /** The agent a run is; a run can move before its start's answer bound it. */
  function entryOf(job: Job, run: AgentsRun): JobAgent {
    const entry = job.agents.find(e => e.agent === run.id) ?? job.agents.find(e => e.agent === undefined && e.label === run.label)
    if (entry === undefined) throw new Error(`crew: ${job.id} has no agent on agents run ${run.id}`)
    entry.agent = run.id
    return entry
  }

  /** Takes a start's or follow-up's answer, which can trail the calls that moved the run on. One refused at once is kept now, so the caller can say so; its `ended` finds it kept. */
  async function took(io: Io, agents: AgentsPort, job: Job, entry: JobAgent, run: AgentsRun): Promise<void> {
    entry.agent = run.id
    const was = runs.get(run.id)
    if (was === undefined || was.followUps < run.followUps || run.isRefused === true) runs.set(run.id, run)
    if (run.isRefused === true) await keepEnd(io, job, entry, run, await agents.outcome({ id: run.id }))
  }

  async function newId(io: Io, session: string, job: string): Promise<string> {
    for (let n = 1; ; n++) {
      const id = `${job}-${n}`
      if (jobs.has(`${session}/${id}`) || takenIds.has(`${session}/${id}`)) continue
      takenIds.add(`${session}/${id}`)
      if (!(await io.exists(recordOf(dirOf(session, id))))) return id
    }
  }

  /** What every agent left, read from the job's folder. */
  async function merged(io: Io, job: Job): Promise<Merged> {
    const left: Left[] = []
    for (const entry of job.agents) {
      const path = join(job.dir, `${entry.label}.json`)
      if (!(await io.exists(path))) continue
      const text = await io.read(path)
      let kept: { answer?: Left['answer']; text?: string }
      try {
        kept = JSON.parse(text) as typeof kept
      } catch (err) {
        // the engine promises no atomic write, so an answer still being kept can read half written
        if (['running', 'starting'].includes(statusOf(entry))) continue
        throw new Error(`crew: ${path} does not parse: ${err instanceof Error ? err.message : String(err)}`)
      }
      left.push({ agent: entry.label, ...(kept.answer === undefined ? {} : { answer: kept.answer }), ...(kept.text === undefined ? {} : { text: kept.text }) })
    }
    return merge(left)
  }

  /** How an agent ended badly and why; the reason is the harness's or providers', and may name a provider. */
  function troubleOf(entry: JobAgent, status: AgentStatus): string {
    const reason = entry.error ?? (entry.agent === undefined ? undefined : runs.get(entry.agent)?.detail)
    return `${LOUD[status] ?? status}${reason === undefined ? '' : `: ${reason}`}`
  }

  /** How each agent stands, by its label alone. */
  function standing(job: Job): string[] {
    return job.agents.map(entry => {
      const status = statusOf(entry)
      const reading = entry.agent === undefined ? undefined : readings.get(entry.agent)
      if (status === 'running') return `agent ${entry.label}: ${reading?.text ?? 'working'}`
      if (status === 'ok') return `agent ${entry.label}: done`
      return `agent ${entry.label}: ${troubleOf(entry, status)}`
    })
  }

  const usableOf = (job: Job) => job.agents.filter(e => e.findings !== undefined).length

  /** What a reader has to know before trusting what the agents left: a running or thin job, and who is missing from it. */
  function caveats(job: Job): string[] {
    const usable = usableOf(job)
    const total = job.agents.length
    const running = job.agents.filter(e => ['running', 'starting'].includes(statusOf(e))).length
    const head =
      running > 0
        ? [`${job.id} is still running, ${total - running} of ${total} agents finished; this is what it has so far.`]
        : usable === 0
          ? ['No agent gave a usable answer, so this job established nothing. Do not read it as a clean result.']
          : usable < total
            ? [`Only ${usable} of ${total} agents gave a usable answer; what follows covers them alone.`]
            : []
    const missing = job.agents.flatMap(entry => {
      const status = statusOf(entry)
      if (status === 'running' || status === 'starting') return []
      if (status !== 'ok') return [`agent ${entry.label}: ${troubleOf(entry, status)}`]
      if (entry.findings !== undefined) return []
      return [`agent ${entry.label} ${entry.hasAnswer === true ? 'answered outside the format, so its findings are not counted; its text is in the whole report' : 'left no answer'}.`]
    })
    return [...head, ...missing]
  }

  async function resultOf(io: Io, job: Job): Promise<string> {
    if (usableOf(job) === 0) return 'no usable answer'
    const m = await merged(io, job)
    return `${findingCount(m)} findings${m.scopes.length === 0 ? '' : ` in ${scopeList(m)}`}`
  }

  const noteOf = (job: Job) => (job.skipped.length === 0 ? [] : [`${job.skipped.length} of its models could not run; the person was told.`])

  async function summary(io: Io, job: Job, session: string): Promise<string> {
    const ref = refOf(job, session)
    return [
      `${ref} "${job.title}" finished: ${await resultOf(io, job)}.`,
      ...caveats(job),
      ...noteOf(job),
      ...(job.courier === undefined ? [] : [`Courier alert failed: ${job.courier}`]),
      `Read it with report { id: "${ref}" }, or findings_only / scope for less.`,
    ].join('\n')
  }

  return {
    load,
    refOf,
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
    async restore(io: Io, agents: AgentsPort, alert: Alert, session: string): Promise<void> {
      const dir = join(root, session)
      /** Only these can be left over from a load that died: a job already held here may still be starting its agents. */
      const fromDisk = new Set<string>()
      if (await io.exists(dir)) {
        for (const entry of await io.list(dir)) {
          if (entry.kind !== 'dir' || jobs.has(`${session}/${entry.name}`)) continue
          const path = recordOf(join(dir, entry.name))
          // the folder's record is written once the job began
          if (!(await io.exists(path))) continue
          jobs.set(`${session}/${entry.name}`, JSON.parse(await io.read(path)) as Job)
          fromDisk.add(`${session}/${entry.name}`)
        }
      }
      const listed = await agents.list({ session })
      for (const run of listed) {
        // what `changed` or `ended` brought while the list was out can be newer than what it answers
        const was = runs.get(run.id)
        if (was === undefined || !isAhead(was, run)) runs.set(run.id, run)
      }
      // a reload while a job started can leave agents whose runs started but were never written into the job, or never started
      for (const job of jobs.values()) {
        if (job.session !== session) continue
        let isChanged = false
        for (const entry of job.agents) {
          if (entry.agent !== undefined || entry.error !== undefined) continue
          const run = listed.find(r => r.group === keyOf(job) && r.label === entry.label)
          if (run !== undefined) entry.agent = run.id
          else if (fromDisk.has(keyOf(job))) entry.error = 'its start was cut short by a reload'
          else continue
          isChanged = true
        }
        if (isChanged) await save(io, job)
        await catchUp(io, agents, job, alert)
      }
    },

    /** Starts every agent; one refused at once is kept at once. */
    async begin(io: Io, agents: AgentsPort, providers: ProvidersPort, input: BeginInput): Promise<Job> {
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
        agents: input.models.map((m, i) => ({ ...m, label: labelOf(i) })),
        skipped: [...input.skipped],
        isAcked: false,
      }
      jobs.set(keyOf(job), job)
      await io.write(join(dir, 'brief.md'), input.brief)
      await save(io, job)
      await Promise.all(
        job.agents.map(async entry => {
          const task = taskText({ brief: input.brief, roots, web: entry.web, ...(change !== undefined ? { changes: change } : {}) })
          const spec: AgentsJobSpec = { read: input.read, project: input.project, system: input.system, task, web: entry.web, helpers: entry.helpers, schema: REPORT_SCHEMA, timeoutMs: entry.timeoutMs }
          let run: AgentsRun
          try {
            run = await agents.start({
              session: input.session,
              serves: entry.serves,
              prefer: input.prefer,
              ...(entry.provider === undefined ? {} : { provider: entry.provider }),
              ...(entry.effort === undefined ? {} : { effort: entry.effort }),
              kind: input.kind,
              profile: input.profile,
              job: spec,
              group: keyOf(job),
              label: entry.label,
            })
          } catch (err) {
            entry.error = `agents did not take it: ${err instanceof Error ? err.message : String(err)}`
            return
          }
          await took(io, agents, job, entry, run)
        }),
      )
      await save(io, job)
      return job
    },

    /** Whether a call to `announce` has anything to do. */
    needsTelling: (job: Job): boolean => isDone(job) && (job.isAnnounced !== true || announcedUnsaved.has(job.dir)),

    /** Tells the conversation of a finished job, once; one that could not be told stays untold for the next try, and one told but not recorded is recorded by it. */
    async announce(io: Io, job: Job, session: string, deliver: (text: string) => Promise<void>): Promise<void> {
      const isTold = job.isAnnounced === true
      if (!isDone(job) || announcing.has(job.dir) || (isTold && !announcedUnsaved.has(job.dir))) return
      announcing.add(job.dir)
      try {
        if (!isTold) {
          await deliver(await summary(io, job, session))
          job.isAnnounced = true
          announcedUnsaved.add(job.dir)
        }
        await save(io, job)
        announcedUnsaved.delete(job.dir)
      } finally {
        announcing.delete(job.dir)
      }
    },

    /**
     * Don't delete: parked work, not dead code. Follow-ups are how a resident crew member will be built.
     * Resolves once the agent's run is no longer running.
     */
    whenAnswered(agent: string): Promise<void> {
      if (runs.get(agent)?.status !== 'running') return Promise.resolve()
      return new Promise(resolve => answerWaiters.set(agent, [...(answerWaiters.get(agent) ?? []), resolve]))
    },

    /**
     * Don't delete: parked work, not dead code. Follow-ups are how a resident crew member will be built.
     * Asks a finished agent a follow-up in its own conversation; answers its agents run, running, or ended at once when refused.
     */
    async ask(io: Io, agents: AgentsPort, session: string, id: string, label: string, message: string): Promise<{ job: Job; run: AgentsRun }> {
      const job = await load(io, agents, session, id)
      const entry = job.agents.find(x => x.label === label)
      if (entry === undefined) throw new Refused(`${job.id} has no agent ${label}; it has ${job.agents.map(x => x.label).join(', ')}`)
      if (entry.agent === undefined) throw new Refused(`agent ${label} never started: ${entry.error ?? 'its start did not finish'}`)
      const run = runs.get(entry.agent) ?? (await agents.get({ id: entry.agent }))
      if (run.status === 'running') throw new Refused(`agent ${label} is still running`)
      if (run.continueId === undefined) {
        throw new Refused(`agent ${label} ended ${run.status}${run.detail === undefined ? '' : ` (${run.detail})`} before its conversation began, so a follow-up has nothing to continue; start a new one instead`)
      }
      const going = await agents.followUp({ session, id: run.id, message })
      await took(io, agents, job, entry, going)
      if (going.isRefused === true) await save(io, job)
      return { job, run: going }
    },

    /** Stops the job's running agents, or the one labelled; answers how many stop, and how many read as running with nothing here to stop. */
    async stop(io: Io, agents: AgentsPort, session: string, id: string, label?: string): Promise<{ stopping: number; unreachable: number }> {
      const job = await load(io, agents, session, id)
      if (label !== undefined && !job.agents.some(e => e.label === label)) throw new Refused(`${job.id} has no agent ${label}; it has ${job.agents.map(x => x.label).join(', ')}`)
      let stopping = 0
      let unreachable = 0
      for (const entry of job.agents) {
        if (entry.agent === undefined || statusOf(entry) !== 'running' || (label !== undefined && label !== entry.label)) continue
        if ((await agents.stop({ id: entry.agent })).isStopping) stopping += 1
        else unreachable += 1
      }
      return { stopping, unreachable }
    },

    /** Takes what cc-agents says of a run's record; a run that is no agent of crew's in this load is left out. */
    changed(run: AgentsRun): void {
      const job = run.group === undefined ? undefined : jobs.get(run.group)
      if (job === undefined) return
      entryOf(job, run)
      runs.set(run.id, run)
    },

    /** Takes an agent's run that ended, and tells the person when its provider needs them; undefined for a run that is no agent of crew's in this load. */
    async ended(io: Io, alert: Alert, run: AgentsRun, outcome: AgentsOutcome): Promise<Job | undefined> {
      const job = run.group === undefined ? undefined : jobs.get(run.group)
      if (job === undefined) return undefined
      const entry = entryOf(job, run)
      readings.delete(run.id)
      runs.set(run.id, run)
      await keepEnd(io, job, entry, run, outcome)
      await tellPerson(alert, job, entry, run, outcome)
      await save(io, job)
      wake(answerWaiters, run.id)
      return job
    },

    /** Reads how each running agent stands; a stall stays in `readings` for the views and the next poke. */
    async read(agents: AgentsPort, session: string): Promise<void> {
      for (const job of jobs.values()) {
        if (job.session !== session || isDone(job)) continue
        for (const entry of job.agents) {
          if (entry.agent === undefined || statusOf(entry) !== 'running') continue
          readings.set(entry.agent, readingOf(await agents.health({ id: entry.agent, stallMs: entry.stallMs })))
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
      const isTroubled = job.agents.some(e => {
        const status = statusOf(e)
        return status === 'running' ? e.agent !== undefined && readings.get(e.agent)?.isStalled === true : !['ok', 'starting'].includes(status)
      })
      const advice = isTroubled ? `Leave it, or give up on one with stop { id: "${job.id}", agent: "<letter>" }.` : 'It is working: there is nothing to do. A message says when it finishes.'
      return [`${job.id} "${job.title}", running ${minutes}m:`, ...standing(job).map(s => `- ${s}`), advice].join('\n')
    },

    /** The job as the conversation hears of it: one line, then each agent while it runs. */
    async line(io: Io, job: Job, now: number): Promise<string> {
      if (!isDone(job)) return [`${job.id} running ${Math.round((now - job.createdAt) / 60_000)}m "${job.title}"`, ...standing(job).map(s => `  ${s}`)].join('\n')
      const read = job.isAcked ? 'read' : 'unread'
      return [`${job.id} done, ${read}, "${job.title}": ${await resultOf(io, job)}`, ...caveats(job).map(s => `  ${s}`)].join('\n')
    },

    summary,

    /** The report: whole (which acks the job), one scope, or the findings with their references; each opens with its caveats. */
    async report(io: Io, agents: AgentsPort, session: string, id: string, read: { scope?: string; findingsOnly?: boolean }): Promise<string> {
      const job = await load(io, agents, session, id)
      // an end landing while `merged` reads is not in what this read shows, so it can't ack it
      const wasDone = isDone(job)
      const m = await merged(io, job)
      let text: string
      if (read.scope !== undefined) {
        const scope = scopeReport(m, read.scope)
        if (scope === undefined) throw new Refused(`${job.id} has no scope "${read.scope}"; it has ${m.scopes.map(s => s.scope).join(', ') || 'none'}`)
        text = scope
      } else if (read.findingsOnly === true) {
        // "No findings." from nobody's answer is what a reader must not take away
        text = usableOf(job) === 0 ? '' : findingsText(m)
      } else {
        text = fullReport(m)
        if (wasDone && !job.isAcked) {
          job.isAcked = true
          await save(io, job)
        }
      }
      return [caveats(job).join('\n'), text].filter(s => s !== '').join('\n\n')
    },
  }
}

export type Jobs = ReturnType<typeof makeJobs>
