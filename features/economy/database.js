const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function resolveDatabasePath() {
  const candidates = [
    process.env.CURRENCY_DB_PATH,
    process.env.DB_PATH,
    process.env.DATABASE_FILE,
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'currency.db') : null,
    process.env.PERSISTENT_DIR ? path.join(process.env.PERSISTENT_DIR, 'currency.db') : null,
    path.join(process.cwd(), 'data', 'currency.db'),
    path.join(__dirname, 'data', 'currency.db'),
    path.join(__dirname, 'currency.db'),
  ].filter(Boolean);

  const selectedPath = candidates[0];
  const absolutePath = path.isAbsolute(selectedPath) ? selectedPath : path.join(__dirname, selectedPath);
  const directory = path.dirname(absolutePath);
  fs.mkdirSync(directory, { recursive: true });
  return absolutePath;
}

const legacyDbPath = path.join(__dirname, 'currency.db');
const dbPath = resolveDatabasePath();

if (dbPath !== legacyDbPath && fs.existsSync(legacyDbPath) && !fs.existsSync(dbPath)) {
  fs.copyFileSync(legacyDbPath, dbPath);
}

const db = new Database(dbPath);
process.stdout.write(`[DB] using ${dbPath}\n`);

db.exec(`
  CREATE TABLE IF NOT EXISTS balances (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    guild_id TEXT PRIMARY KEY,
    remove_role_id TEXT,
    add_role_id TEXT,
    evaluation_days INTEGER DEFAULT 0,
    evaluation_role_id TEXT,
    role_display_exclude_id TEXT,
    role_display_include1_id TEXT,
    role_display_include2_id TEXT,
    role_display_include3_id TEXT,
    grant_amount INTEGER DEFAULT 0,
    transfer_log_channel_id TEXT,
    log_channel_id TEXT,
    grant_log_channel_id TEXT,
    deduction_log_channel_id TEXT,
    interview_log_channel_id TEXT,
    leveling_log_channel_id TEXT,
    leveling_voice_channel_id TEXT,
    currency_unit TEXT DEFAULT 'コイン',
    snuggle_min INTEGER DEFAULT 1,
    snuggle_max INTEGER DEFAULT 100,
    snuggle_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS permitted_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS ticket_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    message_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    label TEXT NOT NULL,
    category_id TEXT NOT NULL,
    log_channel_id TEXT NOT NULL,
    auto_message TEXT NOT NULL,
    role1_id TEXT,
    role2_id TEXT,
    role3_id TEXT
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    panel_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reaction_role_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reaction_role_mappings (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    role_id TEXT,
    PRIMARY KEY (message_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS pinned_messages (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS snuggle_cooldowns (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS leveling_profiles (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    last_level INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS interview_evaluations (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    passed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS leveling_sessions (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_channels (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_periods (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    period_days INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_rewards (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    required_seconds INTEGER NOT NULL,
    reward_amount INTEGER NOT NULL,
    log_channel_id TEXT,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_reward_claims (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    rewarded_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_reward_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    required_seconds INTEGER NOT NULL,
    reward_amount INTEGER NOT NULL,
    log_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_reward_rule_claims (
    user_id TEXT NOT NULL,
    reward_rule_id INTEGER NOT NULL,
    rewarded_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, reward_rule_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_profiles (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS role_voice_time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    total_seconds INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_role_voice_time_entries_period
    ON role_voice_time_entries (guild_id, role_id, ended_at, user_id);

  CREATE TABLE IF NOT EXISTS role_voice_time_sessions (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS leveling_thresholds (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    required_seconds INTEGER NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS leveling_roles (
    guild_id TEXT NOT NULL,
    start_level INTEGER NOT NULL,
    end_level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, start_level, end_level)
  );

  CREATE TABLE IF NOT EXISTS role_salary_settings (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS vending_panels (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    log_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS vending_products (
    guild_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    label TEXT NOT NULL,
    role_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    PRIMARY KEY (guild_id, slot)
  );

  CREATE TABLE IF NOT EXISTS vending_purchases (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS vending_panels_multi (
    guild_id TEXT NOT NULL,
    panel_key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    log_channel_id TEXT,
    PRIMARY KEY (guild_id, panel_key)
  );

  CREATE TABLE IF NOT EXISTS vending_products_multi (
    guild_id TEXT NOT NULL,
    panel_key TEXT NOT NULL,
    slot INTEGER NOT NULL,
    label TEXT NOT NULL,
    role_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    PRIMARY KEY (guild_id, panel_key, slot)
  );

  CREATE TABLE IF NOT EXISTS vc_vending_panels_multi (
    guild_id TEXT NOT NULL,
    panel_key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    log_channel_id TEXT,
    PRIMARY KEY (guild_id, panel_key)
  );

  CREATE TABLE IF NOT EXISTS vc_vending_products_multi (
    guild_id TEXT NOT NULL,
    panel_key TEXT NOT NULL,
    slot INTEGER NOT NULL,
    label TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    category_id TEXT,
    visibility_role_id TEXT,
    user_limit INTEGER NOT NULL DEFAULT 0,
    visibility_mode TEXT NOT NULL,
    price INTEGER NOT NULL,
    extension_price INTEGER NOT NULL DEFAULT 1,
    extension_duration_minutes INTEGER NOT NULL DEFAULT 1,
    duration_minutes INTEGER NOT NULL,
    PRIMARY KEY (guild_id, panel_key, slot)
  );

  CREATE TABLE IF NOT EXISTS vc_vending_purchases (
    guild_id TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    template_voice_channel_id TEXT,
    text_channel_id TEXT,
    mode TEXT NOT NULL,
    buyer_id TEXT NOT NULL,
    is_temporary INTEGER NOT NULL DEFAULT 0,
    extension_price INTEGER NOT NULL DEFAULT 1,
    duration_minutes INTEGER NOT NULL DEFAULT 1,
    extension_duration_minutes INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, voice_channel_id)
  );

  CREATE TABLE IF NOT EXISTS gacha_panels (
    guild_id TEXT NOT NULL,
    panel_key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (guild_id, panel_key)
  );

  CREATE TABLE IF NOT EXISTS gacha_products (
    guild_id TEXT NOT NULL,
    panel_key TEXT NOT NULL,
    slot INTEGER NOT NULL,
    label TEXT NOT NULL,
    role_id TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    ten_pull_price INTEGER NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (guild_id, panel_key, slot)
  );

  CREATE TABLE IF NOT EXISTS box_gachas (
    guild_id TEXT NOT NULL,
    gacha_key TEXT NOT NULL,
    name TEXT NOT NULL,
    single_price INTEGER NOT NULL DEFAULT 0,
    ten_price INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, gacha_key)
  );

  CREATE TABLE IF NOT EXISTS box_gacha_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    gacha_key TEXT NOT NULL,
    product_name TEXT NOT NULL,
    rarity TEXT NOT NULL,
    initial_quantity INTEGER NOT NULL,
    remaining_quantity INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(guild_id, gacha_key, product_name)
  );

  CREATE TABLE IF NOT EXISTS box_gacha_panels (
    guild_id TEXT NOT NULL,
    gacha_key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (guild_id, gacha_key)
  );

  CREATE TABLE IF NOT EXISTS box_gacha_log_channels (
    guild_id TEXT NOT NULL,
    gacha_key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, gacha_key)
  );

  CREATE TABLE IF NOT EXISTS box_gacha_next_products (
    guild_id TEXT NOT NULL,
    gacha_key TEXT NOT NULL,
    product_name TEXT NOT NULL,
    set_by_user_id TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, gacha_key)
  );

  CREATE TABLE IF NOT EXISTS bank_transfer_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS currency_support_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS bank_panels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
`);

try {
  db.exec('ALTER TABLE settings ADD COLUMN leveling_voice_channel_id TEXT');
} catch (error) {
  if (!error.message.includes('duplicate column name')) throw error;
}
try {
  db.exec('ALTER TABLE role_voice_time_entries ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0');
} catch (error) {
  if (!error.message.includes('duplicate column name')) throw error;
}

