// The child-work edges the task tracker decided, held until the adapter drains them after the
// journal handled the frame, and which children a pending permission request blocks.

import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { pendingClaudeTaskLive, type ClaudePendingChildWork } from './claude-child-work-evidence'
import type { TrackedClaudeBackgroundTask } from './claude-settled-background-tasks'

export class ClaudeChildWorkQueue {
  private readonly edges: ClaudePendingChildWork[] = []
  /** The children last seen blocked on a pending request. */
  private waiting: ReadonlySet<string> = new Set()

  push(...edges: ClaudePendingChildWork[]): void {
    this.edges.push(...edges)
  }

  /** Which children a pending request blocks, re-derived by the caller before every drain. A child
   *  that starts or stops waiting is a live edge of its own: no task frame says so. */
  observeWaiting(
    waiting: ReadonlySet<string>,
    runOf: (id: string) => TrackedClaudeBackgroundTask | undefined
  ): void {
    for (const id of new Set([...this.waiting, ...waiting])) {
      const run = runOf(id)
      if (run && this.waiting.has(id) !== waiting.has(id)) {
        this.edges.push(pendingClaudeTaskLive(id, run))
      }
    }
    this.waiting = waiting
  }

  /** The edges queued since the last drain, stamped with the host clock of the caller. */
  drain(observedAt: number): AgentChildWorkEvidence[] {
    return this.edges.splice(0).map((edge) => edge(observedAt))
  }
}
