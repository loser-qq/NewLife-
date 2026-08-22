# Render Deployment

This bot runs on Render as a Background Worker. It does not need an HTTP port.

## What is persisted

The bot uses `data/unified.db` while it is running. When `DATABASE_URL` is set,
the runtime stores a verified SQLite snapshot in Render PostgreSQL and restores
the latest valid snapshot before loading the feature modules.

The included `render.yaml` creates PostgreSQL 18 and configures a 10-second
sync interval. A forced shutdown also requests one final upload. The maximum
data exposure from an unexpected process loss is therefore the sync interval.

PostgreSQL stores the bot database snapshot in `bot_db_snapshots`. It is not a
direct table-by-table PostgreSQL migration, so only one worker instance must run
for a snapshot ID.

## Deploy

1. Push this repository to GitHub or GitLab. Do not commit `.env` or `data/*.db`.
2. In Render, choose **New +** then **Blueprint** and select the repository.
3. Review `render.yaml`, then create the Blueprint.
4. Set the prompted secrets:
   - `UNIFIED_DISCORD_TOKEN`
   - `UNIFIED_CLIENT_ID`
   - `UNIFIED_DEVELOPER_ID`
   - `UNIFIED_GUILD_ID` (optional)
5. Keep the worker and `newlife-postgres` database in the same Render region.
6. Confirm the Worker log contains `[postgres-sync] uploaded sqlite snapshot to PostgreSQL.` after the first successful start.

The database only accepts Render private-network connections because the
Blueprint sets `ipAllowList: []`.

## First Data Migration

To preserve the current local bot data, upload it once before the first Render
deployment, using the Render Postgres **external** connection string only on
your local machine:

```powershell
$env:DATABASE_URL = "<Render external connection string>"
$env:POSTGRES_SYNC_ENABLED = "true"
$env:POSTGRES_SNAPSHOT_ID = "newlife-production"
$env:POSTGRES_SYNC_INTERVAL_MS = "10000"
node index.js
```

Wait for `[postgres-sync] uploaded sqlite snapshot to PostgreSQL.` in the log,
then stop the local process with `Ctrl+C`. The final shutdown sync runs as an
additional safeguard. Remove `DATABASE_URL` from the local terminal session
afterward.

## Operations

- Use exactly one Worker instance. Multiple instances can overwrite each
  other's snapshots.
- Set `POSTGRES_SYNC_INTERVAL_MS` no lower than `5000` milliseconds; the code
  enforces this minimum.
- `POSTGRES_HISTORY_KEEP=5` retains the latest five historical snapshots in
  addition to the current `newlife-production` snapshot.
- Render Worker plans are paid; a continuously running Discord bot cannot use
  a Render free worker plan.