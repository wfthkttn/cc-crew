import type { AgentsJob, AgentsOutcome, AgentsRun } from 'cc-agents'
import type { ProvidersReadSpec } from 'cc-providers'

import { type Change, type ChangeSpec, changeOf } from './changes.ts'
import type { Io } from './io.ts'
import { folderOf } from './paths.ts'
import { FINDINGS_SCHEMA, parseFindings, renderFindings, taskText } from './prompt.ts'
import { usd } from './usage.ts'

/** The `$.agents` calls crew makes, spelled out in register.ts. */
export type AgentsPort = {
  start: (input: { session: string; provider: string; job: AgentsJob; group: string; label: string }) => Promise<AgentsRun>
  followUp: (input: { session: string; id: string; message: string }) => Promise<AgentsRun>
  stop: (input: { id: string }) => Promise<{ isStopping: boolean }>
  get: (input: { id: string }) => Promise<AgentsRun>
  list: (input: { session: string }) => Promise<AgentsRun[]>
}

/** The `$.providers` calls crew makes before a review starts, spelled out in register.ts. */
export type ProvidersPort = {
  modelKey: (input: { provider: string; model?: string }) => Promise<string>
  refusal: (input: { session: string; key: string }) => Promise<{ refusal: string | null }>
  roots: (input: { read: ProvidersReadSpec; project: string }) => Promise<{ roots: string[]; files: string[] }>
  secretPaths: (input: { paths: string[] }) => Promise<{ secret: string[] }>
}

/** Tells the person a provider needs them; answers why the message failed, or undefined. */
export type Alert = (provider: string, detail: string) => Promise<string | undefined>

/** Why crew turns a call down: the caller's to fix, said as is. */
export class Refused extends Error {}

export type ReviewerSpec = { provider: string; model?: string; effort?: string }

/**
 * One reviewer of a review: what was asked of it and where its reports went. How it runs, what it ran and spent, and
 * until when its cache is warm are its agents run's (`agent`), set once `$.agents` took it.
 */
export type ReviewerEntry = ReviewerSpec & {
  /** Unique within the review: `<provider>-<model>`, numbered on a repeat. */
  key: string
  agent?: string
  /** Why `$.agents` did not take it. */
  error?: string
  report?: string
  findings?: number
}

export type Review = {
  id: string
  description: string
  createdAt: number
  session: string
  /** Where the reports go: `<report dir>/<id>-<slug>`. */
  reportDir: string
  /** The real paths it may read, as the brief names them. */
  roots: string[]
  web: boolean
  helpers: boolean
  changes?: string
  reviewers: ReviewerEntry[]
  /** Why a message to the person's messenger failed. */
  courier?: string
}

export type BeginInput = {
  session: string
  description: string
  brief: string
  specs: readonly ReviewerSpec[]
  read: ProvidersReadSpec
  project: string
  /** The folder the review's report folder goes in. */
  reportBase: string
  changes?: ChangeSpec
  web: boolean
  helpers: boolean
  system: string
  timeoutMs: number
}

/** A reviewer's state: its agents run's, `failed` when it never got one, `starting` until it does. */
export type ReviewerStatus = AgentsRun['status'] | 'starting'

/** A review with each reviewer's run as it stands, for the views. */
export type ReviewView = { review: Review; reviewers: { entry: ReviewerEntry; run?: AgentsRun; status: ReviewerStatus }[] }

export function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug === '' ? 'review' : slug
}

