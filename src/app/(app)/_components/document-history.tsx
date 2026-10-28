import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/format';
import type { HistoryEntryDto } from '@/modules/audit';

/**
 * A document's audit trail (Phase 9): who did what and when, with the field changes and the reason.
 * Request ids, IP addresses, and user agents are only in audit search.
 */
export function DocumentHistory({ entries, timezone }: { entries: readonly HistoryEntryDto[]; timezone: string }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">History</h2>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been recorded for this document.</p>
        ) : (
          <ol className="grid gap-3" aria-label="Document history">
            {entries.map((entry) => (
              <li key={entry.id} className="grid gap-1 border-l-2 pl-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs">{entry.action}</span>
                  <span className="text-muted-foreground">by {entry.actor}</span>
                  <span className="text-xs text-muted-foreground">{formatTimestamp(entry.occurredAt, timezone)}</span>
                </div>
                {entry.reason ? <p className="whitespace-pre-wrap">Reason: {entry.reason}</p> : null}
                {entry.changes.length > 0 ? (
                  <ChangeList changes={entry.changes} />
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export function ChangeList({ changes }: { changes: readonly { field: string; before: string | null; after: string | null }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-0.5 text-xs">
      {changes.map((change) => (
        <div key={change.field} className="contents">
          <dt className="font-mono text-muted-foreground">{change.field}</dt>
          <dd className="break-words">
            <span className="text-muted-foreground">{change.before ?? '—'}</span>
            {' → '}
            <span>{change.after ?? '—'}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