const legacyRoleVoiceTimeRewardCount = db.prepare('SELECT COUNT(*) AS count FROM role_voice_time_rewards').get().count;
const roleVoiceTimeRewardRuleCount = db.prepare('SELECT COUNT(*) AS count FROM role_voice_time_reward_rules').get().count;
if (legacyRoleVoiceTimeRewardCount > 0 && roleVoiceTimeRewardRuleCount === 0) {
  const migrateRoleVoiceTimeRewards = db.transaction(() => {
    const legacyRewards = db.prepare('SELECT guild_id, role_id, required_seconds, reward_amount, log_channel_id FROM role_voice_time_rewards').all();
    const insertRule = db.prepare(`
      INSERT INTO role_voice_time_reward_rules (guild_id, role_id, required_seconds, reward_amount, log_channel_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const getClaims = db.prepare('SELECT user_id, rewarded_at FROM role_voice_time_reward_claims WHERE guild_id = ? AND role_id = ?');
    const insertClaim = db.prepare('INSERT OR IGNORE INTO role_voice_time_reward_rule_claims (user_id, reward_rule_id, rewarded_at) VALUES (?, ?, ?)');
    for (const reward of legacyRewards) {
      const rewardRuleId = insertRule.run(reward.guild_id, reward.role_id, reward.required_seconds, reward.reward_amount, reward.log_channel_id).lastInsertRowid;
      for (const claim of getClaims.all(reward.guild_id, reward.role_id)) {
        insertClaim.run(claim.user_id, rewardRuleId, claim.rewarded_at);
      }
    }
  });
  migrateRoleVoiceTimeRewards();
}

const legacyVendingPanelCount = db.prepare('SELECT COUNT(*) AS count FROM vending_panels').get().count;
const multiVendingPanelCount = db.prepare('SELECT COUNT(*) AS count FROM vending_panels_multi').get().count;
if (legacyVendingPanelCount > 0 && multiVendingPanelCount === 0) {
  const legacyPanels = db.prepare('SELECT * FROM vending_panels').all();
  const legacyProducts = db.prepare('SELECT * FROM vending_products').all();
  const tx = db.transaction(() => {
    for (const panel of legacyPanels) {
      db.prepare(`
        INSERT OR IGNORE INTO vending_panels_multi (guild_id, panel_key, channel_id, message_id, title, description, log_channel_id)
        VALUES (?, 'default', ?, ?, ?, ?, ?)
      `).run(panel.guild_id, panel.channel_id || '', panel.message_id || '', panel.title || '自販機', panel.description || 'ロール購入パネル', panel.log_channel_id || null);
    }
    for (const product of legacyProducts) {
      db.prepare(`
        INSERT OR IGNORE INTO vending_products_multi (guild_id, panel_key, slot, label, role_id, price, duration_minutes)
        VALUES (?, 'default', ?, ?, ?, ?, ?)
      `).run(product.guild_id, product.slot, product.label, product.role_id, product.price, product.duration_minutes);
    }
  });
  tx();
}

const settingsColumns = db.prepare('PRAGMA table_info(settings)').all().map(row => row.name);
if (!settingsColumns.includes('evaluation_days')) {
  db.prepare('ALTER TABLE settings ADD COLUMN evaluation_days INTEGER DEFAULT 0').run();
}
if (!settingsColumns.includes('evaluation_role_id')) {
  db.prepare('ALTER TABLE settings ADD COLUMN evaluation_role_id TEXT').run();
}
if (!settingsColumns.includes('role_display_exclude_id')) {
  db.prepare('ALTER TABLE settings ADD COLUMN role_display_exclude_id TEXT').run();
}
if (!settingsColumns.includes('role_display_include1_id')) {
  db.prepare('ALTER TABLE settings ADD COLUMN role_display_include1_id TEXT').run();
}
if (!settingsColumns.includes('role_display_include2_id')) {
  db.prepare('ALTER TABLE settings ADD COLUMN role_display_include2_id TEXT').run();
}
if (!settingsColumns.includes('role_display_include3_id')) {
  db.prepare('ALTER TABLE settings ADD COLUMN role_display_include3_id TEXT').run();
}

const gachaProductColumns = db.prepare('PRAGMA table_info(gacha_products)').all().map(row => row.name);
if (!gachaProductColumns.includes('ten_pull_price')) {
  db.prepare('ALTER TABLE gacha_products ADD COLUMN ten_pull_price INTEGER NOT NULL DEFAULT 0').run();
}
if (!gachaProductColumns.includes('quantity')) {
  db.prepare('ALTER TABLE gacha_products ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1').run();
}

const vcVendingPurchaseColumns = db.prepare('PRAGMA table_info(vc_vending_purchases)').all().map(row => row.name);
if (!vcVendingPurchaseColumns.includes('is_temporary')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN is_temporary INTEGER NOT NULL DEFAULT 0').run();
}
if (!vcVendingPurchaseColumns.includes('template_voice_channel_id')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN template_voice_channel_id TEXT').run();
}
if (!vcVendingPurchaseColumns.includes('text_channel_id')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN text_channel_id TEXT').run();
}
if (!vcVendingPurchaseColumns.includes('extension_price')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN extension_price INTEGER NOT NULL DEFAULT 1').run();
}
if (!vcVendingPurchaseColumns.includes('duration_minutes')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 1').run();
}
if (!vcVendingPurchaseColumns.includes('extension_duration_minutes')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN extension_duration_minutes INTEGER NOT NULL DEFAULT 1').run();
}
if (!vcVendingPurchaseColumns.includes('panel_message_id')) {
  db.prepare('ALTER TABLE vc_vending_purchases ADD COLUMN panel_message_id TEXT').run();
}

const vcVendingProductColumns = db.prepare('PRAGMA table_info(vc_vending_products_multi)').all().map(row => row.name);
if (!vcVendingProductColumns.includes('category_id')) {
  db.prepare('ALTER TABLE vc_vending_products_multi ADD COLUMN category_id TEXT').run();
}
if (!vcVendingProductColumns.includes('visibility_role_id')) {
  db.prepare('ALTER TABLE vc_vending_products_multi ADD COLUMN visibility_role_id TEXT').run();
}
if (!vcVendingProductColumns.includes('user_limit')) {
  db.prepare('ALTER TABLE vc_vending_products_multi ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 0').run();
}
if (!vcVendingProductColumns.includes('extension_price')) {
  db.prepare('ALTER TABLE vc_vending_products_multi ADD COLUMN extension_price INTEGER NOT NULL DEFAULT 1').run();
}
if (!vcVendingProductColumns.includes('extension_duration_minutes')) {
  db.prepare('ALTER TABLE vc_vending_products_multi ADD COLUMN extension_duration_minutes INTEGER NOT NULL DEFAULT 1').run();
}

function getBalance(userId, guildId) {
  const row = db.prepare('SELECT balance FROM balances WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
  return row ? row.balance : 0;
}

function setBalance(userId, guildId, amount) {
  const clamped = Math.max(0, amount);
  db.prepare(`
    INSERT INTO balances (user_id, guild_id, balance) VALUES (?, ?, ?)
    ON CONFLICT(user_id, guild_id) DO UPDATE SET balance = ?
  `).run(userId, guildId, clamped, clamped);
}

function resetAllBalances(guildId) {
  return db.prepare('UPDATE balances SET balance = 0 WHERE guild_id = ?').run(guildId).changes;
}

function addBalance(userId, guildId, amount) {
  setBalance(userId, guildId, getBalance(userId, guildId) + amount);
}

function subtractBalance(userId, guildId, amount) {
  const newBalance = Math.max(0, getBalance(userId, guildId) - amount);
  setBalance(userId, guildId, newBalance);
  return newBalance;
}

function transfer(fromUserId, toUserId, guildId, amount) {
  const fromBalance = getBalance(fromUserId, guildId);
  if (fromBalance < amount) return { success: false, reason: 'insufficient' };

  const transferFn = db.transaction(() => {
    setBalance(fromUserId, guildId, fromBalance - amount);
    addBalance(toUserId, guildId, amount);
  });

  transferFn();
  return { success: true };
}

function getSettings(guildId) {
  return db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(guildId) || {};
}

function setTransferLogChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO settings (guild_id, transfer_log_channel_id, log_channel_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      transfer_log_channel_id = excluded.transfer_log_channel_id,
      log_channel_id = excluded.log_channel_id
  `).run(guildId, channelId, channelId);
}

function setGrantLogChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO settings (guild_id, grant_log_channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET grant_log_channel_id = excluded.grant_log_channel_id
  `).run(guildId, channelId);
}

function setDeductionLogChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO settings (guild_id, deduction_log_channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET deduction_log_channel_id = excluded.deduction_log_channel_id
  `).run(guildId, channelId);
}

function setInterviewLogChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO settings (guild_id, interview_log_channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET interview_log_channel_id = excluded.interview_log_channel_id
  `).run(guildId, channelId);
}

function setLevelingLogChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO settings (guild_id, leveling_log_channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET leveling_log_channel_id = excluded.leveling_log_channel_id
  `).run(guildId, channelId);
}

