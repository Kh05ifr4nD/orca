// Which Orca process run granted a lease. Persisted on the lease, so the shape is permanent.

/**
 * The Orca process run that granted a lease `fence`. A native owner is that run's child, so the
 * owner ended with the run once the run itself is gone. `machine` scopes `pid` to one pid space.
 */
export type AgentSessionOwnerHostRun = {
  runId: string
  pid: number
  machine: string
  fence: number
}

const MAX_TEXT_LENGTH = 512

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
}

export function isAgentSessionOwnerHostRun(value: unknown): value is AgentSessionOwnerHostRun {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runId' in value) ||
    !('pid' in value) ||
    !('machine' in value) ||
    !('fence' in value)
  ) {
    return false
  }
  return (
    isBoundedText(value.runId) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    isBoundedText(value.machine) &&
    typeof value.fence === 'number' &&
    Number.isSafeInteger(value.fence) &&
    value.fence >= 0
  )
}
