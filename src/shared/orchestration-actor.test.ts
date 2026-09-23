import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationActor,
  normalizeOrchestrationActor,
  parseOrchestrationActor,
  sessionOrchestrationActor
} from './orchestration-actor'

const SESSION_ID = '0b7e4c2a-5f1d-4e8a-9c3b-2d6f8a1e4b70'
const ADDRESS = `session:${SESSION_ID}`

describe('orchestration actor codec', () => {
  it('spells a session actor as its mailbox address and parses it back', () => {
    const actor = { kind: 'session', id: SESSION_ID } as const

    expect(formatOrchestrationActor(actor)).toBe(ADDRESS)
    expect(parseOrchestrationActor(ADDRESS)).toEqual(actor)
    expect(formatOrchestrationActor(parseOrchestrationActor(ADDRESS) ?? actor)).toBe(ADDRESS)
  })

  it('normalizes a bare Orca session id and its address to the same actor', () => {
    expect(normalizeOrchestrationActor(SESSION_ID)).toEqual({ kind: 'session', id: SESSION_ID })
    expect(normalizeOrchestrationActor(ADDRESS)).toEqual({ kind: 'session', id: SESSION_ID })
  })

  it('reads only the addressed spelling when parsing a stored value', () => {
    // A bare id in a stored column or a recipient slot is not an actor; only input may be bare.
    expect(parseOrchestrationActor(SESSION_ID)).toBeNull()
    expect(parseOrchestrationActor(null)).toBeNull()
    expect(parseOrchestrationActor(undefined)).toBeNull()
    expect(parseOrchestrationActor('')).toBeNull()
  })

  it.each([
    ['an unknown kind', `pane:${SESSION_ID}`],
    ['the Run mailbox namespace', 'run:run_123'],
    ['the Dispatch mailbox namespace', 'dispatch:ctx_123'],
    ['an empty kind', `:${SESSION_ID}`],
    ['an empty id', 'session:'],
    ['an id with a separator', `session:${SESSION_ID}:extra`],
    ['an id the session predicate rejects', 'session:short'],
    ['a terminal handle', 'term_4f2c9a']
  ])('refuses %s', (_label, value) => {
    expect(parseOrchestrationActor(value)).toBeNull()
  })

  it.each([
    ['a PTY terminal handle', 'term_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c'],
    ['a short PTY terminal handle', 'term_4f2c9a'],
    ['a structured-worker handle', 'structworker_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c']
  ])('never turns %s into a session actor', (_label, handle) => {
    // Handles share the session-id charset, so the predicate alone would accept them.
    expect(normalizeOrchestrationActor(handle)).toBeNull()
    expect(sessionOrchestrationActor(handle)).toBeNull()
    expect(parseOrchestrationActor(`session:${handle}`)).toBeNull()
  })

  it('validates a session id with the session-record predicate', () => {
    expect(sessionOrchestrationActor(SESSION_ID)).toEqual({ kind: 'session', id: SESSION_ID })
    expect(sessionOrchestrationActor('has space in it')).toBeNull()
    expect(sessionOrchestrationActor('x'.repeat(129))).toBeNull()
    expect(normalizeOrchestrationActor('session:has space in it')).toBeNull()
    expect(normalizeOrchestrationActor('has space in it')).toBeNull()
  })
})
