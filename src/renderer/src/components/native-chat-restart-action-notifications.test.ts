import { toast } from 'sonner'
import { beforeEach, expect, it, vi } from 'vitest'
import { announceRestartResults } from './native-chat-restart-action-notifications'

vi.mock('sonner', () => ({ toast: vi.fn() }))

const actions = { show: vi.fn(), dismiss: vi.fn() }
const refusedBoth = [
  { sessionId: 'a', outcome: 'refused' as const },
  { sessionId: 'b', outcome: 'refused' as const }
]

beforeEach(() => vi.mocked(toast).mockClear())

// `b` finished on its own, or the user already answered it: the host no longer lists it, so the
// notice must not count a failure the list it opens cannot show.
it('counts only the requested chats the host still lists as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, ['a'], actions)
  expect(vi.mocked(toast).mock.calls.map(([text]) => text)).toEqual(['1 chat couldn’t be resumed'])
})

it('says nothing when the host lists none of them as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [], actions)
  expect(toast).not.toHaveBeenCalled()
})

it('counts every chat not carried on when an older host sends no failure list', () => {
  announceRestartResults(['a', 'b'], refusedBoth, undefined, actions)
  expect(vi.mocked(toast).mock.calls.map(([text]) => text)).toEqual(['2 chats couldn’t be resumed'])
})