function setLevelingVoiceChannel(guildId, channelId) {
  const channelIds = Array.isArray(channelId) ? channelId : [channelId];
  const serialized = [...new Set(channelIds.filter(Boolean))].join(',') || null;
  db.prepare(`
    INSERT INTO settings (guild_id, leveling_voice_channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET leveling_voice_channel_id = excluded.leveling_voice_channel_id
  `).run(guildId, serialized);
}

function setInterviewSettings(guildId, removeRoleId, addRoleId, grantAmount) {
  db.prepare(`
    INSERT INTO settings (guild_id, remove_role_id, add_role_id, grant_amount)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      remove_role_id = excluded.remove_role_id,
      add_role_id = excluded.add_role_id,
      grant_amount = excluded.grant_amount
  `).run(guildId, removeRoleId, addRoleId, grantAmount);
}

function setEvaluationSettings(guildId, evaluationDays, evaluationRoleId) {
  const days = Math.max(0, Math.floor(evaluationDays));
  db.prepare(`
    INSERT INTO settings (guild_id, evaluation_days, evaluation_role_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      evaluation_days = excluded.evaluation_days,
      evaluation_role_id = excluded.evaluation_role_id
  `).run(guildId, days, evaluationRoleId || null);
}

function setRoleDisplayExcludeRole(guildId, roleId) {
  db.prepare(`
    INSERT INTO settings (guild_id, role_display_exclude_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET role_display_exclude_id = excluded.role_display_exclude_id
  `).run(guildId, roleId || null);
}

function setRoleDisplayIncludeRoles(guildId, role1Id, role2Id, role3Id) {
  db.prepare(`
    INSERT INTO settings (guild_id, role_display_include1_id, role_display_include2_id, role_display_include3_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      role_display_include1_id = excluded.role_display_include1_id,
      role_display_include2_id = excluded.role_display_include2_id,
      role_display_include3_id = excluded.role_display_include3_id
  `).run(guildId, role1Id || null, role2Id || null, role3Id || null);
}

function addPermittedRole(guildId, roleId) {
  db.prepare('INSERT OR IGNORE INTO permitted_roles (guild_id, role_id) VALUES (?, ?)').run(guildId, roleId);
}

function getPermittedRoles(guildId) {
  return db.prepare('SELECT role_id FROM permitted_roles WHERE guild_id = ?').all(guildId).map(row => row.role_id);
}

function addCurrencySupportRole(guildId, roleId) {
  db.prepare('INSERT OR IGNORE INTO currency_support_roles (guild_id, role_id) VALUES (?, ?)').run(guildId, roleId);
}

function removeCurrencySupportRole(guildId, roleId) {
  db.prepare('DELETE FROM currency_support_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
}

function getCurrencySupportRoles(guildId) {
  return db.prepare('SELECT role_id FROM currency_support_roles WHERE guild_id = ?').all(guildId).map(row => row.role_id);
}

function setCurrencyUnit(guildId, unit) {
  db.prepare(`
    INSERT INTO settings (guild_id, currency_unit)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET currency_unit = excluded.currency_unit
  `).run(guildId, unit);
}

function setBankTransferRoles(guildId, roleIds) {
  const unique = [...new Set((roleIds || []).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bank_transfer_roles WHERE guild_id = ?').run(guildId);
    const insert = db.prepare('INSERT OR IGNORE INTO bank_transfer_roles (guild_id, role_id) VALUES (?, ?)');
    for (const roleId of unique) insert.run(guildId, roleId);
  });
  tx();
  return unique;
}

function getBankTransferRoles(guildId) {
  return db.prepare('SELECT role_id FROM bank_transfer_roles WHERE guild_id = ?').all(guildId).map(row => row.role_id);
}

function upsertBankPanel(guildId, channelId, messageId, title, description) {
  db.prepare(`
    INSERT INTO bank_panels (guild_id, channel_id, message_id, title, description)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET
      message_id = excluded.message_id,
      title = excluded.title,
      description = excluded.description
  `).run(guildId, channelId, messageId, title, description);
}

function getBankPanels(guildId) {
  return db.prepare('SELECT * FROM bank_panels WHERE guild_id = ?').all(guildId);
}

function getLevelingProfile(userId, guildId) {
  return db.prepare('SELECT total_seconds, last_level FROM leveling_profiles WHERE user_id = ? AND guild_id = ?').get(userId, guildId) || { total_seconds: 0, last_level: 1 };
}

function getLevelingProfiles(guildId) {
  return db.prepare('SELECT user_id, total_seconds, last_level FROM leveling_profiles WHERE guild_id = ? ORDER BY total_seconds DESC, user_id ASC').all(guildId);
}

function setLevelingProfile(userId, guildId, totalSeconds, lastLevel) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const profileLastLevel = Number.isFinite(lastLevel) ? Math.max(1, Math.floor(lastLevel)) : getLevelingProfile(userId, guildId).last_level;
  db.prepare(`
    INSERT INTO leveling_profiles (user_id, guild_id, total_seconds, last_level) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, guild_id) DO UPDATE SET total_seconds = excluded.total_seconds
      , last_level = excluded.last_level
  `).run(userId, guildId, clamped, profileLastLevel);
}

function addLevelingSeconds(userId, guildId, seconds) {
  const profile = getLevelingProfile(userId, guildId);
  setLevelingProfile(userId, guildId, profile.total_seconds + seconds, profile.last_level);
}

function setLevelingLastLevel(userId, guildId, lastLevel) {
  const profile = getLevelingProfile(userId, guildId);
  setLevelingProfile(userId, guildId, profile.total_seconds, lastLevel);
}

function setInterviewEvaluationPassedAt(userId, guildId, passedAt) {
  const ts = Math.max(0, Math.floor(passedAt));
  db.prepare(`
    INSERT INTO interview_evaluations (user_id, guild_id, passed_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, guild_id) DO UPDATE SET passed_at = excluded.passed_at
  `).run(userId, guildId, ts);
}

function getInterviewEvaluation(userId, guildId) {
  return db.prepare('SELECT passed_at FROM interview_evaluations WHERE user_id = ? AND guild_id = ?').get(userId, guildId) || null;
}

function deleteInterviewEvaluation(userId, guildId) {
  return db.prepare('DELETE FROM interview_evaluations WHERE user_id = ? AND guild_id = ?').run(userId, guildId).changes;
}

function resetAllInterviewEvaluations(guildId) {
  return db.prepare('DELETE FROM interview_evaluations WHERE guild_id = ?').run(guildId).changes;
}

function getInterviewEvaluations(guildId) {
  return db.prepare('SELECT user_id, passed_at FROM interview_evaluations WHERE guild_id = ? ORDER BY passed_at DESC').all(guildId);
}

function getActiveLevelingSession(userId, guildId) {
  return db.prepare('SELECT * FROM leveling_sessions WHERE user_id = ? AND guild_id = ?').get(userId, guildId) || null;
}

function getActiveLevelingSessions(guildId) {
  return db.prepare('SELECT * FROM leveling_sessions WHERE guild_id = ?').all(guildId);
}

function upsertLevelingSession(userId, guildId, channelId, joinedAt) {
  db.prepare(`
    INSERT INTO leveling_sessions (user_id, guild_id, channel_id, joined_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      joined_at = excluded.joined_at
  `).run(userId, guildId, channelId, joinedAt);
}

function updateLevelingSessionChannel(userId, guildId, channelId) {
  db.prepare('UPDATE leveling_sessions SET channel_id = ? WHERE user_id = ? AND guild_id = ?').run(channelId, userId, guildId);
}

function deleteLevelingSession(userId, guildId) {
  db.prepare('DELETE FROM leveling_sessions WHERE user_id = ? AND guild_id = ?').run(userId, guildId);
}

function resetAllLevelingData(guildId) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE leveling_profiles SET total_seconds = 0, last_level = 1 WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM leveling_sessions WHERE guild_id = ?').run(guildId);
  });
  tx();
}

