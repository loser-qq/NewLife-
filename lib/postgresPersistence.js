const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Client } = require('pg');

function isPostgresSyncEnabled() {
  if (!process.env.DATABASE_URL) return false;
  return String(process.env.POSTGRES_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
}

function getSnapshotId() {
  return process.env.POSTGRES_SNAPSHOT_ID || 'main';
}

function getSyncIntervalMs() {
  const raw = Number(process.env.POSTGRES_SYNC_INTERVAL_MS || 30000);
  if (Number.isFinite(raw) && raw >= 5000) return raw;
  return 30000;
}

function getHistoryKeepCount() {
  const raw = Number(process.env.POSTGRES_HISTORY_KEEP || 2);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 2;
}

function ensureSqliteDirectory(sqlitePath) {
  const dir = path.dirname(sqlitePath);
  fs.mkdirSync(dir, { recursive: true });
}

function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeTimestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatHistorySnapshotId(baseSnapshotId, now = new Date()) {
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${baseSnapshotId}_${y}${mo}${d}_${h}${mi}${s}`;
}

function runIntegrityCheck(dbFilePath) {
  const db = new Database(dbFilePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    return rows.length === 1 && rows[0]?.integrity_check === 'ok';
  } finally {
    db.close();
  }
}

function getSchemaVersion(dbFilePath) {
  const db = new Database(dbFilePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('PRAGMA user_version').get();
    return Number(row?.user_version || 0);
  } finally {
    db.close();
  }
}

async function createSafeBackupSnapshot(sqlitePath) {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite file not found: ${sqlitePath}`);
  }

  const snapshotPath = `${sqlitePath}.snapshot.${Date.now()}.${process.pid}.tmp`;
  const sourceDb = new Database(sqlitePath, { readonly: true, fileMustExist: true });

  try {
    await sourceDb.backup(snapshotPath);
  } finally {
    sourceDb.close();
  }

  const isValid = runIntegrityCheck(snapshotPath);
  if (!isValid) {
    fs.rmSync(snapshotPath, { force: true });
    throw new Error('SQLite integrity_check failed for backup snapshot.');
  }

  const dbBlob = fs.readFileSync(snapshotPath);
  const stat = fs.statSync(snapshotPath);
  const checksum = computeSha256(dbBlob);
  const schemaVersion = getSchemaVersion(snapshotPath);

  fs.rmSync(snapshotPath, { force: true });

  return {
    dbBlob,
    dbSizeBytes: stat.size,
    dbMtimeMs: Math.trunc(stat.mtimeMs),
    checksumSha256: checksum,
    schemaVersion,
  };
}

async function withPgClient(databaseUrl, handler) {
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await handler(client);
  } finally {
    await client.end();
  }
}

