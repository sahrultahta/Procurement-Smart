# Operating ProcureFlow

The runbook for an installation set up with [deployment.md](deployment.md). Commands that use the application code (`npm run …`) run in the operator checkout of the deployed tag, with the variables named in each section. `psql`, `pg_dump`, and `pg_restore` are PostgreSQL 18 client tools.

| Task | When | Section |
| --- | --- | --- |
| Back up the database | daily, and before every upgrade | [Backup](#backup) |
| Test a restore | at least every quarter | [Restore drill](#restore-drill) |
| Export and archive the audit trail | monthly | [Audit archive](#audit-archive) |
| Purge old idempotency keys | monthly | [Maintenance](#maintenance) |
| Rotate secrets | yearly, and after any suspected leak | [Rotating secrets](#rotating-secrets) |
| Investigate a problem | as needed | [Incidents](#incidents) |

## Backup

A logical backup in PostgreSQL's custom format, as the owner (it can read every table):

```bash
pg_dump --format=custom --no-owner --file="procureflow-$(date +%Y%m%d-%H%M).dump" \
  "postgres://procureflow_owner:<OWNER_DB_PASSWORD>@<host>:5432/procureflow"
```

- The dump is one consistent snapshot, taken while the app keeps running.
- It contains everything: documents, users, password hashes, sessions, and the audit trail. Store it encrypted, outside the database server, with access limited like the database itself. Keep at least 30 daily copies and one per month for as long as your record-keeping rules require.
- `--no-owner` leaves ownership out of the file, so whoever restores it becomes the owner. The grants to `procureflow_app` stay in it.
- Point-in-time recovery (WAL archiving) is a PostgreSQL server feature; set it up in the database platform if a day of data is too much to lose.

## Restore

Into a new, empty database (never over a live one). As the superuser:

```bash
psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE procureflow_restored OWNER procureflow_owner"
pg_restore --exit-on-error --no-owner \
  --dbname="postgres://procureflow_owner:<OWNER_DB_PASSWORD>@<host>:5432/procureflow_restored" procureflow-YYYYMMDD-HHMM.dump
```

- The roles are cluster-wide and not in the dump: on a new cluster create `procureflow_owner` and run `npm run db:app-role` first (deployment step 3), so the grants to `procureflow_app` apply.
- `pg_restore` loads the rows before it creates the triggers, so the guards and the append-only audit triggers are back in place once it finishes, without having refused the restored rows.
- Then compare with the source (`npm run db:checksums`, below), point `DATABASE_URL` at the restored database (or rename it), and restart the server.

## Restore drill

Prove that backups restore, without touching production: restore the latest dump into a scratch database as above, then compare:

```bash
npm run db:checksums -- --url "postgres://procureflow_owner:…@<host>:5432/procureflow"          > source.txt
npm run db:checksums -- --url "postgres://procureflow_owner:…@<host>:5432/procureflow_restored" > restored.txt
diff source.txt restored.txt
```

Each line is a table, its row count, and an md5 of its rows (sorted, so independent of storage order); the last line covers all tables. Compare against a source that has not changed since the dump (a copy, or a quiet moment), then drop the scratch database:

```bash
psql "$DATABASE_ADMIN_URL" -c "DROP DATABASE procureflow_restored"
```

Also check that the restored audit trail still matches your last audit export (`npm run audit:verify -- --file … --against-db` with `DATABASE_URL` at the restored database).

## Audit archive

The audit trail is append-only: nothing in the app can change or delete it, for any role (ADR 0009). The database superuser and the schema owner still could. The archive is the evidence that they did not:

```bash
# First export:
npm run audit:export -- --out audit-0001.jsonl
# Every following export continues the chain from the previous one's last id and hash:
npm run audit:export -- --out audit-0002.jsonl --after-id <last id> --previous-hash <last hash>
```

- Each line is one event with `hash = sha256(previous hash + event)`; changing, removing, adding, or reordering anything breaks the chain. The command prints the count, last id, and last hash.
- **Keep the last hash somewhere else** than the file (a ticket, a signed email, a write-once bucket): a file rewritten from scratch has a valid chain, but not that last hash.
- Store the files in write-once storage (object lock, WORM) for your retention period. They contain names, user ids, IP addresses, and user agents: personal data, with the same access rules as the database.
- Check a file, and that the database still holds exactly those events unchanged:

  ```bash
  npm run audit:verify -- --file audit-0002.jsonl --expect-last-hash <kept hash> --against-db
  ```

  `File intact` and `Database matches the export` mean nothing was changed; any `NOT INTACT` line names the line or the event ids (missing, changed, extra) and exits with code 1. Treat it as an incident.
- `DATABASE_URL` (the runtime role) is enough for both commands; they never write to the database.
- v0.1.0 never deletes audit rows. Rows older than the retention period may be removed only by the database owner after they are in the archive and verified; that is a manual, recorded decision outside the app (the triggers refuse it otherwise).

## Maintenance

```bash
npm run maintenance:purge-idempotency -- --older-than-days 30
```

Idempotency keys stop a form from creating a document twice when it is submitted twice in quick succession; after a day they protect nothing. The command deletes keys older than the given number of days (default 30) as the runtime role and prints how many. Safe to run any time.

Sessions expire on their own (Better Auth). `VACUUM` and `ANALYZE` are PostgreSQL's autovacuum's job; check it is on.

## Rotating secrets

| Secret | How | Effect |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | new value in the server's environment, restart every instance | every user is signed out; unused password-setup links stop working (issue new ones from **Admin**) |
| `APP_DB_PASSWORD` | `npm run db:app-role` with the new password (and `DATABASE_ADMIN_URL`), then the new `DATABASE_URL`, restart | none for users |
| `OWNER_DB_PASSWORD` | `ALTER ROLE procureflow_owner PASSWORD '…'` as the superuser; update the migration job and backups | none for users |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | rebuild with the new key and deploy to every instance at once | open forms must be reloaded once |

## Incidents

**The health check fails** (`/api/health` answers 503 or nothing): check the process (service manager status, its JSON logs), then the database (`pg_isready`, connections, disk). The server never shows database errors to users; the log line `db.pool_error` or `command.failed` with a `requestId` has the details.

**Users see "This record is being changed by someone else"**: a lock waited more than 5 seconds. Occasional is normal under load; many in a row point to a long transaction: `SELECT pid, now() - xact_start, state, query FROM pg_stat_activity WHERE datname = 'procureflow' ORDER BY xact_start;`.

**Following a user's action:** every log line has `requestId`, `command`, `userId`, and `outcome`; the same request id is on the audit event (**Audit**, details).

**Suspected account compromise:** as an admin, deactivate the user (**Admin → Users**), which ends their sessions; check their actions in **Audit** (filter by person); issue a new setup link when they are cleared.

**Suspected tampering with data or the trail:** take a backup now (evidence), run `audit:verify --against-db` against the latest archive, export the audit trail again, and compare documents with their history. Rotate the database and auth secrets once the cause is found.

**Restoring after data loss:** restore the last good backup into a new database (above), check it with `db:checksums` and `audit:verify`, switch `DATABASE_URL`, restart. Everything after the backup is lost; the audit archive shows what happened in between.
