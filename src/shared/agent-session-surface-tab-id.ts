const MAX_SURFACE_TAB_ID_LENGTH = 512

/**
 * The id of the tab that shows a structured chat, as the host records it. Colon-free because it
 * prefixes every pane key built for the chat (`makePaneKey` refuses `:`); bounded like a terminal
 * tab id, which is what it is on the wire.
 */
export function isAgentSessionSurfaceTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SURFACE_TAB_ID_LENGTH &&
    !value.includes(':')
  )
}
