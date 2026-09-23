import { afterEach, describe, expect, it } from 'vitest'
import { sessionOrchestrationActor } from '../../../../../shared/orchestration-actor'
import { mintStructuredWorkerHandle } from '../../../structured-worker-identity'
import { OrchestrationDb } from '../orchestration-db'

const EARLIER_ACTOR = 'session:7d9f1b3e-5a2c-4e6b-8f0a-1c3e5a7b9d42'
const WORKER_PANE = 'tab_worker:88888888-8888-4888-8888-888888888888'

describe('assignee identity writers', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  /** A starting Dispatch whose row already names an actor, standing in for any earlier writer. */
  function startingDispatchWithActor(target: OrchestrationDb): string {
    const task = target.createTask({ runId: 'run_legacy_local', spec: 'worker' })
    const started = target.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    target.db
      .prepare('UPDATE dispatch_contexts SET assignee_actor = ? WHERE id = ?')
      .run(EARLIER_ACTOR, started.dispatch.id)
    return started.dispatch.id
  }

  it('clears the actor when worker authority names the assignee', () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = startingDispatchWithActor(db)

    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'pty_proc_9c1d:31',
      worktreeId: 'wt_1',
      setupState: 'not_applicable',
      effects: []
    })

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: 'term_worker',
      assignee_actor: null
    })
  })

  it('clears the actor when a failed start records the terminal it owned', () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = startingDispatchWithActor(db)
    db.recordCreatedWorkerTerminalCustody({
      dispatchId,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'pty_proc_9c1d:31',
      worktreeId: 'wt_1'
    })
    db.recordWorkerStage({ dispatchId, stage: 'agent_readiness', terminalHandle: 'term_worker' })

    db.failWorkerStart(dispatchId, 'agent_readiness', 'agent never became ready')

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: 'term_worker',
      assignee_actor: null
    })
  })

  it('refuses a minted structured-worker handle as a session id', () => {
    // Ties the codec's handle-prefix refusal to the handle this runtime actually mints.
    expect(sessionOrchestrationActor(mintStructuredWorkerHandle())).toBeNull()
  })
})
