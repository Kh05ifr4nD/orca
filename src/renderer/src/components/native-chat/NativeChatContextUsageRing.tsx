import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  formatContextTokenCount,
  type NativeChatContextUsageSummary
} from './native-chat-context-usage-summary'

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** Past this the window is nearly spent; the ring turns destructive to say so. */
const CRITICAL_PERCENTAGE = 90

/** A quiet ring beside the send button: how much of the context window the
 *  session has used, with the provider's breakdown on hover. */
export function NativeChatContextUsageRing({
  usage
}: {
  usage: NativeChatContextUsageSummary
}): React.JSX.Element {
  const filled = Math.min(Math.max(usage.percentage, 0), 100)
  const critical = usage.percentage >= CRITICAL_PERCENTAGE
  const used = formatContextTokenCount(usage.usedTokens)
  const window = formatContextTokenCount(usage.windowTokens)
  const label = translate(
    'components.native-chat.contextUsage.label',
    'Context {{used}} of {{window}} tokens, {{percent}}% used',
    { used, window, percent: String(usage.percentage) }
  )
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-native-chat-context-usage={usage.percentage}
          data-native-chat-context-usage-estimated={usage.estimated ? 'true' : undefined}
          className={cn(
            'flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11',
            critical && 'text-destructive'
          )}
        >
          <svg
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            aria-hidden="true"
            className="-rotate-90"
          >
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              className="opacity-25"
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - filled / 100)}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" sideOffset={8} className="w-72">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-foreground">
            {translate('components.native-chat.contextUsage.title', 'Context')}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {used}/{window}
          </span>
        </div>
        <Progress value={filled} aria-label={label} className="mt-2 h-1.5" />
        {usage.rows.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs">
            {usage.rows.map((row) => (
              <li key={row.name} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-foreground">{row.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {row.percentage}%
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {usage.estimated ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {translate(
              'components.native-chat.contextUsage.estimated',
              'Estimated from the last response.'
            )}
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  )
}