function setRoleVoiceTimeChannels(guildId, roleId, channelIds) {
  const uniqueChannelIds = [...new Set((channelIds || []).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_voice_time_channels WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
    const insert = db.prepare('INSERT INTO role_voice_time_channels (guild_id, role_id, channel_id) VALUES (?, ?, ?)');
    for (const channelId of uniqueChannelIds) {
      insert.run(guildId, roleId, channelId);
    }
  });
  tx();
  return uniqueChannelIds;
}

function getRoleVoiceTimeChannels(guildId, roleId) {
  return db.prepare('SELECT channel_id FROM role_voice_time_channels WHERE guild_id = ? AND role_id = ? ORDER BY channel_id').all(guildId, roleId).map((row) => row.channel_id);
}

function setRoleVoiceTimePeriodDays(guildId, roleId, periodDays) {
  const days = Math.max(0, Math.floor(periodDays));
  db.prepare(`
    INSERT INTO role_voice_time_periods (guild_id, role_id, period_days) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, role_id) DO UPDATE SET period_days = excluded.period_days
  `).run(guildId, roleId, days);
  return days;
}

function getRoleVoiceTimePeriodDays(guildId, roleId) {
  const row = db.prepare('SELECT period_days FROM role_voice_time_periods WHERE guild_id = ? AND role_id = ?').get(guildId, roleId);
  return Math.max(0, Number(row?.period_days || 0));
}

function setRoleVoiceTimeReward(guildId, roleId, requiredSeconds, rewardAmount, logChannelId) {
  const safeRequiredSeconds = Math.max(60, Math.floor(requiredSeconds));
  const safeRewardAmount = Math.max(1, Math.floor(rewardAmount));
  return db.prepare(`
    INSERT INTO role_voice_time_reward_rules (guild_id, role_id, required_seconds, reward_amount, log_channel_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, roleId, safeRequiredSeconds, safeRewardAmount, logChannelId || null).lastInsertRowid;
}

function deleteRoleVoiceTimeReward(guildId, rewardRuleId) {
  const rule = db.prepare('SELECT id FROM role_voice_time_reward_rules WHERE id = ? AND guild_id = ?').get(rewardRuleId, guildId);
  if (!rule) return false;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_voice_time_reward_rule_claims WHERE reward_rule_id = ?').run(rewardRuleId);
    db.prepare('DELETE FROM role_voice_time_reward_rules WHERE id = ? AND guild_id = ?').run(rewardRuleId, guildId);
  });
  tx();
  return true;
}

function getRoleVoiceTimeRewards(guildId) {
  return db.prepare('SELECT id, role_id, required_seconds, reward_amount, log_channel_id FROM role_voice_time_reward_rules WHERE guild_id = ? ORDER BY role_id, required_seconds, id').all(guildId);
}

function claimRoleVoiceTimeReward(userId, rewardRuleId, minimumRewardedAt, rewardedAt) {
  const result = db.prepare(`
    INSERT INTO role_voice_time_reward_rule_claims (user_id, reward_rule_id, rewarded_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, reward_rule_id) DO UPDATE SET rewarded_at = excluded.rewarded_at
    WHERE role_voice_time_reward_rule_claims.rewarded_at < ?
  `).run(userId, rewardRuleId, rewardedAt, minimumRewardedAt);
  return result.changes > 0;
}

function getRoleVoiceTimeRoles(guildId) {
  return db.prepare('SELECT DISTINCT role_id FROM role_voice_time_channels WHERE guild_id = ? ORDER BY role_id').all(guildId).map((row) => row.role_id);
}

function getRoleVoiceTimeProfile(userId, guildId, roleId) {
  return db.prepare('SELECT total_seconds FROM role_voice_time_profiles WHERE user_id = ? AND guild_id = ? AND role_id = ?').get(userId, guildId, roleId) || { total_seconds: 0 };
}

function addRoleVoiceTimeSeconds(userId, guildId, roleId, seconds) {
  const clampedSeconds = Math.max(0, Math.floor(seconds));
  if (clampedSeconds === 0) return;
  const endedAt = Date.now();
  const startedAt = endedAt - (clampedSeconds * 1000);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO role_voice_time_profiles (user_id, guild_id, role_id, total_seconds) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id, role_id) DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds
    `).run(userId, guildId, roleId, clampedSeconds);
    db.prepare(`
      INSERT INTO role_voice_time_entries (user_id, guild_id, role_id, total_seconds, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, guildId, roleId, clampedSeconds, startedAt, endedAt);
  });
  tx();
}

function getRoleVoiceTimeProfiles(guildId, roleId) {
  return db.prepare('SELECT user_id, total_seconds FROM role_voice_time_profiles WHERE guild_id = ? AND role_id = ? ORDER BY total_seconds DESC, user_id ASC').all(guildId, roleId);
}

function getRoleVoiceTimeProfilesSince(guildId, roleId, since) {
  return db.prepare(`
    SELECT
      user_id,
      SUM(CASE
        WHEN started_at < ? THEN MAX(0, CAST((ended_at - ?) / 1000 AS INTEGER))
        ELSE total_seconds
      END) AS total_seconds
    FROM role_voice_time_entries
    WHERE guild_id = ? AND role_id = ? AND ended_at >= ?
    GROUP BY user_id
    ORDER BY total_seconds DESC, user_id ASC
  `).all(since, since, guildId, roleId, since);
}

function getActiveRoleVoiceTimeSession(userId, guildId, roleId) {
  return db.prepare('SELECT * FROM role_voice_time_sessions WHERE user_id = ? AND guild_id = ? AND role_id = ?').get(userId, guildId, roleId) || null;
}

function getActiveRoleVoiceTimeSessions(guildId) {
  return db.prepare('SELECT * FROM role_voice_time_sessions WHERE guild_id = ?').all(guildId);
}

function upsertRoleVoiceTimeSession(userId, guildId, roleId, channelId, joinedAt) {
  db.prepare(`
    INSERT INTO role_voice_time_sessions (user_id, guild_id, role_id, channel_id, joined_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, guild_id, role_id) DO UPDATE SET channel_id = excluded.channel_id, joined_at = excluded.joined_at
  `).run(userId, guildId, roleId, channelId, joinedAt);
}

function deleteRoleVoiceTimeSession(userId, guildId, roleId) {
  db.prepare('DELETE FROM role_voice_time_sessions WHERE user_id = ? AND guild_id = ? AND role_id = ?').run(userId, guildId, roleId);
}

function setLevelingThreshold(guildId, level, requiredSeconds) {
  db.prepare(`
    INSERT INTO leveling_thresholds (guild_id, level, required_seconds) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, level) DO UPDATE SET required_seconds = excluded.required_seconds
  `).run(guildId, level, requiredSeconds);
}

function setLevelingThresholdRange(guildId, startLevel, endLevel, requiredSeconds) {
  const tx = db.transaction(() => {
    for (let level = startLevel; level <= endLevel; level++) {
      setLevelingThreshold(guildId, level, requiredSeconds);
    }
  });

  tx();
}

function getLevelingThreshold(guildId, level) {
  return db.prepare('SELECT required_seconds FROM leveling_thresholds WHERE guild_id = ? AND level = ?').get(guildId, level) || null;
}

function getLevelingThresholds(guildId) {
  return db.prepare('SELECT level, required_seconds FROM leveling_thresholds WHERE guild_id = ? ORDER BY level').all(guildId);
}

function setLevelingRoleRange(guildId, startLevel, endLevel, roleId) {
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM leveling_roles
      WHERE guild_id = ?
        AND NOT (end_level < ? OR start_level > ?)
    `).run(guildId, startLevel, endLevel);

    db.prepare(`
      INSERT INTO leveling_roles (guild_id, start_level, end_level, role_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, start_level, end_level) DO UPDATE SET role_id = excluded.role_id
    `).run(guildId, startLevel, endLevel, roleId);
  });

  tx();
}

function getLevelingRoleRanges(guildId) {
  return db.prepare('SELECT start_level, end_level, role_id FROM leveling_roles WHERE guild_id = ? ORDER BY start_level').all(guildId);
}

function getLevelingRoleRangeForLevel(guildId, level) {
  return db.prepare(`
    SELECT start_level, end_level, role_id
    FROM leveling_roles
    WHERE guild_id = ? AND ? BETWEEN start_level AND end_level
    ORDER BY start_level DESC
    LIMIT 1
  `).get(guildId, level) || null;
}

function setRoleSalarySetting(guildId, roleId, amount) {
  const clamped = Math.max(0, Math.floor(amount));
  db.prepare(`
    INSERT INTO role_salary_settings (guild_id, role_id, amount) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, role_id) DO UPDATE SET amount = excluded.amount
  `).run(guildId, roleId, clamped);
}

