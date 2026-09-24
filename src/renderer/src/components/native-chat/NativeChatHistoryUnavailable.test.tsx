// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { NativeChatHistoryUnavailable } from './NativeChatHistoryUnavailable'

describe('NativeChatHistoryUnavailable', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('explains the missing history in neutral terms and closes its own tab', () => {
    const closeUnifiedTab = vi.fn(() => null)
    useAppStore.setState({ closeUnifiedTab })

    render(<NativeChatHistoryUnavailable tabId="agent-session:lost" />)

    expect(screen.getByText("This conversation's history couldn't be loaded")).toBeTruthy()
    expect(screen.getByText('The saved history for this chat is missing or damaged.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(closeUnifiedTab).toHaveBeenCalledWith('agent-session:lost')
  })
})
