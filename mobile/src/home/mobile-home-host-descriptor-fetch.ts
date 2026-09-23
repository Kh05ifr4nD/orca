import { recordHostDescriptor } from '../transport/host-descriptor-store'
import { hostStatusProbe, readHostStatusGates } from '../transport/host-status-probe-operations'
import type { RpcClient } from '../transport/rpc-client'

/** Reads the descriptor once whenever this logical host connection becomes connected. */
export function fetchMobileHomeHostDescriptor(
  client: RpcClient,
  hostId: string,
  disposed: () => boolean
): void {
  void hostStatusProbe
    .request(client)
    .then((reply) => {
      const status = readHostStatusGates(reply)
      if (!disposed() && status) {
        recordHostDescriptor(hostId, {
          machineName: status.machineName?.trim() || null,
          platform: status.hostPlatform ?? null
        })
      }
    })
    .catch(() => {})
}