function deleteRoleSalarySetting(guildId, roleId) {
  db.prepare('DELETE FROM role_salary_settings WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
}

function getRoleSalarySetting(guildId, roleId) {
  return db.prepare('SELECT amount FROM role_salary_settings WHERE guild_id = ? AND role_id = ?').get(guildId, roleId) || null;
}

function getRoleSalarySettings(guildId) {
  return db.prepare('SELECT role_id, amount FROM role_salary_settings WHERE guild_id = ? ORDER BY amount DESC').all(guildId);
}

function normalizePanelKey(panelKey) {
  const raw = String(panelKey || '').trim().toLowerCase();
  return raw || 'default';
}

function upsertVendingPanel(guildId, panelKey, channelId, messageId, title, description) {
  const key = normalizePanelKey(panelKey);
  db.prepare(`
    INSERT INTO vending_panels_multi (guild_id, panel_key, channel_id, message_id, title, description)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      title = excluded.title,
      description = excluded.description
  `).run(guildId, key, channelId, messageId, title, description);
}

function getVendingPanel(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  return db.prepare('SELECT * FROM vending_panels_multi WHERE guild_id = ? AND panel_key = ?').get(guildId, key) || null;
}

function getVendingPanels(guildId) {
  return db.prepare('SELECT * FROM vending_panels_multi WHERE guild_id = ? ORDER BY panel_key').all(guildId);
}

function deleteVendingPanel(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  const tx = db.transaction(() => {
    const productsDeleted = db.prepare('DELETE FROM vending_products_multi WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
    const panelDeleted = db.prepare('DELETE FROM vending_panels_multi WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
    return { panelDeleted, productsDeleted };
  });
  return tx();
}

function setVendingLogChannel(guildId, panelKey, channelId) {
  const key = normalizePanelKey(panelKey);
  db.prepare(`
    INSERT INTO vending_panels_multi (guild_id, panel_key, channel_id, message_id, title, description, log_channel_id)
    VALUES (?, ?, '', '', '自販機', 'ロール購入パネル', ?)
    ON CONFLICT(guild_id, panel_key) DO UPDATE SET log_channel_id = excluded.log_channel_id
  `).run(guildId, key, channelId || null);
}

function getVendingLogChannel(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  const row = db.prepare('SELECT log_channel_id FROM vending_panels_multi WHERE guild_id = ? AND panel_key = ?').get(guildId, key);
  return row ? row.log_channel_id : null;
}

function setVendingProduct(guildId, panelKey, slot, label, roleId, price, durationMinutes) {
  const key = normalizePanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  const safePrice = Math.max(1, Math.floor(price));
  const safeDuration = Math.max(1, Math.floor(durationMinutes));
  db.prepare(`
    INSERT INTO vending_products_multi (guild_id, panel_key, slot, label, role_id, price, duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_key, slot) DO UPDATE SET
      label = excluded.label,
      role_id = excluded.role_id,
      price = excluded.price,
      duration_minutes = excluded.duration_minutes
  `).run(guildId, key, safeSlot, label, roleId, safePrice, safeDuration);
}

function deleteVendingProduct(guildId, panelKey, slot) {
  const key = normalizePanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  return db.prepare('DELETE FROM vending_products_multi WHERE guild_id = ? AND panel_key = ? AND slot = ?').run(guildId, key, safeSlot).changes;
}

function getVendingProduct(guildId, panelKey, slot) {
  const key = normalizePanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  return db.prepare('SELECT slot, label, role_id, price, duration_minutes FROM vending_products_multi WHERE guild_id = ? AND panel_key = ? AND slot = ?').get(guildId, key, safeSlot) || null;
}

function getVendingProducts(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  return db.prepare('SELECT slot, label, role_id, price, duration_minutes FROM vending_products_multi WHERE guild_id = ? AND panel_key = ? ORDER BY slot').all(guildId, key);
}

function upsertVendingPurchase(guildId, userId, roleId, expiresAt) {
  const safeExpiresAt = Math.max(0, Math.floor(expiresAt));
  db.prepare(`
    INSERT INTO vending_purchases (guild_id, user_id, role_id, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, role_id) DO UPDATE SET expires_at = excluded.expires_at
  `).run(guildId, userId, roleId, safeExpiresAt);
}

function getVendingPurchase(guildId, userId, roleId) {
  return db.prepare('SELECT expires_at FROM vending_purchases WHERE guild_id = ? AND user_id = ? AND role_id = ?').get(guildId, userId, roleId) || null;
}

function getExpiredVendingPurchases(nowMs) {
  return db.prepare('SELECT guild_id, user_id, role_id, expires_at FROM vending_purchases WHERE expires_at <= ? ORDER BY expires_at ASC').all(Math.max(0, Math.floor(nowMs)));
}

function deleteVendingPurchase(guildId, userId, roleId) {
  return db.prepare('DELETE FROM vending_purchases WHERE guild_id = ? AND user_id = ? AND role_id = ?').run(guildId, userId, roleId).changes;
}

function upsertVcVendingPanel(guildId, panelKey, channelId, messageId, title, description) {
  const key = normalizePanelKey(panelKey);
  db.prepare(`
    INSERT INTO vc_vending_panels_multi (guild_id, panel_key, channel_id, message_id, title, description)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      title = excluded.title,
      description = excluded.description
  `).run(guildId, key, channelId, messageId, title, description);
}

function getVcVendingPanel(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  return db.prepare('SELECT * FROM vc_vending_panels_multi WHERE guild_id = ? AND panel_key = ?').get(guildId, key) || null;
}

function getVcVendingPanels(guildId) {
  return db.prepare('SELECT * FROM vc_vending_panels_multi WHERE guild_id = ? ORDER BY panel_key').all(guildId);
}

function setVcVendingLogChannel(guildId, panelKey, channelId) {
  const key = normalizePanelKey(panelKey);
  db.prepare(`
    INSERT INTO vc_vending_panels_multi (guild_id, panel_key, channel_id, message_id, title, description, log_channel_id)
    VALUES (?, ?, '', '', 'VC自販機', 'VC公開/非公開設定パネル', ?)
    ON CONFLICT(guild_id, panel_key) DO UPDATE SET log_channel_id = excluded.log_channel_id
  `).run(guildId, key, channelId || null);
}

function getVcVendingLogChannel(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  const row = db.prepare('SELECT log_channel_id FROM vc_vending_panels_multi WHERE guild_id = ? AND panel_key = ?').get(guildId, key);
  return row ? row.log_channel_id : null;
}

function normalizeVcVisibilityMode(mode) {
  const raw = String(mode || '').trim().toLowerCase();
  return raw === 'public' ? 'public' : 'private';
}

function setVcVendingProduct(guildId, panelKey, slot, label, categoryId, visibilityRoleId, userLimit, visibilityMode, price, extensionPrice, durationMinutes, extensionDurationMinutes) {
  const key = normalizePanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  const roleIds = [...new Set((Array.isArray(visibilityRoleId) ? visibilityRoleId : String(visibilityRoleId || '').split(','))
    .map(id => String(id).trim())
    .filter(Boolean))].join(',');
  const safePrice = Math.max(1, Math.floor(price));
  const safeExtensionPrice = Math.max(1, Math.floor(extensionPrice));
  const safeExtensionDuration = Math.max(1, Math.floor(extensionDurationMinutes));
  const safeUserLimit = Math.max(0, Math.min(99, Math.floor(userLimit)));
  const safeDuration = Math.max(1, Math.floor(durationMinutes));
  const mode = normalizeVcVisibilityMode(visibilityMode);
  db.prepare(`
    INSERT INTO vc_vending_products_multi (guild_id, panel_key, slot, label, voice_channel_id, category_id, visibility_role_id, user_limit, visibility_mode, price, extension_price, extension_duration_minutes, duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_key, slot) DO UPDATE SET
      label = excluded.label,
      voice_channel_id = excluded.voice_channel_id,
      category_id = excluded.category_id,
      visibility_role_id = excluded.visibility_role_id,
      user_limit = excluded.user_limit,
      visibility_mode = excluded.visibility_mode,
      price = excluded.price,
      extension_price = excluded.extension_price,
        extension_duration_minutes = excluded.extension_duration_minutes,
      duration_minutes = excluded.duration_minutes
      `).run(guildId, key, safeSlot, label, categoryId, categoryId, roleIds, safeUserLimit, mode, safePrice, safeExtensionPrice, safeExtensionDuration, safeDuration);
}

function deleteVcVendingProduct(guildId, panelKey, slot) {
  const key = normalizePanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  return db.prepare('DELETE FROM vc_vending_products_multi WHERE guild_id = ? AND panel_key = ? AND slot = ?').run(guildId, key, safeSlot).changes;
}

function getVcVendingProduct(guildId, panelKey, slot) {
  const key = normalizePanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  return db.prepare('SELECT * FROM vc_vending_products_multi WHERE guild_id = ? AND panel_key = ? AND slot = ?').get(guildId, key, safeSlot) || null;
}

function getVcVendingProducts(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  return db.prepare('SELECT * FROM vc_vending_products_multi WHERE guild_id = ? AND panel_key = ? ORDER BY slot').all(guildId, key);
}

function deleteVcVendingPanel(guildId, panelKey) {
  const key = normalizePanelKey(panelKey);
  const tx = db.transaction(() => {
    const productsDeleted = db.prepare('DELETE FROM vc_vending_products_multi WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
    const panelDeleted = db.prepare('DELETE FROM vc_vending_panels_multi WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
    return { panelDeleted, productsDeleted };
  });
  return tx();
}

function upsertVcVendingPurchase(guildId, voiceChannelId, mode, buyerId, expiresAt, isTemporary = 0, templateVoiceChannelId = null, textChannelId = null, extensionPrice = 1, durationMinutes = 1, extensionDurationMinutes = 1) {
  const safeExpiresAt = Math.max(0, Math.floor(expiresAt));
  const safeExtensionPrice = Math.max(1, Math.floor(extensionPrice));
  const safeDuration = Math.max(1, Math.floor(durationMinutes));
  const safeExtensionDuration = Math.max(1, Math.floor(extensionDurationMinutes));
  const normalizedMode = normalizeVcVisibilityMode(mode);
  const temporaryFlag = isTemporary ? 1 : 0;
  db.prepare(`
    INSERT INTO vc_vending_purchases (guild_id, voice_channel_id, template_voice_channel_id, text_channel_id, mode, buyer_id, is_temporary, extension_price, duration_minutes, extension_duration_minutes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, voice_channel_id) DO UPDATE SET
      template_voice_channel_id = excluded.template_voice_channel_id,
      text_channel_id = excluded.text_channel_id,
      mode = excluded.mode,
      buyer_id = excluded.buyer_id,
      is_temporary = excluded.is_temporary,
        extension_price = excluded.extension_price,
        duration_minutes = excluded.duration_minutes,
          extension_duration_minutes = excluded.extension_duration_minutes,
          expires_at = excluded.expires_at
        `).run(guildId, voiceChannelId, templateVoiceChannelId || null, textChannelId || null, normalizedMode, buyerId, temporaryFlag, safeExtensionPrice, safeDuration, safeExtensionDuration, safeExpiresAt);
}

function getVcVendingPurchase(guildId, voiceChannelId) {
  return db.prepare('SELECT mode, buyer_id, is_temporary, template_voice_channel_id, text_channel_id, panel_message_id, extension_price, duration_minutes, extension_duration_minutes, expires_at FROM vc_vending_purchases WHERE guild_id = ? AND voice_channel_id = ?').get(guildId, voiceChannelId) || null;
}

function setVcVendingPurchasePanelMessage(guildId, voiceChannelId, messageId) {
  db.prepare('UPDATE vc_vending_purchases SET panel_message_id = ? WHERE guild_id = ? AND voice_channel_id = ?').run(messageId || null, guildId, voiceChannelId);
}

function getVcVendingPurchaseByBuyerAndTemplate(guildId, buyerId, templateVoiceChannelId) {
  return db.prepare('SELECT mode, buyer_id, is_temporary, template_voice_channel_id, text_channel_id, voice_channel_id, expires_at FROM vc_vending_purchases WHERE guild_id = ? AND buyer_id = ? AND template_voice_channel_id = ?').get(guildId, buyerId, templateVoiceChannelId) || null;
}

function getExpiredVcVendingPurchases(nowMs) {
  return db.prepare('SELECT guild_id, voice_channel_id, template_voice_channel_id, text_channel_id, mode, buyer_id, is_temporary, extension_price, duration_minutes, expires_at FROM vc_vending_purchases WHERE expires_at <= ? ORDER BY expires_at ASC').all(Math.max(0, Math.floor(nowMs)));
}

function deleteVcVendingPurchase(guildId, voiceChannelId) {
  return db.prepare('DELETE FROM vc_vending_purchases WHERE guild_id = ? AND voice_channel_id = ?').run(guildId, voiceChannelId).changes;
}

function extendVcVendingPurchase(guildId, voiceChannelId, expiresAt) {
  return db.prepare('UPDATE vc_vending_purchases SET expires_at = ? WHERE guild_id = ? AND voice_channel_id = ?').run(Math.max(0, Math.floor(expiresAt)), guildId, voiceChannelId).changes;
}

function normalizeGachaPanelKey(panelKey) {
  const raw = String(panelKey || '').trim().toLowerCase();
  return raw || 'default';
}

function upsertGachaPanel(guildId, panelKey, channelId, messageId, title, description) {
  const key = normalizeGachaPanelKey(panelKey);
  db.prepare(`
    INSERT INTO gacha_panels (guild_id, panel_key, channel_id, message_id, title, description)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      title = excluded.title,
      description = excluded.description
  `).run(guildId, key, channelId, messageId, title, description);
}

function getGachaPanel(guildId, panelKey) {
  const key = normalizeGachaPanelKey(panelKey);
  return db.prepare('SELECT * FROM gacha_panels WHERE guild_id = ? AND panel_key = ?').get(guildId, key) || null;
}

function getGachaPanels(guildId) {
  return db.prepare('SELECT * FROM gacha_panels WHERE guild_id = ? ORDER BY panel_key').all(guildId);
}

function setGachaProduct(guildId, panelKey, slot, label, roleId, price, quantity = 1, tenPullPrice = 0) {
  const key = normalizeGachaPanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  const safePrice = Math.max(0, Math.floor(price));
  const safeQuantity = Math.max(1, Math.floor(quantity));
  const safeTenPullPrice = Math.max(0, Math.floor(tenPullPrice));
  db.prepare(`
    INSERT INTO gacha_products (guild_id, panel_key, slot, label, role_id, price, ten_pull_price, quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_key, slot) DO UPDATE SET
      label = excluded.label,
      role_id = excluded.role_id,
      price = excluded.price,
      ten_pull_price = excluded.ten_pull_price,
      quantity = excluded.quantity
  `).run(guildId, key, safeSlot, label, roleId, safePrice, safeTenPullPrice, safeQuantity);
}

function deleteGachaProduct(guildId, panelKey, slot) {
  const key = normalizeGachaPanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  return db.prepare('DELETE FROM gacha_products WHERE guild_id = ? AND panel_key = ? AND slot = ?').run(guildId, key, safeSlot).changes;
}

function deleteAllGachaProducts(guildId, panelKey) {
  const key = normalizeGachaPanelKey(panelKey);
  return db.prepare('DELETE FROM gacha_products WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
}

function getGachaProduct(guildId, panelKey, slot) {
  const key = normalizeGachaPanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  return db.prepare('SELECT slot, label, role_id, price, ten_pull_price, quantity FROM gacha_products WHERE guild_id = ? AND panel_key = ? AND slot = ?').get(guildId, key, safeSlot) || null;
}

function getGachaProducts(guildId, panelKey) {
  const key = normalizeGachaPanelKey(panelKey);
  return db.prepare('SELECT slot, label, role_id, price, ten_pull_price, quantity FROM gacha_products WHERE guild_id = ? AND panel_key = ? ORDER BY slot').all(guildId, key);
}

function consumeGachaProduct(guildId, panelKey, slot) {
  const key = normalizeGachaPanelKey(panelKey);
  const safeSlot = Math.max(1, Math.min(5, Math.floor(slot)));
  const row = db.prepare('SELECT slot, label, role_id, price, ten_pull_price, quantity FROM gacha_products WHERE guild_id = ? AND panel_key = ? AND slot = ?').get(guildId, key, safeSlot);
  if (!row || row.quantity <= 0) return null;
  const nextQuantity = row.quantity - 1;
  db.prepare('UPDATE gacha_products SET quantity = ? WHERE guild_id = ? AND panel_key = ? AND slot = ?').run(nextQuantity, guildId, key, safeSlot);
  return { ...row, quantity: nextQuantity };
}

function closeDatabase() {
  db.close();
}

function normalizeBoxGachaKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || 'default';
}

function normalizeRarity(value) {
  const rarity = String(value || '').trim().toUpperCase();
  if (['N', 'R', 'SR', 'SSR', 'UR'].includes(rarity)) {
    return rarity;
  }
  return 'N';
}

function nowMs() {
  return Date.now();
}

function upsertBoxGacha(guildId, gachaKey, name, singlePrice, tenPrice) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeSingle = Math.max(0, Math.floor(singlePrice));
  const safeTen = Math.max(0, Math.floor(tenPrice));
  const now = nowMs();
  db.prepare(`
    INSERT INTO box_gachas (guild_id, gacha_key, name, single_price, ten_price, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, gacha_key) DO UPDATE SET
      name = excluded.name,
      single_price = excluded.single_price,
      ten_price = excluded.ten_price,
      updated_at = excluded.updated_at
  `).run(guildId, key, String(name || '').trim(), safeSingle, safeTen, now, now);
}

function getBoxGacha(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare('SELECT guild_id, gacha_key, name, single_price, ten_price, created_at, updated_at FROM box_gachas WHERE guild_id = ? AND gacha_key = ?').get(guildId, key) || null;
}

function getBoxGachaSettings(guildId) {
  return db.prepare(`
    SELECT
      g.gacha_key,
      g.name,
      g.single_price,
      g.ten_price,
      p.channel_id,
      p.message_id,
      p.title,
      p.description,
      l.channel_id AS log_channel_id
    FROM box_gachas g
    LEFT JOIN box_gacha_panels p ON p.guild_id = g.guild_id AND p.gacha_key = g.gacha_key
    LEFT JOIN box_gacha_log_channels l ON l.guild_id = g.guild_id AND l.gacha_key = g.gacha_key
    WHERE g.guild_id = ?
    ORDER BY g.gacha_key
  `).all(guildId);
}

function setBoxGachaPrices(guildId, gachaKey, singlePrice, tenPrice) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeSingle = Math.max(0, Math.floor(singlePrice));
  const safeTen = Math.max(0, Math.floor(tenPrice));
  return db.prepare('UPDATE box_gachas SET single_price = ?, ten_price = ?, updated_at = ? WHERE guild_id = ? AND gacha_key = ?').run(safeSingle, safeTen, nowMs(), guildId, key).changes;
}

function addBoxGachaProduct(guildId, gachaKey, productName, quantity, rarity) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeName = String(productName || '').trim();
  const safeQuantity = Math.max(1, Math.floor(quantity));
  const safeRarity = normalizeRarity(rarity);
  const now = nowMs();

  db.prepare(`
    INSERT INTO box_gacha_products (guild_id, gacha_key, product_name, rarity, initial_quantity, remaining_quantity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, gacha_key, product_name) DO UPDATE SET
      rarity = excluded.rarity,
      initial_quantity = box_gacha_products.initial_quantity + excluded.initial_quantity,
      remaining_quantity = box_gacha_products.remaining_quantity + excluded.remaining_quantity,
      updated_at = excluded.updated_at
  `).run(guildId, key, safeName, safeRarity, safeQuantity, safeQuantity, now, now);
}

function deleteBoxGachaProduct(guildId, gachaKey, productName) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeName = String(productName || '').trim();
  return db.prepare('DELETE FROM box_gacha_products WHERE guild_id = ? AND gacha_key = ? AND product_name = ?').run(guildId, key, safeName).changes;
}

function getBoxGachaProducts(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare(`
    SELECT id, product_name, rarity, initial_quantity, remaining_quantity
    FROM box_gacha_products
    WHERE guild_id = ? AND gacha_key = ?
    ORDER BY CASE rarity
      WHEN 'UR' THEN 1
      WHEN 'SSR' THEN 2
      WHEN 'SR' THEN 3
      WHEN 'R' THEN 4
      ELSE 5
    END, product_name
  `).all(guildId, key);
}

function getBoxGachaProductByName(guildId, gachaKey, productName) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeName = String(productName || '').trim();
  return db.prepare('SELECT id, product_name, rarity, initial_quantity, remaining_quantity FROM box_gacha_products WHERE guild_id = ? AND gacha_key = ? AND product_name = ?').get(guildId, key, safeName) || null;
}

