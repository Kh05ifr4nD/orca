import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import {
  AGENT_SESSION_RESTART_INTERRUPTION_NOTE,
  AGENT_SESSION_RESTART_INTERRUPTION_PRESENTATION
} from '../../../../shared/agent-session-restart-interruption'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'

export function NativeChatNoticeRow({
  block,
  onLinkClick,
  allowFileUriLinks = false
}: {
  block: NativeChatTextBlock
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  if (block.presentation === 'compaction') {
    const label = translate('components.native-chat.notices.compaction', 'Context compacted')
    return (
      <div
        role="separator"
        aria-label={label}
        className="flex items-center gap-3 py-2 text-xs text-muted-foreground"
      >
        <span className="h-px flex-1 bg-border" />
        <span>{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (block.presentation === AGENT_SESSION_RESTART_INTERRUPTION_PRESENTATION) {
    return (
      <p className="mx-auto w-11/12 border-t border-border pt-2 text-center text-xs text-muted-foreground">
        {translate(
          'components.native-chat.notices.restartInterruption',
          AGENT_SESSION_RESTART_INTERRUPTION_NOTE
        )}
      </p>
    )
  }
  if (block.presentation === 'plan-document') {
    return (
      <Card className="gap-3 py-3 shadow-xs">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">
            {translate('components.native-chat.notices.plan', 'Plan')}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 text-sm leading-relaxed text-foreground">
          <CommentMarkdown
            content={block.text}
            variant="document"
            className="text-sm"
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            linkifyFilePaths={onLinkClick !== undefined}
          />
        </CardContent>
      </Card>
    )
  }
  const tone = block.tone
  const Icon =
    tone === 'warning'
      ? AlertTriangle
      : tone === 'error'
        ? AlertCircle
        : tone === 'notice'
          ? Info
          : null
  return (
    <div
      className={cn(
        'space-y-2 text-sm text-foreground',
        Icon && 'rounded-md border border-border bg-muted/20 p-3',
        tone === 'warning' && 'text-[color:var(--warning,#f59e0b)]',
        tone === 'error' && 'text-destructive',
        tone === 'notice' && 'text-muted-foreground'
      )}
    >
      <div className="flex items-start gap-2">
        {Icon ? <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        <p className="min-w-0 whitespace-pre-wrap break-words">{block.text}</p>
      </div>
      {block.providerFrame ? (
        <ProviderFrameRow
          block={block}
          summary={translate('components.native-chat.notices.details', 'Details')}
        />
      ) : null}
    </div>
  )
}
