const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function resolveDatabasePath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  const dataDir = process.env.DATA_DIR
    ? process.env.DATA_DIR
    : path.join(__dirname, 'data');

  return path.join(dataDir, 'currency.db');
}

const dbPath = resolveDatabasePath();
const dbDir = path.dirname(dbPath);
const legacyDbPath = path.join(__dirname, 'currency.db');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  fs.copyFileSync(legacyDbPath, dbPath);
}

const db = new Database(dbPath);

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
    grant_amount INTEGER DEFAULT 0,
    log_channel_id TEXT,
    grant_log_channel_id TEXT,
    deduction_log_channel_id TEXT,
    interview_log_channel_id TEXT,
    blackjack_log_channel_id TEXT,
    all_log_channel_id TEXT,
    currency_unit TEXT DEFAULT 'コイン'
  );

  CREATE TABLE IF NOT EXISTS permitted_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS vc_transfer_settings (
    guild_id TEXT NOT NULL,
    parent_vc_id TEXT NOT NULL,
    base_name TEXT NOT NULL,
    category_id TEXT NOT NULL,
    log_channel_id TEXT,
    visible_role_ids TEXT,
    connect_role_ids TEXT,
    permission_role_id TEXT,
    lock_role_id TEXT,
    unlock_role_id TEXT,
    hide_role_id TEXT,
    show_role_id TEXT,
    delete_role_id TEXT,
    PRIMARY KEY (guild_id, parent_vc_id)
  );

  CREATE TABLE IF NOT EXISTS child_vcs (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    parent_vc_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
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
    emoji TEXT,
    purchase_log_channel_id TEXT,
    purchase_enabled INTEGER NOT NULL DEFAULT 0,
    role1_id TEXT,
    role2_id TEXT,
    role3_id TEXT
  );

  CREATE TABLE IF NOT EXISTS inquiry_forum_settings (
    guild_id TEXT PRIMARY KEY,
    panel_channel_id TEXT,
    panel_message_id TEXT,
    panel_title TEXT NOT NULL DEFAULT 'お問い合わせ窓口',
    panel_description TEXT NOT NULL DEFAULT 'お問い合わせ内容に合う受付を選択してください。'
  );

  CREATE TABLE IF NOT EXISTS inquiry_forum_items (
    guild_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    forum_channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    emoji TEXT,
    log_channel_id TEXT,
    auto_message TEXT,
    purchase_log_channel_id TEXT,
    purchase_enabled INTEGER NOT NULL DEFAULT 0,
    role1_id TEXT,
    role2_id TEXT,
    role3_id TEXT,
    PRIMARY KEY (guild_id, item_key)
  );

  CREATE TABLE IF NOT EXISTS inquiry_forum_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    creator_id TEXT NOT NULL,
    item_key TEXT NOT NULL
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
`);

try { db.exec('ALTER TABLE settings ADD COLUMN grant_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN deduction_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN interview_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN blackjack_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN all_log_channel_id TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE settings ADD COLUMN currency_unit TEXT DEFAULT 'コイン'"); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN join_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN leave_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN snuggle_min INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN snuggle_max INTEGER DEFAULT 100'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN snuggle_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE settings ADD COLUMN message_link_preview_enabled INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE inquiry_forum_items ADD COLUMN log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE inquiry_forum_items ADD COLUMN auto_message TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE ticket_panels ADD COLUMN purchase_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE ticket_panels ADD COLUMN purchase_enabled INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE ticket_panels ADD COLUMN emoji TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE inquiry_forum_items ADD COLUMN purchase_log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE inquiry_forum_items ADD COLUMN purchase_enabled INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE child_vcs ADD COLUMN owner_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN permission_role_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN log_channel_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN lock_role_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN unlock_role_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN hide_role_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN show_role_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN delete_role_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN visible_role_ids TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE vc_transfer_settings ADD COLUMN connect_role_ids TEXT'); } catch (_) {}

db.exec(`
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
`);

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

function addBalance(userId, guildId, amount) {
  const current = getBalance(userId, guildId);
  setBalance(userId, guildId, current + amount);
}

function subtractBalance(userId, guildId, amount) {
  const current = getBalance(userId, guildId);
  const newBalance = Math.max(0, current - amount);
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

function setLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id`).run(guildId, channelId);
}

function setGrantLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, grant_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET grant_log_channel_id = excluded.grant_log_channel_id`).run(guildId, channelId);
}

function setDeductionLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, deduction_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET deduction_log_channel_id = excluded.deduction_log_channel_id`).run(guildId, channelId);
}

function setInterviewLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, interview_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET interview_log_channel_id = excluded.interview_log_channel_id`).run(guildId, channelId);
}

function setBlackjackLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, blackjack_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET blackjack_log_channel_id = excluded.blackjack_log_channel_id`).run(guildId, channelId);
}

function addPermittedRole(guildId, roleId) {
  db.prepare('INSERT OR IGNORE INTO permitted_roles (guild_id, role_id) VALUES (?, ?)').run(guildId, roleId);
}

function getPermittedRoles(guildId) {
  const rows = db.prepare('SELECT role_id FROM permitted_roles WHERE guild_id = ?').all(guildId);
  return rows.map(r => r.role_id);
}

function setCurrencyUnit(guildId, unit) {
  db.prepare(`INSERT INTO settings (guild_id, currency_unit) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET currency_unit = excluded.currency_unit`).run(guildId, unit);
}

function setJoinLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, join_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET join_log_channel_id = excluded.join_log_channel_id`).run(guildId, channelId);
}

function setLeaveLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, leave_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET leave_log_channel_id = excluded.leave_log_channel_id`).run(guildId, channelId);
}

function setAllLogChannel(guildId, channelId) {
  db.prepare(`INSERT INTO settings (guild_id, all_log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET all_log_channel_id = excluded.all_log_channel_id`).run(guildId, channelId);
}

function setVcTransfer(guildId, parentVcId, baseName, categoryId, roles = {}) {
  const visibleRoleIds = Array.isArray(roles.visibleRoleIds) && roles.visibleRoleIds.length > 0
    ? JSON.stringify(roles.visibleRoleIds)
    : null;
  const connectRoleIds = Array.isArray(roles.connectRoleIds) && roles.connectRoleIds.length > 0
    ? JSON.stringify(roles.connectRoleIds)
    : null;

  db.prepare(`
    INSERT INTO vc_transfer_settings (
      guild_id, parent_vc_id, base_name, category_id, log_channel_id,
      visible_role_ids, connect_role_ids,
      permission_role_id, lock_role_id, unlock_role_id, hide_role_id, show_role_id, delete_role_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, parent_vc_id) DO UPDATE SET
      base_name = excluded.base_name,
      category_id = excluded.category_id,
      log_channel_id = excluded.log_channel_id,
      visible_role_ids = excluded.visible_role_ids,
      connect_role_ids = excluded.connect_role_ids,
      permission_role_id = excluded.permission_role_id,
      lock_role_id = excluded.lock_role_id,
      unlock_role_id = excluded.unlock_role_id,
      hide_role_id = excluded.hide_role_id,
      show_role_id = excluded.show_role_id,
      delete_role_id = excluded.delete_role_id
  `).run(
    guildId,
    parentVcId,
    baseName,
    categoryId,
    roles.logChannelId || null,
    visibleRoleIds,
    connectRoleIds,
    roles.permissionRoleId || null,
    roles.lockRoleId || null,
    roles.unlockRoleId || null,
    roles.hideRoleId || null,
    roles.showRoleId || null,
    roles.deleteRoleId || null
  );
}

function getVcTransferByParent(guildId, parentVcId) {
  return db.prepare('SELECT * FROM vc_transfer_settings WHERE guild_id = ? AND parent_vc_id = ?').get(guildId, parentVcId);
}