function countBoxGachaRemainingByRarity(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  const rows = db.prepare(`
    SELECT rarity, SUM(remaining_quantity) AS remaining
    FROM box_gacha_products
    WHERE guild_id = ? AND gacha_key = ?
    GROUP BY rarity
  `).all(guildId, key);
  const result = { N: 0, R: 0, SR: 0, SSR: 0, UR: 0, total: 0 };
  for (const row of rows) {
    const rarity = normalizeRarity(row.rarity);
    const value = Math.max(0, Number(row.remaining || 0));
    result[rarity] = value;
    result.total += value;
  }
  return result;
}

function getBoxGachaRemainingTotal(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  const row = db.prepare('SELECT SUM(remaining_quantity) AS total FROM box_gacha_products WHERE guild_id = ? AND gacha_key = ?').get(guildId, key);
  return Math.max(0, Number(row?.total || 0));
}

function setBoxGachaNextProduct(guildId, gachaKey, productName, setByUserId) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeName = String(productName || '').trim();
  db.prepare(`
    INSERT INTO box_gacha_next_products (guild_id, gacha_key, product_name, set_by_user_id, set_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, gacha_key) DO UPDATE SET
      product_name = excluded.product_name,
      set_by_user_id = excluded.set_by_user_id,
      set_at = excluded.set_at
  `).run(guildId, key, safeName, String(setByUserId), nowMs());
}

