// The restart-resume safety rules, stated as refusals.
//
// Every negative case here is a session that MUST NOT get a provider child back. Resuming one that
// was not working spends the user's tokens and can make an agent redo destructive work it already
// finished; missing one is an annoyance. Each test removes exactly one input from an otherwise
// resumable session, so deleting the matching guard turns that test red.

import { describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_RESUME_MARKER_TTL_MS } from '../../../shared/agent-session-resume-marker'
import { structuredAgentSessionResumableSet } from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission,
  STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY,
  STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS
} from './structured-agent-session-restart-resume-runner'
import { structuredAgentSessionWorkingAtStop } from './structured-agent-session-working-at-teardown'
import {
  CLAUDE_ROOT,
  claudeRecord,
  HANDLE_ROOT,
  journal,
  TEARDOWN_CURRENT,
  marker,
  NOW,
  pendingApproval,
  record,
  resumableSet,
  SESSION,
  submission,
  turnItem
} from './structured-agent-session-restart-resume-test-harness'

type StopInput = Parameters<typeof structuredAgentSessionWorkingAtStop>[0]

/** The snapshot each session's stop would take, over every session in the map. */
function markersAtTeardown(
  input: Omit<StopInput, 'sessionId' | 'session'> & {
    sessions: ReadonlyMap<string, NonNullable<StopInput['session']>>
  }
) {
  return [...input.sessions].flatMap(([sessionId, session]) => {
    const recorded = structuredAgentSessionWorkingAtStop({ ...input, sessionId, session })
    return recorded ? [recorded] : []
  })
}

describe('deriving what was working at teardown', () => {
  it('marks a session this host was running a turn for', () => {
    const markers = markersAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
      ]),
      getRecord: () => record(),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers).toEqual([
      {
        sessionId: SESSION,
        work: { kind: 'turn', id: 'turn-1' },
        recordedAt: NOW,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        providerHandleRoot: HANDLE_ROOT,
        latestUserItemId: null,
        journalCursor: { epoch: 'epoch-1', sequence: 1 }
      }
    ])
  })

  it('carries the update trigger so the surface can say the restart was not the user choice', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
      ]),
      getRecord: () => record(),
      backgroundTasks: () => undefined,
      trigger: 'update',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.trigger).toBe('update')
  })

  it('marks nothing for an idle session', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([[SESSION, { journal: journal([]), hasProviderChild: true }]]),
        getRecord: () => record(),
        backgroundTasks: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('marks nothing for a turn that completed before the quit', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'completed')]), hasProviderChild: true }]
        ]),
        getRecord: () => record(),
        backgroundTasks: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // The user's stated fear. A journal restored for READING carries whatever `running` row an older
  // crash left behind, and it is the live `hasProviderChild` — not that row — that decides.
  it('marks nothing for a stale running row this host was not executing', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: false }]
        ]),
        getRecord: () => record(),
        backgroundTasks: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // The sidebar shows a chat blocked on the user as needing attention, and teardown cancels the
  // prompt, so the chat is owed a resume that says which prompt it lost.
  it('marks a turn that is waiting on the user', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running'), pendingApproval()]),
            hasProviderChild: true
          }
        ]
      ]),
      getRecord: () => record(),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'turn', id: 'turn-1' })
  })

  // What the user hit: the lead had finished, its subagents had not, and the sidebar said working.
  it('marks a settled lead whose subagent was still running, anchored on its last turn', () => {
    const markers = markersAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'completed')]), hasProviderChild: true }]
      ]),
      getRecord: () => record(),
      backgroundTasks: () => [
        { id: 'task-a', kind: 'agent', description: 'Review loop 4', state: 'working' }
      ],
      trigger: 'update',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers.map((entry) => entry.work)).toEqual([{ kind: 'turn', id: 'turn-1' }])
  })

  it('marks a settled lead whose only live work is a monitor', () => {
    const markers = markersAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'completed')]), hasProviderChild: true }]
      ]),
      getRecord: () => record(),
      backgroundTasks: () => [{ id: 'task-m', kind: 'monitor', name: 'ci-watch' }],
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers).toHaveLength(1)
  })

  // A settled task is history, not work the sidebar showed as running.
  it('marks nothing for a settled lead whose tasks have all finished', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'completed')]), hasProviderChild: true }]
        ]),
        getRecord: () => record(),
        backgroundTasks: () => [
          { id: 'task-a', kind: 'agent', state: 'done' },
          { id: 'task-b', kind: 'command', state: 'idle' }
        ],
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Root, not key: a key would embed Claude's leaf, which the close path advances moments later.
  it('records the identity root so an advancing Claude leaf cannot invalidate the marker', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
      ]),
      getRecord: () => claudeRecord(null),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.providerHandleRoot).toBe(CLAUDE_ROOT)
  })

  it('marks nothing for a session that never proved a provider cursor', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
        ]),
        getRecord: () => record({ chain: [] }),
        backgroundTasks: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Codex declares a turn in about 150ms; Claude cannot write one until the SDK echoes the user
  // message back, which is seconds on a real journal. A turn-id-only marker drops exactly those
  // sessions — the ones that were working hardest — so the send carries its own identity.
  it('records the submission identity for a send the provider has not echoed yet', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([], false, [submission('msg-1', 'pending')]),
            hasProviderChild: true
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  // The send the user made just before quitting, after an earlier exchange had finished: the
  // sidebar shows it working, so it is offered, whatever the finished turn before it says.
  it('marks a send the provider had not opened a turn for, after an earlier completed turn', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-0', 'completed')], false, [
              submission('msg-1', 'pending')
            ]),
            hasProviderChild: true
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  // Once a turn exists it is the better identity: it is what eviction rewrites, so it is what the
  // journal can be asked about at launch.
  it('prefers the running turn over the send that opened it', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running')], false, [
              submission('msg-1', 'accepted')
            ]),
            hasProviderChild: true
          }
        ]
      ]),
      getRecord: () => record(),
      backgroundTasks: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'turn', id: 'turn-1' })
  })
})