async function ensureSnapshotTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bot_db_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      db_blob BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      snapshot_created_at TIMESTAMPTZ,
      db_size_bytes BIGINT,
      db_mtime_ms BIGINT,
      checksum_sha256 TEXT,
      schema_version INTEGER
    )
  `);

  const alterStatements = [
    'ALTER TABLE bot_db_snapshots ADD COLUMN IF NOT EXISTS snapshot_created_at TIMESTAMPTZ',
    'ALTER TABLE bot_db_snapshots ADD COLUMN IF NOT EXISTS db_size_bytes BIGINT',
    'ALTER TABLE bot_db_snapshots ADD COLUMN IF NOT EXISTS db_mtime_ms BIGINT',
    'ALTER TABLE bot_db_snapshots ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT',
    'ALTER TABLE bot_db_snapshots ADD COLUMN IF NOT EXISTS schema_version INTEGER',
  ];

  for (const sql of alterStatements) {
    await client.query(sql);
  }
}

function getLocalDbStatus(sqlitePath) {
  if (!fs.existsSync(sqlitePath)) {
    return { exists: false, valid: false, mtimeMs: 0 };
  }

  try {
    const valid = runIntegrityCheck(sqlitePath);
    const stat = fs.statSync(sqlitePath);
    return {
      exists: true,
      valid,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch (_) {
    return {
      exists: true,
      valid: false,
      mtimeMs: 0,
    };
  }
}

function verifyRemoteRowChecksum(row) {
  if (!row?.db_blob) return false;
  if (!row.checksum_sha256) return true;
  const actual = computeSha256(row.db_blob);
  return actual === row.checksum_sha256;
}

function safeReplaceSqliteFile(targetPath, replacementBuffer) {
  const tmpPath = `${targetPath}.restore.${Date.now()}.${process.pid}.tmp`;
  const backupPath = `${targetPath}.pre-restore.${Date.now()}.${process.pid}.bak`;

  fs.writeFileSync(tmpPath, replacementBuffer);

  const tmpValid = runIntegrityCheck(tmpPath);
  if (!tmpValid) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error('Restored snapshot failed integrity_check.');
  }

  const hasExisting = fs.existsSync(targetPath);

  if (!hasExisting) {
    fs.renameSync(tmpPath, targetPath);
    return;
  }

  fs.renameSync(targetPath, backupPath);

  try {
    fs.renameSync(tmpPath, targetPath);
    fs.rmSync(backupPath, { force: true });
  } catch (error) {
    if (fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
      fs.renameSync(backupPath, targetPath);
    }
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

async function selectBestSnapshotRow(client, snapshotId) {
  const rows = await client.query(
    `SELECT snapshot_id, db_blob, updated_at, snapshot_created_at, db_size_bytes, db_mtime_ms, checksum_sha256, schema_version
     FROM bot_db_snapshots
     WHERE snapshot_id = $1 OR snapshot_id LIKE $2
     ORDER BY snapshot_created_at DESC NULLS LAST, updated_at DESC`,
    [snapshotId, `${snapshotId}_%`],
  );

  for (const row of rows.rows) {
    if (!verifyRemoteRowChecksum(row)) continue;
    return row;
  }

  return null;
}

async function restoreDatabaseFile({ databaseUrl, sqlitePath, snapshotId = getSnapshotId(), logger = console }) {
  if (!databaseUrl) return false;
  ensureSqliteDirectory(sqlitePath);

  try {
    return await withPgClient(databaseUrl, async (client) => {
      await ensureSnapshotTable(client);

      const row = await selectBestSnapshotRow(client, snapshotId);
      if (!row) {
        logger.log('[postgres-sync] no valid remote snapshot found; using local sqlite file.');
        return false;
      }

      const localStatus = getLocalDbStatus(sqlitePath);
      const remoteMtimeMs = Number(row.db_mtime_ms || 0);
      const remoteUpdatedMs = normalizeTimestampMs(row.updated_at);
      const remoteRecencyMs = Math.max(remoteMtimeMs, remoteUpdatedMs);

      if (localStatus.exists && localStatus.valid && remoteRecencyMs > 0 && localStatus.mtimeMs > remoteRecencyMs) {
        logger.log('[postgres-sync] local sqlite is newer than remote snapshot; skip restore.');
        return false;
      }

      safeReplaceSqliteFile(sqlitePath, row.db_blob);
      logger.log(`[postgres-sync] restored sqlite snapshot from PostgreSQL (${row.snapshot_id}).`);
      return true;
    });
  } catch (error) {
    logger.warn('[postgres-sync] restore failed; using local sqlite file:', error.message);
    return false;
  }
}

async function cleanupOldHistoryRows(client, snapshotId, keepCount) {
  const result = await client.query(
    `SELECT snapshot_id
     FROM bot_db_snapshots
     WHERE snapshot_id LIKE $1
     ORDER BY snapshot_created_at DESC NULLS LAST, updated_at DESC`,
    [`${snapshotId}_%`],
  );

  if (result.rows.length <= keepCount) return;

  const deleteTargets = result.rows.slice(keepCount).map((row) => row.snapshot_id);
  for (const targetId of deleteTargets) {
    await client.query('DELETE FROM bot_db_snapshots WHERE snapshot_id = $1', [targetId]);
  }
}

async function uploadDatabaseSnapshot({ databaseUrl, sqlitePath, snapshotId = getSnapshotId(), logger = console }) {
  if (!databaseUrl) return false;
  if (!fs.existsSync(sqlitePath)) return false;

  const snapshot = await createSafeBackupSnapshot(sqlitePath);
  const historySnapshotId = formatHistorySnapshotId(snapshotId);
  const keepCount = getHistoryKeepCount();

  return withPgClient(databaseUrl, async (client) => {
    await ensureSnapshotTable(client);

    const existingMain = await client.query(
      'SELECT checksum_sha256 FROM bot_db_snapshots WHERE snapshot_id = $1 LIMIT 1',
      [snapshotId],
    );

    if (existingMain.rows[0]?.checksum_sha256 && existingMain.rows[0].checksum_sha256 === snapshot.checksumSha256) {
      logger.log('[postgres-sync] no db changes detected; snapshot upload skipped.');
      return true;
    }

    const baseParams = [
      snapshot.dbBlob,
      snapshot.dbSizeBytes,
      snapshot.dbMtimeMs,
      snapshot.checksumSha256,
      snapshot.schemaVersion,
    ];

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO bot_db_snapshots
          (snapshot_id, db_blob, updated_at, snapshot_created_at, db_size_bytes, db_mtime_ms, checksum_sha256, schema_version)
         VALUES ($1, $2, NOW(), NOW(), $3, $4, $5, $6)
         ON CONFLICT (snapshot_id)
         DO UPDATE SET
           db_blob = EXCLUDED.db_blob,
           updated_at = NOW(),
           snapshot_created_at = NOW(),
           db_size_bytes = EXCLUDED.db_size_bytes,
           db_mtime_ms = EXCLUDED.db_mtime_ms,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           schema_version = EXCLUDED.schema_version`,
        [snapshotId, ...baseParams],
      );

      await client.query(
        `INSERT INTO bot_db_snapshots
          (snapshot_id, db_blob, updated_at, snapshot_created_at, db_size_bytes, db_mtime_ms, checksum_sha256, schema_version)
         VALUES ($1, $2, NOW(), NOW(), $3, $4, $5, $6)
         ON CONFLICT (snapshot_id)
         DO UPDATE SET
           db_blob = EXCLUDED.db_blob,
           updated_at = NOW(),
           snapshot_created_at = NOW(),
           db_size_bytes = EXCLUDED.db_size_bytes,
           db_mtime_ms = EXCLUDED.db_mtime_ms,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           schema_version = EXCLUDED.schema_version`,
        [historySnapshotId, ...baseParams],
      );

      await cleanupOldHistoryRows(client, snapshotId, keepCount);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    logger.log('[postgres-sync] uploaded sqlite snapshot to PostgreSQL.');
    return true;
  });
}