function getBoxGachaNextProduct(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare('SELECT product_name, set_by_user_id, set_at FROM box_gacha_next_products WHERE guild_id = ? AND gacha_key = ?').get(guildId, key) || null;
}

function clearBoxGachaNextProduct(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare('DELETE FROM box_gacha_next_products WHERE guild_id = ? AND gacha_key = ?').run(guildId, key).changes;
}

function resetBoxGacha(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  const tx = db.transaction(() => {
    const resetCount = db.prepare('UPDATE box_gacha_products SET remaining_quantity = initial_quantity, updated_at = ? WHERE guild_id = ? AND gacha_key = ?').run(nowMs(), guildId, key).changes;
    db.prepare('DELETE FROM box_gacha_next_products WHERE guild_id = ? AND gacha_key = ?').run(guildId, key);
    return resetCount;
  });
  return tx();
}

function clearBoxGachaProducts(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare('DELETE FROM box_gacha_products WHERE guild_id = ? AND gacha_key = ?').run(guildId, key).changes;
}

function upsertBoxGachaPanel(guildId, gachaKey, channelId, messageId, title, description) {
  const key = normalizeBoxGachaKey(gachaKey);
  db.prepare(`
    INSERT INTO box_gacha_panels (guild_id, gacha_key, channel_id, message_id, title, description)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, gacha_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      title = excluded.title,
      description = excluded.description
  `).run(guildId, key, channelId, messageId, title, description);
}

function getBoxGachaPanel(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare('SELECT guild_id, gacha_key, channel_id, message_id, title, description FROM box_gacha_panels WHERE guild_id = ? AND gacha_key = ?').get(guildId, key) || null;
}

function deleteBoxGachaPanel(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  return db.prepare('DELETE FROM box_gacha_panels WHERE guild_id = ? AND gacha_key = ?').run(guildId, key).changes;
}

function setBoxGachaLogChannel(guildId, gachaKey, channelId) {
  const key = normalizeBoxGachaKey(gachaKey);
  db.prepare(`
    INSERT INTO box_gacha_log_channels (guild_id, gacha_key, channel_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, gacha_key) DO UPDATE SET
      channel_id = excluded.channel_id
  `).run(guildId, key, channelId);
}

function getBoxGachaLogChannel(guildId, gachaKey) {
  const key = normalizeBoxGachaKey(gachaKey);
  const row = db.prepare('SELECT channel_id FROM box_gacha_log_channels WHERE guild_id = ? AND gacha_key = ?').get(guildId, key);
  return row ? row.channel_id : null;
}

function pickProductIndexByRemaining(rows, totalRemaining) {
  let ticket = (Math.random() * totalRemaining) + 1;
  for (let i = 0; i < rows.length; i += 1) {
    ticket -= rows[i].remaining_quantity;
    if (ticket <= 0) {
      return i;
    }
  }
  return rows.length - 1;
}

