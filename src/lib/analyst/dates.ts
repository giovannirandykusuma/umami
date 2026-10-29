import { subDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { AnalysisDefinition } from './definition';

export interface ResolvedRange {
  /** Canonical half-open interval [startAt, endAt) in epoch milliseconds. */
  startAt: number;
  endAt: number;
  timezone: string;
  policy: AnalysisDefinition['datePolicy'];
}

/** Local midnight of the calendar day containing `instant`, DST-safe. */
function localMidnight(instant: number, timezone: string, daysBack = 0) {
  const day = formatInTimeZone(instant, timezone, 'yyyy-MM-dd');
  // Calendar arithmetic on the wall date, not on elapsed milliseconds.
  const wall = subDays(new Date(`${day}T00:00:00Z`), daysBack)
    .toISOString()
    .slice(0, 10);
  return fromZonedTime(`${wall}T00:00:00`, timezone).getTime();
}

/** Resolves a date policy against one injected clock reading. */
export function resolveDatePolicy(
  policy: AnalysisDefinition['datePolicy'],
  timezone: string,
  now: number,
): ResolvedRange {
  if (policy.type === 'fixed')
    return { startAt: policy.startAt, endAt: policy.endAt, timezone, policy };
  const endAt = now;
  const startAt =
    policy.window === '24h'
      ? now - 24 * 60 * 60 * 1000
      : localMidnight(
          now,
          timezone,
          policy.window === 'today' ? 0 : Number.parseInt(policy.window) - 1,
        );
  return { startAt, endAt, timezone, policy };
}

/**
 * Native Umami queries use SQL `between start and end` (inclusive both ends). Adapt the
 * half-open interval by excluding the final millisecond; stored timestamps have at most
 * millisecond (PostgreSQL ingest) or second (ClickHouse) precision.
 */
export function toNativeRange(range: ResolvedRange) {
  return { startDate: new Date(range.startAt), endDate: new Date(range.endAt - 1) };
}
