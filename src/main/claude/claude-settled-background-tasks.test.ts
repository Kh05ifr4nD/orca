import { describe, expect, it } from 'vitest'
import {
  makeRoomForClaudeTask,
  type TrackedClaudeBackgroundTask
} from './claude-settled-background-tasks'

function task(backgrounded: boolean): TrackedClaudeBackgroundTask {
  return { backgrounded, liveInTurn: true, kind: 'agent', startedAt: 1 }
}

describe('makeRoomForClaudeTask', () => {
  it('has room below capacity and for a task it already tracks', () => {
    const tasks = new Map([['a', task(true)]])
    expect(makeRoomForClaudeTask(tasks, 'b', 2)).toBe(true)
    expect(makeRoomForClaudeTask(tasks, 'a', 1)).toBe(true)
    expect([...tasks.keys()]).toEqual(['a'])
  })

  it('lets the oldest foreground task give way at capacity', () => {
    const tasks = new Map([
      ['bg', task(true)],
      ['fg-old', task(false)],
      ['fg-new', task(false)]
    ])
    expect(makeRoomForClaudeTask(tasks, 'next', 3)).toBe(true)
    expect([...tasks.keys()]).toEqual(['bg', 'fg-new'])
  })

  it('tracks nothing new when only background tasks fill it', () => {
    const tasks = new Map([
      ['bg-1', task(true)],
      ['bg-2', task(true)]
    ])
    expect(makeRoomForClaudeTask(tasks, 'next', 2)).toBe(false)
    expect([...tasks.keys()]).toEqual(['bg-1', 'bg-2'])
  })
})
