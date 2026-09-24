import { randomUUID } from 'node:crypto'
import { currentAgentSessionHostRun, type AgentSessionHostRun } from './agent-session-host-run'

/** The next app run on this machine; it reuses this pid, as a restarted container's pid 1 does. */
export async function restartedAgentSessionHostRun(): Promise<AgentSessionHostRun> {
  return { ...(await currentAgentSessionHostRun()), runId: randomUUID() }
}
