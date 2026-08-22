const fs = require('fs');
const path = require('path');

function loadEnvFile(rootDir) {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function setupUnifiedEnvironment(rootDir) {
  loadEnvFile(rootDir);

  const unifiedToken = process.env.UNIFIED_DISCORD_TOKEN || process.env.DISCORD_TOKEN || process.env.TOKEN || '';
  const unifiedClientId = process.env.UNIFIED_CLIENT_ID || process.env.CLIENT_ID || '';
  const unifiedDeveloperId = process.env.UNIFIED_DEVELOPER_ID || process.env.DEVELOPER_ID || '';
  const unifiedGuildId = process.env.UNIFIED_GUILD_ID || process.env.GUILD_ID || '';

  if (unifiedToken) {
    process.env.DISCORD_TOKEN = unifiedToken;
    process.env.TOKEN = unifiedToken;
  }

  if (unifiedClientId) {
    process.env.CLIENT_ID = unifiedClientId;
  }

  if (unifiedDeveloperId) {
    process.env.DEVELOPER_ID = unifiedDeveloperId;
  }

  if (unifiedGuildId) {
    process.env.GUILD_ID = unifiedGuildId;
  }

  const rawUnifiedDbPath = process.env.UNIFIED_DB_PATH || path.join('data', 'unified.db');
  const unifiedDbPath = path.isAbsolute(rawUnifiedDbPath)
    ? rawUnifiedDbPath
    : path.resolve(rootDir, rawUnifiedDbPath);
  process.env.UNIFIED_DB_PATH = unifiedDbPath;

  if (!process.env.CURRENCY_DB_PATH) {
    process.env.CURRENCY_DB_PATH = unifiedDbPath;
  }

  if (!process.env.DB_PATH) {
    process.env.DB_PATH = unifiedDbPath;
  }

  if (!process.env.DATABASE_FILE) {
    process.env.DATABASE_FILE = unifiedDbPath;
  }

  process.env.ONE_TOKEN_MODE = 'true';

  return {
    unifiedToken,
    unifiedClientId,
    unifiedDeveloperId,
    unifiedGuildId,
  };
}

module.exports = {
  setupUnifiedEnvironment,
};
