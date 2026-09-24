import type {
  ClaudeChildExitVerdict,
  ClaudeStreamJsonConnection
} from './claude-stream-json-connection'

/** Each retry re-runs the connection's own close ladder, which re-verifies its snapshot. */
export const CLAUDE_RELEASED_CHILD_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000]

export type ClaudeReleasedChildCleanupReport = {
  sessionId: string
  pid: number | undefined
  verdict: ClaudeChildExitVerdict
}

type PendingCleanup = {
  sessionId: string
  attempts: number
  timer: ReturnType<typeof setTimeout> | undefined
}

function reportUnverifiedChild(report: ClaudeReleasedChildCleanupReport): void {
  console.warn('[claude-structured-session] released child tree was not verified gone', report)
}

function treeProven(verdict: ClaudeChildExitVerdict): boolean {
  return verdict.root === 'processless' || (verdict.root === 'exited' && verdict.tree === 'exited')
}

/**
 * Descendant verification for children whose lease the host already released. It is keyed by
 * connection and nothing consults it before acquiring, so it can never gate a resume. It gives up
 * after a fixed schedule and reports what it last observed, never claiming the tree gone.
 */
export class ClaudeReleasedChildCleanup {
  private readonly pending = new Map<ClaudeStreamJsonConnection, PendingCleanup>()
  private closed = false
  private readonly retryDelaysMs: readonly number[]
  private readonly report: (report: ClaudeReleasedChildCleanupReport) => void

  constructor(
    options: {
      retryDelaysMs?: readonly number[]
      report?: (report: ClaudeReleasedChildCleanupReport) => void
    } = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? CLAUDE_RELEASED_CHILD_RETRY_DELAYS_MS
    this.report = options.report ?? reportUnverifiedChild
  }

  get size(): number {
    return this.pending.size
  }

  adopt(sessionId: string, connection: ClaudeStreamJsonConnection): void {
    if (this.pending.has(connection) || treeProven(connection.exitVerdict)) {
      return
    }
    const entry: PendingCleanup = { sessionId, attempts: 0, timer: undefined }
    if (this.closed) {
      // Shutdown already ran its final pass; this child still gets exactly one.
      void this.finalAttempt(connection, entry)
      return
    }
    this.pending.set(connection, entry)
    this.schedule(connection, entry)
  }

  /** One last bounded attempt per child, then report whatever stays unverified. Never throws. */
  async closeAll(): Promise<void> {
    this.closed = true
    const entries = [...this.pending]
    this.pending.clear()
    await Promise.all(
      entries.map(([connection, entry]) => {
        clearTimeout(entry.timer)
        return this.finalAttempt(connection, entry)
      })
    )
  }

  private schedule(connection: ClaudeStreamJsonConnection, entry: PendingCleanup): void {
    const delay = this.retryDelaysMs[entry.attempts]
    if (delay === undefined) {
      this.pending.delete(connection)
      this.reportUnverified(connection, entry)
      return
    }
    entry.timer = setTimeout(() => void this.attempt(connection, entry), delay)
    entry.timer.unref?.()
  }

  private async attempt(
    connection: ClaudeStreamJsonConnection,
    entry: PendingCleanup
  ): Promise<void> {
    entry.timer = undefined
    entry.attempts += 1
    const proven = await connection.close().catch(() => false)
    if (this.pending.get(connection) !== entry) {
      return
    }
    if (proven) {
      this.pending.delete(connection)
      return
    }
    this.schedule(connection, entry)
  }

  private async finalAttempt(
    connection: ClaudeStreamJsonConnection,
    entry: PendingCleanup
  ): Promise<void> {
    if (!(await connection.close().catch(() => false))) {
      this.reportUnverified(connection, entry)
    }
  }

  private reportUnverified(connection: ClaudeStreamJsonConnection, entry: PendingCleanup): void {
    try {
      this.report({
        sessionId: entry.sessionId,
        pid: connection.pid,
        verdict: connection.exitVerdict
      })
    } catch {
      // Reporting is bookkeeping; a failed report must not surface as a close failure.
    }
  }
}
