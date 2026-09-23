// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatContextUsageSummary } from './native-chat-context-usage-summary'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))

const USAGE: NativeChatContextUsageSummary = {
  usedTokens: 42_000,
  windowTokens: 200_000,
  percentage: 21,
  estimated: false,
  rows: [
    { name: 'Messages', tokens: 30_000, percentage: 15 },
    { name: 'System tools', tokens: 12_000, percentage: 6 }
  ]
}

let container: HTMLDivElement
let root: Root
let composer: HTMLTextAreaElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  composer = document.createElement('textarea')
  document.body.appendChild(composer)
  composer.focus()
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function renderRing(usage = USAGE): Promise<HTMLButtonElement> {
  const { NativeChatContextUsageRing } = await import('./NativeChatContextUsageRing')
  await act(async () => root.render(<NativeChatContextUsageRing usage={usage} />))
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[data-native-chat-context-usage]'
  )
  if (!trigger) {
    throw new Error('Missing context usage ring')
  }
  return trigger
}

function card(): HTMLElement | null {
  return document.querySelector('[data-slot="popover-content"]')
}

async function dispatch(target: EventTarget, event: Event): Promise<void> {
  await act(async () => target.dispatchEvent(event))
}

// Radix restores focus a task after the card unmounts.
async function settleFocus(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

/** Returns the mousedown so a test can check the browser was told not to move focus. */
async function click(trigger: HTMLElement): Promise<MouseEvent> {
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await dispatch(trigger, press)
  await dispatch(trigger, new MouseEvent('click', { bubbles: true, cancelable: true }))
  return press
}

function pointer(type: 'pointerover' | 'pointerout', pointerType: string): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    pointerType,
    relatedTarget: type === 'pointerout' ? document.body : null
  })
}

describe('NativeChatContextUsageRing', () => {
  it('opens the breakdown on click without taking focus from the composer', async () => {
    const trigger = await renderRing()

    const press = await click(trigger)

    // Checked on the whole page so a card from any primitive would count.
    expect(document.body.textContent).toContain('42k/200k')
    expect(card()?.textContent).toContain('Messages')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(press.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(composer)
  })

  it('opens on mouse hover and closes on leave without moving focus to the ring', async () => {
    const trigger = await renderRing()
    const hoverTarget = trigger.parentElement!

    await dispatch(hoverTarget, pointer('pointerover', 'mouse'))
    expect(card()?.textContent).toContain('System tools')

    await dispatch(hoverTarget, pointer('pointerout', 'mouse'))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(card()).toBeNull()
    await settleFocus()
    expect(document.activeElement).toBe(composer)
  })

  it('stays open when a click follows the hover that opened it', async () => {
    const trigger = await renderRing()

    await dispatch(trigger.parentElement!, pointer('pointerover', 'mouse'))
    await click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(card()).not.toBeNull()
  })

  it('opens on a touch tap, whose pointer leaves before the click lands', async () => {
    const trigger = await renderRing()
    const hoverTarget = trigger.parentElement!

    await dispatch(hoverTarget, pointer('pointerover', 'touch'))
    expect(card()).toBeNull()
    await dispatch(hoverTarget, pointer('pointerout', 'touch'))
    await click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(card()?.textContent).toContain('Messages')
  })

  it('closes on Escape and leaves focus in the composer', async () => {
    const trigger = await renderRing()
    await click(trigger)
    expect(card()).not.toBeNull()

    await dispatch(
      document,
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(card()).toBeNull()
    await settleFocus()
    expect(document.activeElement).toBe(composer)
  })

  it('renders every row when the provider repeats a category name', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trigger = await renderRing({
      ...USAGE,
      rows: [
        { name: 'Tools', tokens: 20_000, percentage: 10 },
        { name: 'Tools', tokens: 10_000, percentage: 5 }
      ]
    })

    await click(trigger)

    const rows = Array.from(card()?.querySelectorAll('li') ?? [], (row) => row.textContent)
    expect(rows).toEqual(['Tools10%', 'Tools5%'])
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')
  })
})