export function keysFor(specs: readonly ReviewerSpec[]): string[] {
  const used = new Map<string, number>()
  return specs.map(s => {
    const base = `${s.provider}-${slugOf(s.model ?? 'default')}`
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
}

function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function clockText(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const LOUD: Partial<Record<ReviewerStatus, string>> = {
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

export function makeReviews(cacheDir: string) {
  const reviews = new Map<string, Review>()
  /** The agents runs of crew's reviewers, as the last start, follow-up or end left each. */
  const runs = new Map<string, AgentsRun>()
  /** A follow-up's message until its report is written, by agents run id. */
  const asked = new Map<string, string>()
  const doneWaiters = new Map<string, (() => void)[]>()
  const answerWaiters = new Map<string, (() => void)[]>()

  const pathOf = (id: string) => `${cacheDir}/reviews/${id}.json`

  async function save(io: Io, review: Review): Promise<void> {
    const text = JSON.stringify(review, null, 2)
    await io.write(pathOf(review.id), text)
    await io.write(`${review.reportDir}/run.json`, text)
  }

  /** A review from memory, or from disk with its reviewers' runs, so one from another session shows as it ended. */
  async function load(io: Io, agents: AgentsPort, id: string): Promise<Review> {
    const known = reviews.get(id)
    if (known !== undefined) return known
    if (!(await io.exists(pathOf(id)))) throw new Refused(`no review ${id}`)
    const review = JSON.parse(await io.read(pathOf(id))) as Review
    for (const entry of review.reviewers) {
      if (entry.agent !== undefined && !runs.has(entry.agent)) runs.set(entry.agent, await agents.get({ id: entry.agent }))
    }
    reviews.set(id, review)
    return review
  }

  /** The runs and follow-ups whose `ended` call crew took, by run id and follow-up number. */
  const endedSeen = new Set<string>()
  const endOf = (run: AgentsRun) => `${run.id}#${run.followUps}`

  /**
   * Keeps a start or follow-up answer. Refused, it is reported now. Ended without being refused, its `ended` call came
   * before this answer, or will come after it with the outcome, until which it counts as running.
   */
  async function answered(io: Io, alert: Alert, review: Review, entry: ReviewerEntry, run: AgentsRun): Promise<void> {
    if (endedSeen.has(endOf(run))) return
    if (run.status === 'running' || run.isRefused !== true) {
      runs.set(run.id, { ...run, status: 'running' })
      return
    }
    runs.set(run.id, run)
    await report(io, alert, review, entry, run, refusedOutcome(run))
  }

  function statusOf(entry: ReviewerEntry): ReviewerStatus {
    if (entry.error !== undefined) return 'failed'
    if (entry.agent === undefined) return 'starting'
    return runs.get(entry.agent)?.status ?? 'starting'
  }

  const isDone = (review: Review) => review.reviewers.every(e => !['running', 'starting'].includes(statusOf(e)))

  function wake(waiters: Map<string, (() => void)[]>, key: string): void {
    for (const w of waiters.get(key) ?? []) w()
    waiters.delete(key)
  }

  function header(review: Review, entry: ReviewerEntry, o: AgentsOutcome, message?: string): string {
    const lines = [
      `# ${review.description}: ${entry.provider} (${o.model})`,
      '',
      `- Run: ${review.id}, status: ${o.status}${o.detail !== undefined ? ` (${o.detail})` : ''}`,
      `- Effort: ${entry.effort ?? 'default'}; read: ${review.roots.length > 0 ? review.roots.join(', ') : 'nothing'}; web: ${review.web ? 'on' : 'off'}`,
    ]
    if (review.changes !== undefined) lines.push(`- Change: ${review.changes}`)
    if (message !== undefined) lines.push('', `## Follow-up asked`, '', message)
    return lines.join('\n')
  }

  /** Writes the report of one run or follow-up of the reviewer and tells the person when its provider needs them. */
  async function report(io: Io, alert: Alert, review: Review, entry: ReviewerEntry, run: AgentsRun, o: AgentsOutcome): Promise<void> {
    const message = asked.get(run.id)
    asked.delete(run.id)
    const findings = parseFindings(o.text)
    const body = findings !== undefined ? renderFindings(findings) : o.text.trim() !== '' ? `## Answer (not in the findings format)\n\n${o.text}` : ''
    const path = `${review.reportDir}/${run.followUps === 0 ? entry.key : `${entry.key}-followup-${run.followUps}`}.md`
    await io.write(path, `${header(review, entry, o, message)}\n\n${body}\n`)
    entry.report = path
    if (findings !== undefined) entry.findings = findings.findings.length
    else delete entry.findings
    if (o.status === 'signed_out' || o.status === 'quota') {
      const failed = await alert(entry.provider, o.detail ?? o.status)
      if (failed !== undefined) review.courier = failed
    }
  }

  async function newId(io: Io): Promise<string> {
    const at = stamp(await io.now())
    for (;;) {
      const id = `${at}-${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')}`
      if (!reviews.has(id) && !(await io.exists(pathOf(id)))) return id
    }
  }

  return {
    load,
    statusOf,
    isDone,
    runOf: (agent: string | undefined): AgentsRun | undefined => (agent === undefined ? undefined : runs.get(agent)),
    sessionReviews: (session: string): Review[] => [...reviews.values()].filter(r => r.session === session),
    viewOf: (review: Review): ReviewView => ({
      review,
      reviewers: review.reviewers.map(entry => {
        const run = entry.agent === undefined ? undefined : runs.get(entry.agent)
        return { entry, ...(run === undefined ? {} : { run }), status: statusOf(entry) }
      }),
    }),

    /** This session's reviews from disk and their reviewers' runs, so a reload or a resume still shows them. */
    async restore(io: Io, agents: AgentsPort, session: string): Promise<void> {
      const dir = `${cacheDir}/reviews`
      if (await io.exists(dir)) {
        for (const entry of await io.list(dir)) {
          if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
          const id = entry.name.slice(0, -'.json'.length)
          if (reviews.has(id)) continue
          const review = JSON.parse(await io.read(`${dir}/${entry.name}`)) as Review
          if (review.session === session) reviews.set(id, review)
        }
      }
      const listed = await agents.list({ session })
      for (const run of listed) runs.set(run.id, run)
      // a reload while a review started can leave reviewers whose runs started but were never written into the review
      for (const review of reviews.values()) {
        if (review.session !== session) continue
        let isBound = false
        for (const entry of review.reviewers) {
          if (entry.agent !== undefined || entry.error !== undefined) continue
          const run = listed.find(r => r.group === review.id && r.label === entry.key)
          if (run === undefined) continue
          entry.agent = run.id
          isBound = true
        }
        if (isBound) await save(io, review)
      }
    },

    /** Starts every reviewer; one refused at once is reported at once. Refuses the whole review when a reviewer's work may not start. */
    async begin(io: Io, agents: AgentsPort, providers: ProvidersPort, alert: Alert, input: BeginInput): Promise<Review> {
      for (const spec of input.specs) {
        const key = await providers.modelKey({ provider: spec.provider, ...(spec.model === undefined ? {} : { model: spec.model }) })
        const { refusal } = await providers.refusal({ session: input.session, key })
        if (refusal !== null) throw new Refused(`${spec.provider}: ${refusal}`)
      }
      const { roots } = await providers.roots({ read: input.read, project: input.project })
      let change: Change | undefined
      if (input.changes !== undefined) {
        // the repository is the first read path as the call names it: the resolved roots come back sorted
        const first = input.read === 'none' ? undefined : await providers.roots({ read: input.read === 'project' ? 'project' : input.read.slice(0, 1), project: input.project })
        const repo = first?.roots[0]
        if (first === undefined || repo === undefined) throw new Refused('changes needs a read path holding the repository')
        const secretsOf = async (paths: string[]) => (await providers.secretPaths({ paths })).secret
        change = await changeOf(io, folderOf(repo, first.files), input.changes, secretsOf)
      }
      const id = await newId(io)
      const keys = keysFor(input.specs)
      const review: Review = {
        id,
        description: input.description,
        createdAt: await io.now(),
        session: input.session,
        reportDir: `${input.reportBase}/${id}-${slugOf(input.description)}`,
        roots,
        web: input.web,
        helpers: input.helpers,
        ...(change !== undefined ? { changes: change.label } : {}),
        reviewers: input.specs.map((s, i) => ({ ...s, key: keys[i]! })),
      }
      const task = taskText({ brief: input.brief, roots, web: input.web, ...(change !== undefined ? { changes: change } : {}) })
      await io.write(`${review.reportDir}/brief.md`, task)
      reviews.set(id, review)
      await save(io, review)
      await Promise.all(
        review.reviewers.map(async entry => {
          const job: AgentsJob = {
            dir: `${cacheDir}/runs/${id}/${entry.key}`,
            read: input.read,
            project: input.project,
            system: input.system,
            task,
            web: input.web,
            helpers: input.helpers,
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
            schema: FINDINGS_SCHEMA,
            // reviewers get follow-ups, often past five minutes
            cacheTtl: '1h',
            timeoutMs: input.timeoutMs,
          }
          let run: AgentsRun
          try {
            run = await agents.start({ session: input.session, provider: entry.provider, job, group: id, label: entry.key })
          } catch (err) {
            entry.error = `agents did not take it: ${err instanceof Error ? err.message : String(err)}`
            return
          }
          entry.agent = run.id
          await answered(io, alert, review, entry, run)
        }),
      )
      await save(io, review)
      return review
    },

    /** Resolves once no reviewer of the review runs. */
    whenDone(id: string): Promise<void> {
      const review = reviews.get(id)
      if (review === undefined || isDone(review)) return Promise.resolve()
      return new Promise(resolve => doneWaiters.set(id, [...(doneWaiters.get(id) ?? []), resolve]))
    },

    /** Resolves once the reviewer's agents run is no longer running. */
    whenAnswered(agent: string): Promise<void> {
      if (runs.get(agent)?.status !== 'running') return Promise.resolve()
      return new Promise(resolve => answerWaiters.set(agent, [...(answerWaiters.get(agent) ?? []), resolve]))
    },

    /** Asks a finished reviewer a follow-up; answers its agents run, running, or ended at once when refused. */
    async ask(io: Io, agents: AgentsPort, providers: ProvidersPort, alert: Alert, session: string, reviewId: string, key: string, message: string): Promise<{ review: Review; run: AgentsRun }> {
      const review = await load(io, agents, reviewId)
      const entry = review.reviewers.find(x => x.key === key)
      if (entry === undefined) throw new Refused(`review ${review.id} has no reviewer ${key}; it has ${review.reviewers.map(x => x.key).join(', ')}`)
      if (entry.agent === undefined) throw new Refused(`${key} never started: ${entry.error ?? 'its start did not finish'}`)
      const run = runs.get(entry.agent) ?? (await agents.get({ id: entry.agent }))
      if (run.status === 'running') throw new Refused(`${key} is still running`)
      const { refusal } = await providers.refusal({ session, key: run.key })
      if (refusal !== null) throw new Refused(`${entry.provider}: ${refusal}`)
      asked.set(run.id, message)
      let going: AgentsRun
      try {
        going = await agents.followUp({ session, id: run.id, message })
      } catch (err) {
        asked.delete(run.id)
        throw err
      }
      await answered(io, alert, review, entry, going)
      if (going.isRefused === true) await save(io, review)
      return { review, run: going }
    },

    async stop(agents: AgentsPort, reviewId: string, key?: string): Promise<void> {
      const review = reviews.get(reviewId)
      if (review === undefined) throw new Refused(`no review ${reviewId} in this session`)
      for (const entry of review.reviewers) {
        if (entry.agent !== undefined && statusOf(entry) === 'running' && (key === undefined || key === entry.key)) await agents.stop({ id: entry.agent })
      }
    },

    /** Takes a reviewer's run that ended; undefined for a run that is no reviewer of crew's in this load. */
    async ended(io: Io, alert: Alert, run: AgentsRun, outcome: AgentsOutcome): Promise<Review | undefined> {
      const review = run.group === undefined ? undefined : reviews.get(run.group)
      if (review === undefined) return undefined
      // an end can come before the start's answer bound the reviewer to its run
      const entry = review.reviewers.find(e => e.agent === run.id) ?? review.reviewers.find(e => e.agent === undefined && e.key === run.label)
      if (entry === undefined) throw new Error(`crew: review ${review.id} has no reviewer on agents run ${run.id}, which ended`)
      entry.agent = run.id
      endedSeen.add(endOf(run))
      runs.set(run.id, run)
      await report(io, alert, review, entry, run, outcome)
      await save(io, review)
      wake(answerWaiters, run.id)
      if (isDone(review)) wake(doneWaiters, review.id)
      return review
    },

    /** What the caller reads when the review ends: one line per reviewer, then how to go on. */
    summary(review: Review): string {
      const counts = new Map<string, number>()
      for (const e of review.reviewers) counts.set(statusOf(e), (counts.get(statusOf(e)) ?? 0) + 1)
      const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(', ')
      const lines = [`crew review ${review.id} "${review.description}": ${review.reviewers.length} reviewers, ${tally}.`]
      for (const e of review.reviewers) {
        const run = e.agent === undefined ? undefined : runs.get(e.agent)
        const status = statusOf(e)
        const loud = LOUD[status]
        const what = loud !== undefined ? `${loud}: ${e.error ?? run?.detail ?? ''}` : status === 'ok' ? `${e.findings ?? 'unparsed'} findings` : status
        const spent = run === undefined || run.costUsd === 0 ? '' : ` · ${usd(run.costUsd)}${run.isCostEstimate ? ' at most' : ''}`
        const warm = run?.cacheUntil === undefined ? '' : ` · cache warm until ${clockText(run.cacheUntil)}`
        lines.push(`- ${e.key} (${run?.usedModel ?? e.model ?? 'default'}): ${what}${spent}${warm}${e.report !== undefined ? ` → ${e.report}` : ''}`)
      }
      if (review.courier !== undefined) lines.push(`Courier alert failed: ${review.courier}`)
      lines.push(`Continue a reviewer with review_continue { run: "${review.id}", reviewer: "<key>", message }.`)
      return lines.join('\n')
    },
  }
}

export type Reviews = ReturnType<typeof makeReviews>
