import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../../shared/agent-lead-status-fold'
import { agentChildWorkLivenessFromEvidence } from '../../../shared/agent-status-child-work-liveness'
import type { AgentStatusState, AgentSubagentSnapshot } from '../../../shared/agent-status-types'

type RowChildWork = Pick<AgentHookEventPayload, 'claudeRunningNonAgentTask'> & {
  payload: { subagents?: readonly AgentSubagentSnapshot[] }
}

/** Fold a main agent state with the child work a row itself carries: its subagent snapshots and the
 *  shell/cron fact restated beside them. For a relayed pane that is all the desktop can see, because
 *  the provider records live on the relay. */
export function foldMainAgentWithRowChildWork(
  leadState: AgentStatusState,
  row: RowChildWork
): AgentLeadStatusResolution {
  return foldAgentLeadStatus({
    leadState,
    childWorkLiveness: agentChildWorkLivenessFromEvidence({
      hasLiveAgentWork: row.payload.subagents?.some((child) => child.state === 'working') === true,
      hasLiveNonAgentWork: row.claudeRunningNonAgentTask === true
    })
  })
}
