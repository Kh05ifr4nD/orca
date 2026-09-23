import {
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

function traceE2EInput(
  stage: string,
  stream: TerminalMultiplexStream,
  details: Record<string, unknown>
): void {
  if (process.env.ORCA_E2E_FORWARD_APP_LOGS !== '1') {
    return
  }
  console.info(
    `[paired-input-host] ${JSON.stringify({ stage, streamId: stream.streamId, terminal: stream.terminal, ...details })}`
  )
}

export function handleMultiplexInputFrame(
  state: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  payload: TerminalStreamFrame['payload']
): void {
  const text = decodeTerminalStreamText(payload)
  if (!text) {
    return
  }
  const { runtime } = state
  const locked = isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)
  traceE2EInput('frame', stream, { length: text.length, locked })
  if (locked) {
    return
  }
  // Mobile already has the higher-priority floor, so a rejected desktop claim must not suppress later phone input.
  const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
  void inputClaimTail.then(async (claimed) => {
    const lockedAfterClaim = isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)
    traceE2EInput('claim', stream, { claimed, locked: lockedAfterClaim })
    if (!claimed || lockedAfterClaim) {
      return
    }
    const outcome = await sendTerminalStreamInput(runtime, {
      terminal: stream.terminal,
      text,
      client: stream.client,
      isMobile: stream.isMobile
    })
    traceE2EInput('write', stream, { outcome })
    state.notifyStreamWriteUnavailable(stream, outcome)
  })
}
