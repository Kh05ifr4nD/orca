import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { NativeChatEmptyState } from './NativeChatEmptyState'

/** A restored chat whose journal file is unusable keeps its tab and says so here. */
export function NativeChatHistoryUnavailable({ tabId }: { tabId: string }): React.JSX.Element {
  return (
    <NativeChatEmptyState
      kind="history-unavailable"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => useAppStore.getState().closeUnifiedTab(tabId)}
        >
          {translate('components.native-chat.state.historyUnavailable.closeTab', 'Close tab')}
        </Button>
      }
    />
  )
}