function drawBoxGacha(guildId, gachaKey, drawCount) {
  const key = normalizeBoxGachaKey(gachaKey);
  const safeDrawCount = Math.max(1, Math.floor(drawCount));

  const tx = db.transaction(() => {
    const rows = db.prepare('SELECT id, product_name, rarity, remaining_quantity FROM box_gacha_products WHERE guild_id = ? AND gacha_key = ? AND remaining_quantity > 0').all(guildId, key);
    let totalRemaining = rows.reduce((sum, row) => sum + Math.max(0, Number(row.remaining_quantity)), 0);

    if (totalRemaining < safeDrawCount) {
      return { ok: false, reason: 'insufficient', remainingUnits: totalRemaining };
    }

    const picked = [];
    const decrements = new Map();

    const forced = getBoxGachaNextProduct(guildId, key);
    if (forced && picked.length < safeDrawCount) {
      const forcedRow = rows.find(row => row.product_name === forced.product_name && row.remaining_quantity > 0);
      if (forcedRow) {
        picked.push({ id: forcedRow.id, product_name: forcedRow.product_name, rarity: normalizeRarity(forcedRow.rarity) });
        forcedRow.remaining_quantity -= 1;
        totalRemaining -= 1;
        decrements.set(forcedRow.id, (decrements.get(forcedRow.id) || 0) + 1);
      }
      clearBoxGachaNextProduct(guildId, key);
    }

    while (picked.length < safeDrawCount) {
      if (totalRemaining <= 0) {
        return { ok: false, reason: 'insufficient', remainingUnits: totalRemaining };
      }

      const pickedIndex = pickProductIndexByRemaining(rows, totalRemaining);
      const row = rows[pickedIndex];
      if (!row || row.remaining_quantity <= 0) {
        continue;
      }

      picked.push({ id: row.id, product_name: row.product_name, rarity: normalizeRarity(row.rarity) });
      row.remaining_quantity -= 1;
      totalRemaining -= 1;
      decrements.set(row.id, (decrements.get(row.id) || 0) + 1);
    }

    const now = nowMs();
    const updateStmt = db.prepare('UPDATE box_gacha_products SET remaining_quantity = remaining_quantity - ?, updated_at = ? WHERE id = ? AND remaining_quantity >= ?');
    for (const [id, amount] of decrements.entries()) {
      updateStmt.run(amount, now, id, amount);
    }

    return { ok: true, results: picked };
  });

  return tx();
}

function deleteGachaPanel(guildId, panelKey) {
  const key = normalizeGachaPanelKey(panelKey);
  const tx = db.transaction(() => {
    const productsDeleted = db.prepare('DELETE FROM gacha_products WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
    const panelDeleted = db.prepare('DELETE FROM gacha_panels WHERE guild_id = ? AND panel_key = ?').run(guildId, key).changes;
    return { panelDeleted, productsDeleted };
  });
  return tx();
}

function getVcTransferCount(guildId) {
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM vc_transfer_settings WHERE guild_id = ?').get(guildId);
    return row ? row.count : 0;
  } catch (_) { return 0; }
}

function getTicketPanelCount(guildId) {
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM ticket_panels WHERE guild_id = ?').get(guildId);
    return row ? row.count : 0;
  } catch (_) { return 0; }
}

function getReactionRoleMessageCount(guildId) {
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM reaction_role_messages WHERE guild_id = ?').get(guildId);
    return row ? row.count : 0;
  } catch (_) { return 0; }
}

function getAppStateJson(namespace, key) {
  try {
    const row = db.prepare('SELECT value_json FROM app_state WHERE namespace = ? AND state_key = ?').get(namespace, key);
    if (!row?.value_json) return null;
    return JSON.parse(row.value_json);
  } catch (_) { return null; }
}

module.exports = {
  getBalance,
  setBalance,
  resetAllBalances,
  addBalance,
  subtractBalance,
  transfer,
  getSettings,
  setTransferLogChannel,
  setGrantLogChannel,
  setDeductionLogChannel,
  setInterviewLogChannel,
  setLevelingLogChannel,
  setLevelingVoiceChannel,
  setInterviewSettings,
  setEvaluationSettings,
  setRoleDisplayExcludeRole,
  setRoleDisplayIncludeRoles,
  addPermittedRole,
  getPermittedRoles,
  addCurrencySupportRole,
  removeCurrencySupportRole,
  getCurrencySupportRoles,
  setCurrencyUnit,
  setBankTransferRoles,
  getBankTransferRoles,
  upsertBankPanel,
  getBankPanels,
  getLevelingProfile,
  getLevelingProfiles,
  setLevelingProfile,
  addLevelingSeconds,
  setLevelingLastLevel,
  setInterviewEvaluationPassedAt,
  getInterviewEvaluation,
  deleteInterviewEvaluation,
  resetAllInterviewEvaluations,
  getInterviewEvaluations,
  getActiveLevelingSession,
  getActiveLevelingSessions,
  upsertLevelingSession,
  updateLevelingSessionChannel,
  deleteLevelingSession,
  resetAllLevelingData,
  setRoleVoiceTimeChannels,
  getRoleVoiceTimeChannels,
  setRoleVoiceTimePeriodDays,
  getRoleVoiceTimePeriodDays,
  setRoleVoiceTimeReward,
  deleteRoleVoiceTimeReward,
  getRoleVoiceTimeRewards,
  claimRoleVoiceTimeReward,
  getRoleVoiceTimeRoles,
  getRoleVoiceTimeProfile,
  addRoleVoiceTimeSeconds,
  getRoleVoiceTimeProfiles,
  getRoleVoiceTimeProfilesSince,
  getActiveRoleVoiceTimeSession,
  getActiveRoleVoiceTimeSessions,
  upsertRoleVoiceTimeSession,
  deleteRoleVoiceTimeSession,
  setLevelingThreshold,
  setLevelingThresholdRange,
  getLevelingThreshold,
  getLevelingThresholds,
  setLevelingRoleRange,
  getLevelingRoleRanges,
  getLevelingRoleRangeForLevel,
  setRoleSalarySetting,
  deleteRoleSalarySetting,
  getRoleSalarySetting,
  getRoleSalarySettings,
  upsertVendingPanel,
  getVendingPanel,
  getVendingPanels,
  deleteVendingPanel,
  setVendingLogChannel,
  getVendingLogChannel,
  setVendingProduct,
  deleteVendingProduct,
  getVendingProduct,
  getVendingProducts,
  upsertVendingPurchase,
  getVendingPurchase,
  getExpiredVendingPurchases,
  deleteVendingPurchase,
  upsertVcVendingPanel,
  getVcVendingPanel,
  getVcVendingPanels,
  setVcVendingLogChannel,
  getVcVendingLogChannel,
  setVcVendingProduct,
  deleteVcVendingProduct,
  getVcVendingProduct,
  getVcVendingProducts,
  deleteVcVendingPanel,
  upsertVcVendingPurchase,
  getVcVendingPurchase,
  setVcVendingPurchasePanelMessage,
  getVcVendingPurchaseByBuyerAndTemplate,
  getExpiredVcVendingPurchases,
  deleteVcVendingPurchase,
  extendVcVendingPurchase,
  upsertGachaPanel,
  getGachaPanel,
  getGachaPanels,
  setGachaProduct,
  deleteGachaProduct,
  deleteAllGachaProducts,
  getGachaProduct,
  getGachaProducts,
  consumeGachaProduct,
  closeDatabase,
  deleteGachaPanel,
  normalizeBoxGachaKey,
  normalizeRarity,
  upsertBoxGacha,
  getBoxGacha,
  getBoxGachaSettings,
  setBoxGachaPrices,
  addBoxGachaProduct,
  deleteBoxGachaProduct,
  getBoxGachaProducts,
  getBoxGachaProductByName,
  countBoxGachaRemainingByRarity,
  getBoxGachaRemainingTotal,
  setBoxGachaNextProduct,
  getBoxGachaNextProduct,
  clearBoxGachaNextProduct,
  resetBoxGacha,
  clearBoxGachaProducts,
  upsertBoxGachaPanel,
  getBoxGachaPanel,
  deleteBoxGachaPanel,
  setBoxGachaLogChannel,
  getBoxGachaLogChannel,
  drawBoxGacha,
  getVcTransferCount,
  getTicketPanelCount,
  getReactionRoleMessageCount,
  getAppStateJson,
};