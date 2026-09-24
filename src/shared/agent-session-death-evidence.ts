// Why a lease owner is known to be gone. Persisted on the lease, so every kind is permanent.

/** `previous-app-run`: a native owner is a child of the app run that spawned it, so a restart
 *  records its death without a process probe. */
export type AgentSessionDeathEvidenceKind =
  | 'exit-observed'
  | 'pid-absent'
  | 'identity-mismatch'
  | 'previous-app-run'

export type AgentSessionDeathEvidence = {
  /** Open so a kind written by a newer build loads intact instead of quarantining its record;
   *  readers act only on the kinds they know. */
  kind: AgentSessionDeathEvidenceKind | (string & {})
  detail: string
  observedAt: number
}

const MAX_EVIDENCE_TEXT_LENGTH = 512

function isEvidenceText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EVIDENCE_TEXT_LENGTH
}

export function isAgentSessionDeathEvidence(value: unknown): value is AgentSessionDeathEvidence {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    !('detail' in value) ||
    !('observedAt' in value)
  ) {
    return false
  }
  return (
    isEvidenceText(value.kind) &&
    isEvidenceText(value.detail) &&
    typeof value.observedAt === 'number' &&
    Number.isSafeInteger(value.observedAt) &&
    value.observedAt >= 0
  )
}