describe('the resumable set', () => {
  it('offers a genuinely working session exactly once', () => {
    const candidates = resumableSet({ markers: [marker()] })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      sessionId: SESSION,
      work: { kind: 'turn', id: 'turn-1' },
      trigger: 'quit',
      latestPrompt: 'fix the auth bug'
    })
  })

  // No marker means no teardown ever observed this session working, whatever its journal says.
  it('offers nothing for a stale running row with no marker', () => {
    expect(resumableSet({ markers: [], items: [turnItem('turn-1', 'running')] })).toEqual([])
  })

  it('refuses when the session has no resume cursor', () => {
    expect(resumableSet({ markers: [marker()], chain: [] })).toEqual([])
  })

  // A cursor that moved since teardown is a different conversation than the one we marked.
  it('refuses when the resume cursor drifted after the marker was written', () => {
    expect(
      resumableSet({ markers: [marker({ providerHandleRoot: 'codex:"other-thread"' })] })
    ).toEqual([])
  })

  // The defect QA found: the SAME teardown's close path appends a `resumed` link with an advanced
  // leaf, so a key comparison goes stale ~1.4s after the marker is written and Claude is refused
  // forever. A resume that advances the leaf is continuity, not a fork.
  it('still offers a Claude session whose leaf advanced after the marker was written', () => {
    const candidates = structuredAgentSessionResumableSet({
      markers: [marker({ providerHandleRoot: CLAUDE_ROOT })],
      getRecord: () => claudeRecord('5aed93d6-advanced-leaf'),
      supportsRecord: () => true,
      activity: () => undefined,
      latestPrompt: () => '',
      latestUserItemId: () => null,
      now: NOW
    })

    expect(candidates).toHaveLength(1)
  })

  it('refuses a Claude session that forked to a different identity root', () => {
    expect(
      structuredAgentSessionResumableSet({
        markers: [marker({ providerHandleRoot: CLAUDE_ROOT })],
        getRecord: () => claudeRecord(null, 'prov-session-2'),
        supportsRecord: () => true,
        activity: () => undefined,
        latestPrompt: () => '',
        latestUserItemId: () => null,
        now: NOW
      })
    ).toEqual([])
  })

  it('refuses a marker that has outlived its expiry', () => {
    expect(
      resumableSet({ markers: [marker()], now: NOW + AGENT_SESSION_RESUME_MARKER_TTL_MS + 1 })
    ).toEqual([])
  })

  // The user moving on is what withdraws an offer.
  it('refuses once the user has sent a newer message', () => {
    expect(resumableSet({ markers: [marker()], latestUserItemId: 'user-newer' })).toEqual([])
  })

  // Teardown already judged the chat working; what the journal says after the restart — a turn
  // the provider closed or opened on its own, a prompt it asks — does not re-judge it.
  it.each([
    ['its turn completed', [turnItem('turn-1', 'completed')]],
    [
      'a provider turn is running',
      [turnItem('turn-1', 'interrupted'), turnItem('wake', 'running')]
    ],
    ['the provider asks the user', [turnItem('turn-1', 'interrupted'), pendingApproval()]],
    ['the journal holds no turn', []]
  ])('still offers the marked chat when %s', (_label, items) => {
    expect(resumableSet({ markers: [marker()], items })).toHaveLength(1)
  })

  it('offers a send that never became a turn', () => {
    const candidates = resumableSet({
      markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
      items: []
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  // A marker from a build that recorded only a working lead has no journal position to read from.
  it('offers a marker with no journal cursor, with no activity to name', () => {
    const [candidate] = resumableSet({ markers: [marker()] })

    expect(candidate).toBeDefined()
    expect(candidate).not.toHaveProperty('activity')
  })
})

describe('spending a marker', () => {
  function runner(overrides: { resume?: () => Promise<void>; concurrency?: number } = {}) {
    const consumed = new Set<string>()
    const resume = overrides.resume ?? vi.fn(async () => {})
    return {
      resume,
      consumed,
      deps: {
        admission: new StructuredAgentSessionResumeAdmission(),
        // Stands in for the durable store: the first caller spends it, later ones find it gone.
        consumeMarker: async (sessionId: string) => {
          if (consumed.has(sessionId)) {
            return false
          }
          consumed.add(sessionId)
          return true
        },
        resume,
        ...(overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency })
      }
    }
  }

  const candidate = (sessionId: string) => ({
    sessionId,
    workspaceId: 'workspace-1',
    agent: 'codex' as const,
    work: { kind: 'turn' as const, id: 'turn-1' },
    trigger: 'quit' as const,
    recordedAt: NOW,
    latestPrompt: '',
    executionHostId: 'local' as const,
    workspaceKind: 'git-worktree' as const
  })

  it('resumes a candidate once and reports it', async () => {
    const { deps, resume } = runner()

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'banner'
    )

    expect(outcomes).toEqual([{ sessionId: SESSION, outcome: 'resumed' }])
    expect(resume).toHaveBeenCalledOnce()
  })

  // A second relaunch finds the marker already spent; nothing may run again.
  it('refuses a marker a previous launch already consumed', async () => {
    const { deps, resume } = runner()
    await resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'first-launch')

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'second-launch'
    )

    expect(outcomes).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'agent_session_resume_not_eligible' }
    ])
    expect(resume).toHaveBeenCalledOnce()
  })

  it('spends the marker before it submits, so a crash mid-resume cannot double-fire', async () => {
    const order: string[] = []
    const { deps, consumed } = runner({
      resume: async () => {
        order.push(`consumed:${consumed.has(SESSION)}`)
        throw new Error('provider died mid-resume')
      }
    })

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'banner'
    )

    expect(order).toEqual(['consumed:true'])
    expect(outcomes[0]).toMatchObject({ outcome: 'refused' })
    // Still spent after the failure: the next launch must not retry it on its own.
    expect(consumed.has(SESSION)).toBe(true)
  })

  it('refuses a second concurrent resume and names the live owner', async () => {
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps } = runner({ resume: () => blocked })

    const first = resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'banner')
    await vi.waitFor(() => expect(deps.admission.liveOwner(SESSION)).toBe('banner'))
    const second = await resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'row')
    release()
    await first

    expect(second).toEqual([
      {
        sessionId: SESSION,
        outcome: 'refused',
        reason: STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS,
        owner: 'banner'
      }
    ])
  })

  it('staggers instead of starting every provider at once', async () => {
    let live = 0
    let peak = 0
    const { deps } = runner({
      resume: async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((resolve) => setTimeout(resolve, 5))
        live -= 1
      }
    })
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`session-staggered-${index}`)
    )

    const outcomes = await resumeStructuredAgentSessionsFromRestart(deps, candidates, 'banner')

    // Unbounded fan-out would peak at all 12 — which is the spawn storm this exists to prevent.
    expect(peak).toBe(STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY)
    expect(outcomes).toHaveLength(candidates.length)
  })
})
