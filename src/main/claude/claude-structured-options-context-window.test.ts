import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { journal } from './claude-context-usage-test-support'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import {
  restoreClaudeStructuredSessionOptions,
  setClaudeStructuredOption
} from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'

function ringSession(catalog: unknown[] = []) {
  const session = sessionFor()
  const setModel = vi.fn<ClaudeSession['connection']['setModel']>(async () => undefined)
  const setPermissionMode = vi.fn<ClaudeSession['connection']['setPermissionMode']>(
    async () => undefined
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every connection member a model or permission-mode write and its catalog read call.
  session.connection = {
    ...session.connection,
    setModel,
    setPermissionMode,
    supportedModels: async () => catalog
  } as ClaudeSession['connection']
  const translator = createClaudeJournalTranslator({ sink: journal().sink, coalesceMs: 0 })
  const modelMayHaveChanged = vi.spyOn(translator, 'modelMayHaveChanged')
  session.translator = translator
  const write = (key: string, value: string) =>
    setClaudeStructuredOption(session, { key, value }, undefined)
  return { session, setModel, modelMayHaveChanged, write }
}

describe('the context ring after a session option write', () => {
  it('asks for the new window after a model or permission-mode write that changes the value', async () => {
    const s = ringSession()
    await s.write('model', 'sonnet')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(1)
    await s.write('model', 'sonnet[1m]')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(2)
    await s.write('permissionMode', 'plan')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(3)
    await s.write('permissionMode', 'default')
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(4)
  })

  it('leaves the ring alone for a write that keeps the value or that the child refuses', async () => {
    const s = ringSession()
    s.session.options.set('model', 'opusplan')
    s.session.options.set('permissionMode', 'plan')
    await s.write('model', 'opusplan')
    await s.write('permissionMode', 'plan')
    s.setModel.mockRejectedValueOnce(new ClaudeControlRequestError('set_model', 'refused'))
    await expect(s.write('model', 'haiku')).rejects.toThrow()
    expect(s.modelMayHaveChanged).not.toHaveBeenCalled()
  })

  it('keeps the ring through a restore that changes nothing', async () => {
    const s = ringSession()
    s.session.options.set('model', 'opusplan')
    s.session.options.set('permissionMode', 'plan')
    await restoreClaudeStructuredSessionOptions(s.session, undefined)
    expect(s.setModel).toHaveBeenCalledWith('opusplan', { timeoutMs: undefined })
    expect(s.modelMayHaveChanged).not.toHaveBeenCalled()
  })

  it('asks for the new window when a restore cannot put the stored model back', async () => {
    const s = ringSession([{ value: 'sonnet', displayName: 'Sonnet' }])
    s.session.options.set('model', 'retired-model')
    await restoreClaudeStructuredSessionOptions(s.session, undefined)
    expect(s.session.restoreSkippedOptions).toEqual(new Set(['model']))
    expect(s.modelMayHaveChanged).toHaveBeenCalledTimes(1)
  })
})