function getAllVcTransfers(guildId) {
  return db.prepare('SELECT * FROM vc_transfer_settings WHERE guild_id = ?').all(guildId);
}

function addChildVc(guildId, channelId, parentVcId, number, ownerId) {
  db.prepare('INSERT OR IGNORE INTO child_vcs (guild_id, channel_id, parent_vc_id, number, owner_id) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, channelId, parentVcId, number, ownerId || null);
}

function removeChildVc(guildId, channelId) {
  db.prepare('DELETE FROM child_vcs WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
}

function getChildVc(guildId, channelId) {
  return db.prepare('SELECT * FROM child_vcs WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId);
}

function setChildVcOwner(guildId, channelId, ownerId) {
  db.prepare('UPDATE child_vcs SET owner_id = ? WHERE guild_id = ? AND channel_id = ?').run(ownerId || null, guildId, channelId);
}

function getNextChildVcNumber(guildId, parentVcId) {
  const rows = db.prepare('SELECT number FROM child_vcs WHERE guild_id = ? AND parent_vc_id = ? ORDER BY number').all(guildId, parentVcId);
  const used = new Set(rows.map(r => r.number));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function createTicketPanel(guildId, title, description, label, categoryId, logChannelId, autoMessage, emoji, role1, role2, role3) {
  const result = db.prepare(`
    INSERT INTO ticket_panels (guild_id, title, description, label, category_id, log_channel_id, auto_message, emoji, role1_id, role2_id, role3_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, title, description, label, categoryId, logChannelId, autoMessage, emoji || null, role1 || null, role2 || null, role3 || null);
  return result.lastInsertRowid;
}

function updateTicketPanelLocation(panelId, channelId, messageId) {
  db.prepare('UPDATE ticket_panels SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, messageId, panelId);
}

function getTicketPanel(panelId) {
  return db.prepare('SELECT * FROM ticket_panels WHERE id = ?').get(panelId);
}

function setTicketPurchaseSettings(guildId, panelId, logChannelId, enabled) {
  db.prepare(`
    UPDATE ticket_panels
    SET purchase_log_channel_id = ?, purchase_enabled = ?
    WHERE guild_id = ? AND id = ?
  `).run(logChannelId || null, enabled ? 1 : 0, guildId, panelId);
}

function getAllTicketPanels(guildId) {
  return db.prepare('SELECT * FROM ticket_panels WHERE guild_id = ?').all(guildId);
}

function deleteTicketPanel(guildId, panelId) {
  return db.prepare('DELETE FROM ticket_panels WHERE guild_id = ? AND id = ?').run(guildId, panelId).changes;
}

function upsertInquiryForumItem(guildId, itemKey, forumChannelId, name, description, emoji, logChannelId, autoMessage, role1Id, role2Id, role3Id) {
  db.prepare(`
    INSERT INTO inquiry_forum_items (
      guild_id, item_key, forum_channel_id, name, description, emoji, log_channel_id, auto_message, role1_id, role2_id, role3_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, item_key) DO UPDATE SET
      forum_channel_id = excluded.forum_channel_id,
      name = excluded.name,
      description = excluded.description,
      emoji = excluded.emoji,
      log_channel_id = excluded.log_channel_id,
      auto_message = excluded.auto_message,
      role1_id = excluded.role1_id,
      role2_id = excluded.role2_id,
      role3_id = excluded.role3_id
  `).run(
    guildId,
    itemKey,
    forumChannelId,
    name,
    description,
    emoji || null,
    logChannelId || null,
    autoMessage || null,
    role1Id || null,
    role2Id || null,
    role3Id || null
  );
}

function getInquiryForumItem(guildId, itemKey) {
  return db.prepare('SELECT * FROM inquiry_forum_items WHERE guild_id = ? AND item_key = ?').get(guildId, itemKey);
}

function setInquiryPurchaseSettings(guildId, itemKey, logChannelId, enabled) {
  db.prepare(`
    UPDATE inquiry_forum_items
    SET purchase_log_channel_id = ?, purchase_enabled = ?
    WHERE guild_id = ? AND item_key = ?
  `).run(logChannelId || null, enabled ? 1 : 0, guildId, itemKey);
}

function getInquiryForumItems(guildId) {
  return db.prepare('SELECT * FROM inquiry_forum_items WHERE guild_id = ? ORDER BY rowid').all(guildId);
}

function setInquiryForumPanel(guildId, channelId, messageId, title, description) {
  db.prepare(`
    INSERT INTO inquiry_forum_settings (guild_id, panel_channel_id, panel_message_id, panel_title, panel_description)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      panel_channel_id = excluded.panel_channel_id,
      panel_message_id = excluded.panel_message_id,
      panel_title = excluded.panel_title,
      panel_description = excluded.panel_description
  `).run(guildId, channelId, messageId, title, description);
}

function getInquiryForumSettings(guildId) {
  return db.prepare('SELECT * FROM inquiry_forum_settings WHERE guild_id = ?').get(guildId);
}

function deleteInquiryForumItem(guildId, itemKey) {
  return db.prepare('DELETE FROM inquiry_forum_items WHERE guild_id = ? AND item_key = ?').run(guildId, itemKey).changes;
}

function createInquiryForumTicket(guildId, channelId, creatorId, itemKey) {
  const result = db.prepare(`
    INSERT INTO inquiry_forum_tickets (guild_id, channel_id, creator_id, item_key)
    VALUES (?, ?, ?, ?)
  `).run(guildId, channelId, creatorId, itemKey);
  return result.lastInsertRowid;
}

function getInquiryForumTicketByChannel(channelId) {
  return db.prepare('SELECT * FROM inquiry_forum_tickets WHERE channel_id = ?').get(channelId);
}

function deleteInquiryForumTicket(channelId) {
  db.prepare('DELETE FROM inquiry_forum_tickets WHERE channel_id = ?').run(channelId);
}

function createTicket(guildId, channelId, creatorId, panelId) {
  const result = db.prepare('INSERT INTO tickets (guild_id, channel_id, creator_id, panel_id) VALUES (?, ?, ?, ?)')
    .run(guildId, channelId, creatorId, panelId);
  return result.lastInsertRowid;
}

function getTicketByChannel(channelId) {
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
}

function deleteTicket(channelId) {
  db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(channelId);
}

function createReactionRoleMessage(guildId, channelId, messageId, content) {
  const result = db.prepare('INSERT INTO reaction_role_messages (guild_id, channel_id, message_id, content) VALUES (?, ?, ?, ?)')
    .run(guildId, channelId, messageId, content);
  return result.lastInsertRowid;
}

function getAllReactionRoleMessages(guildId) {
  return db.prepare('SELECT * FROM reaction_role_messages WHERE guild_id = ?').all(guildId);
}

function getReactionRoleMessageById(id) {
  return db.prepare('SELECT * FROM reaction_role_messages WHERE id = ?').get(id);
}

function setReactionRoleMapping(guildId, messageId, emoji, roleId) {
  db.prepare(`
    INSERT INTO reaction_role_mappings (guild_id, message_id, emoji, role_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, emoji) DO UPDATE SET role_id = excluded.role_id
  `).run(guildId, messageId, emoji, roleId);
}

function getReactionRoleMapping(messageId, emoji) {
  return db.prepare('SELECT * FROM reaction_role_mappings WHERE message_id = ? AND emoji = ?').get(messageId, emoji);
}

function getReactionRoleMappingsForMessage(messageId) {
  return db.prepare('SELECT * FROM reaction_role_mappings WHERE message_id = ?').all(messageId);
}

function getAllReactionRoleMappings(guildId) {
  return db.prepare('SELECT * FROM reaction_role_mappings WHERE guild_id = ?').all(guildId);
}

function setPinnedMessage(guildId, channelId, messageId, title, description) {
  db.prepare(`
    INSERT INTO pinned_messages (guild_id, channel_id, message_id, title, description)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET
      message_id = excluded.message_id,
      title = excluded.title,
      description = excluded.description
  `).run(guildId, channelId, messageId, title, description);
}

function getPinnedMessage(guildId, channelId) {
  return db.prepare('SELECT * FROM pinned_messages WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId);
}

function deletePinnedMessage(guildId, channelId) {
  db.prepare('DELETE FROM pinned_messages WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
}

function getSnuggleCooldown(userId, guildId) {
  return db.prepare('SELECT used_at FROM snuggle_cooldowns WHERE user_id = ? AND guild_id = ?').get(userId, guildId);
}

function setSnuggleCooldown(userId, guildId, usedAt) {
  db.prepare(`
    INSERT INTO snuggle_cooldowns (user_id, guild_id, used_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, guild_id) DO UPDATE SET used_at = ?
  `).run(userId, guildId, usedAt, usedAt);
}

function setSnuggleSettings(guildId, min, max) {
  db.prepare(`
    INSERT INTO settings (guild_id, snuggle_min, snuggle_max) VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET snuggle_min = excluded.snuggle_min, snuggle_max = excluded.snuggle_max
  `).run(guildId, min, max);
}

function setSnuggleChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO settings (guild_id, snuggle_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET snuggle_channel_id = excluded.snuggle_channel_id
  `).run(guildId, channelId);
}

function setMessageLinkPreviewEnabled(guildId, enabled) {
  db.prepare(`
    INSERT INTO settings (guild_id, message_link_preview_enabled) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET message_link_preview_enabled = excluded.message_link_preview_enabled
  `).run(guildId, enabled ? 1 : 0);
}

function isMessageLinkPreviewEnabled(guildId) {
  const row = db.prepare('SELECT message_link_preview_enabled FROM settings WHERE guild_id = ?').get(guildId);
  if (!row || row.message_link_preview_enabled === null || row.message_link_preview_enabled === undefined) {
    return true;
  }
  return Number(row.message_link_preview_enabled) === 1;
}

module.exports = {
  getBalance, setBalance, addBalance, subtractBalance, transfer,
  getSettings, setInterviewSettings,
  setLogChannel, setGrantLogChannel, setDeductionLogChannel, setInterviewLogChannel, setBlackjackLogChannel,
  addPermittedRole, getPermittedRoles,
  setCurrencyUnit,
  setJoinLogChannel, setLeaveLogChannel, setAllLogChannel,
  setVcTransfer, getVcTransferByParent, getAllVcTransfers,
  addChildVc, removeChildVc, getChildVc, setChildVcOwner, getNextChildVcNumber,
  createTicketPanel, updateTicketPanelLocation, getTicketPanel, getAllTicketPanels, deleteTicketPanel,
  setTicketPurchaseSettings,
  createTicket, getTicketByChannel, deleteTicket,
  upsertInquiryForumItem, getInquiryForumItem, getInquiryForumItems,
  setInquiryPurchaseSettings,
  setInquiryForumPanel, getInquiryForumSettings, deleteInquiryForumItem,
  createInquiryForumTicket, getInquiryForumTicketByChannel, deleteInquiryForumTicket,
  createReactionRoleMessage, getAllReactionRoleMessages, getReactionRoleMessageById,
  setReactionRoleMapping, getReactionRoleMapping, getReactionRoleMappingsForMessage, getAllReactionRoleMappings,
  getSnuggleCooldown, setSnuggleCooldown, setSnuggleSettings, setSnuggleChannel,
  setMessageLinkPreviewEnabled, isMessageLinkPreviewEnabled,
  setPinnedMessage, getPinnedMessage, deletePinnedMessage,
};