function startPostgresSync({ databaseUrl, sqlitePath, snapshotId = getSnapshotId(), intervalMs = getSyncIntervalMs(), logger = console }) {
  if (!databaseUrl) {
    return {
      enabled: false,
      stop: async () => {},
      flush: async () => false,
    };
  }

  let inFlight = false;
  let inFlightPromise = null;

  const flush = async () => {
    if (inFlight) return inFlightPromise;
    inFlight = true;
    inFlightPromise = (async () => {
      try {
        return await uploadDatabaseSnapshot({ databaseUrl, sqlitePath, snapshotId, logger });
      } catch (error) {
        logger.warn('[postgres-sync] upload failed:', error.message);
        return false;
      } finally {
        inFlight = false;
        inFlightPromise = null;
      }
    })();
    return inFlightPromise;
  };

  const timer = setInterval(() => {
    void flush();
  }, intervalMs);
  timer.unref();

  return {
    enabled: true,
    stop: async () => {
      clearInterval(timer);
      // 実行中のsyncがあれば完了を待ってから最終syncを実行
      if (inFlightPromise) await inFlightPromise;
      await flush();
    },
    flush,
  };
}

module.exports = {
  isPostgresSyncEnabled,
  restoreDatabaseFile,
  startPostgresSync,
  getSyncIntervalMs,
};
