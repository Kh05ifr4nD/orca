// Read restore decides whether a session comes back at all.
//
// A chat still in the pre-SQLite format has no `journal.db`, so the probe that
// loads one reports nothing. Reading that as "no session" is what removed these
// chats: an unpublished session is also what prunes its tab out of the saved
// workspace, so the tab is gone before anything can explain itself.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { journalDatabaseFile, journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  restoreStructuredAgentSessionRead,
  type RestoredStructuredAgentSessionRead
} from './structured-agent-session-read-restore'

const SESSION_ID = 'codex_read_restore_fixture'
const WORKSPACE_ID = 'repo-1::/tmp/workspace'

const RECORD = {
  schemaVersion: 2,
  sessionId: SESSION_ID,
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: WORKSPACE_ID,
    workspaceKind: 'git-worktree'
  },
  provider: 'codex',
  providerHandleChain: [
    {
      linkId: 'codex-1-thread-1',
      handle: { provider: 'codex', threadId: 'thread-1' },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    }
  ],
  accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
  createdAt: 1,
  updatedAt: 2,
  lease: { sessionId: SESSION_ID, runtimeKind: 'native', runtimeFence: 1 }
} as unknown as AgentSessionRecord

const store = {
  getRecord: (sessionId: string) => (sessionId === SESSION_ID ? RECORD : null)
} as unknown as AgentSessionRecordStore

let journalRoot: string
const opened: AgentSessionJournal[] = []

function sessionJournalDir(): string {
  return journalDirectoryFor(journalRoot, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID })
}

function readJournal(
  restored: Awaited<ReturnType<typeof restoreStructuredAgentSessionRead>>
): RestoredStructuredAgentSessionRead {
  if (typeof restored === 'string') {
    throw new Error(`expected a readable session, got ${restored}`)
  }
  opened.push(restored.journal)
  return restored
}

async function writeRemnant(name: string): Promise<string> {
  const dir = sessionJournalDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), '{"kind":"epoch","v":1,"seq":1}\n', 'utf8')
  return join(dir, name)
}

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-read-restore-'))
})

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
  await rm(journalRoot, { recursive: true, force: true })
})

describe('a session whose journal is still the pre-SQLite format', () => {
  it('is published, carrying the message that explains it', async () => {
    const transcript = await writeRemnant('log.jsonl')

    const restored = readJournal(
      await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)
    )

    const disclosed = restored.journal
      .snapshot()
      .items.map((entry) => (entry.body.kind === 'status' ? entry.body.text : ''))
    expect(disclosed.join('')).toContain(transcript)
    // Publishing it costs no agent process; acquisition still waits for the user.
    expect(restored.hasProviderChild).toBe(false)
  })

  it('is published for a remnant whose log is gone', async () => {
    await writeRemnant('snapshot.json')

    readJournal(await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID))
  })

  it('leaves a session with neither a journal nor a remnant to the attach that founds one', async () => {
    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).toBe('unavailable')
  })

  it('reports a session with no record as unavailable', async () => {
    await writeRemnant('log.jsonl')

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, 'unknown-session')

    expect(restored).toBe('unavailable')
  })
})

describe('a session whose journal cannot be read as it stands', () => {
  it('is unreadable when the journal file is not a database', async () => {
    const dir = sessionJournalDir()
    await mkdir(dir, { recursive: true })
    await writeFile(journalDatabaseFile(dir), 'not a sqlite database'.repeat(64), 'utf8')

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).toBe('journal-unreadable')
  })

  it('leaves damaged rows to the attach that rebuilds them, rather than calling them lost', async () => {
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: sessionJournalDir()
    })
    for (const ordinal of [1, 2]) {
      await journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `item-${ordinal}` }] },
        { fence: 1 }
      )
    }
    await journal.close()
    const db = openJournalDatabase(journalDatabaseFile(sessionJournalDir())).db
    db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(1)
    db.close()

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).toBe('unavailable')
  })
})
