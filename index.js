const path = require('path');
const { setupUnifiedEnvironment } = require('./lib/unifiedEnv');
const { loadDiscord, attachSharedClientProxy, getSharedClient } = require('./lib/sharedClient');
const { registerBackupFeature } = require('./lib/backupFeature');
const { isPostgresSyncEnabled, restoreDatabaseFile, startPostgresSync } = require('./lib/postgresPersistence');

function createPreShutdownHook(sync) {
  let oncePromise = null;
  return async (signal) => {
    if (!sync?.enabled) return;
    if (!oncePromise) {
      oncePromise = (async () => {
        console.log(`[postgres-sync] final sync requested by ${signal}.`);
        await sync.stop();
      })().catch((error) => {
        console.warn('[postgres-sync] final sync failed:', error.message);
      });
    }
    await oncePromise;
  };
}

async function bootstrap() {
  const rootDir = __dirname;
  const env = setupUnifiedEnvironment(rootDir);
  const sqlitePath = process.env.UNIFIED_DB_PATH || path.resolve(rootDir, 'data', 'unified.db');

  if (isPostgresSyncEnabled()) {
    await restoreDatabaseFile({
      databaseUrl: process.env.DATABASE_URL,
      sqlitePath,
    });
  }

  const discord = loadDiscord(rootDir);
  attachSharedClientProxy(discord);

  console.log('[unified] loading feature modules...');
  require('./features/community/index.js');
  require('./features/economy/index.js');
  require('./features/security/index.js');

  const sharedClient = getSharedClient();
  if (!sharedClient) {
    throw new Error('[unified] shared client was not initialized.');
  }

  registerBackupFeature({
    discord,
    client: sharedClient,
    rootDir,
    unifiedToken: env.unifiedToken,
    unifiedClientId: env.unifiedClientId,
    unifiedDeveloperId: env.unifiedDeveloperId,
  });

  if (isPostgresSyncEnabled()) {
    const sync = startPostgresSync({
      databaseUrl: process.env.DATABASE_URL,
      sqlitePath,
    });

    const preShutdownHook = createPreShutdownHook(sync);
    global.__UNIFIED_PRE_SHUTDOWN_SYNC__ = preShutdownHook;

    process.prependListener('SIGTERM', () => {
      void preShutdownHook('SIGTERM');
    });

    process.prependListener('SIGINT', () => {
      void preShutdownHook('SIGINT');
    });

    process.on('beforeExit', () => {
      void preShutdownHook('beforeExit');
    });
  }

  console.log('[unified] unified runtime initialized.');
}

bootstrap().catch((error) => {
  console.error('[unified] bootstrap failed:', error);
  process.exit(1);
});
