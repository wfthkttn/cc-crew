import type { ProcessSpawnRequest } from 'claude-code'

import type { Io } from './io.ts'

export type Ended =
  | { kind: 'exited'; code: number | null; signal: string | null }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

export type Ran = { ended: Ended; stdout: string; stderr: string }

const STDOUT_KEEP = 8 * 1024 * 1024
const STDERR_KEEP = 64 * 1024

export type RunOptions = {
  timeoutMs: number
  signal?: AbortSignal
  /** Each complete stdout line as it arrives. */
  onLine?: (line: string) => void
}

/**
 * Runs a child to its end, its timeout or the signal, whichever comes first; the child is
 * killed in the last two cases. Keeps the first 8 MiB of stdout and the last 64 KiB of stderr.
 */
export async function run(io: Io, request: ProcessSpawnRequest, o: RunOptions): Promise<Ran> {
  const stream = io.spawn(request)
  let stdout = ''
  let stderr = ''
  let pending = ''
  let stop: (e: Ended) => void = () => {}
  const stopped = new Promise<Ended>(resolve => (stop = resolve))
  const timer = io.after(o.timeoutMs, () => stop({ kind: 'timeout' }))
  const onAbort = () => stop({ kind: 'aborted' })
  if (o.signal?.aborted) onAbort()
  o.signal?.addEventListener('abort', onAbort)
  try {
    for (;;) {
      const step = await Promise.race([stream.next(), stopped])
      if ('kind' in step) {
        await stream.return(undefined as never)
        return { ended: step, stdout, stderr }
      }
      if (step.done === true) {
        if (pending !== '') o.onLine?.(pending)
        return { ended: { kind: 'exited', code: step.value.code, signal: step.value.signal }, stdout, stderr }
      }
      const { stream: pipe, text } = step.value
      if (pipe === 'stderr') {
        stderr = (stderr + text).slice(-STDERR_KEEP)
        continue
      }
      if (stdout.length < STDOUT_KEEP) stdout += text.slice(0, STDOUT_KEEP - stdout.length)
      if (o.onLine !== undefined) {
        const lines = (pending + text).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) o.onLine(line)
      }
    }
  } finally {
    timer.cancel()
    o.signal?.removeEventListener('abort', onAbort)
  }
}

export function describeEnd(r: Ran): string {
  if (r.ended.kind === 'timeout') return 'timed out'
  if (r.ended.kind === 'aborted') return 'stopped'
  return r.ended.signal !== null ? `killed by ${r.ended.signal}` : `exit ${r.ended.code}`
}
