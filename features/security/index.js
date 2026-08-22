const path = require('path');
let BetterSqlite3;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (_) {
  BetterSqlite3 = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));
}
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const dotenv = require('dotenv');
const economyDb = require('../economy/database.js');

let protectionRules;
try {
  protectionRules = require('./protectionRules.js');
} catch (error) {
  protectionRules = {
    isSpamProtectionEnabled: (config = {}) => config.spamProtectionEnabled !== false,
    isRaidProtectionEnabled: (config = {}) => config.raidProtectionEnabled !== false,
    isImageSpamDetectionEnabled: (config = {}) => config.imageSpamDetectionEnabled !== false,
    hasMediaAttachment: (message) => {
      if (!message) return false;
      const attachmentCount = message.attachments?.size || 0;
      const embedCount = message.embeds?.length || 0;
      const stickerCount = message.stickers?.size || 0;
      return attachmentCount > 0 || embedCount > 0 || stickerCount > 0;
    },
  };
}

const {
  isSpamProtectionEnabled,
  isRaidProtectionEnabled,
  isImageSpamDetectionEnabled,
  hasMediaAttachment,
} = protectionRules;

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.DirectMessages,
  ],
});

const defaultConfig = {
  prefix: process.env.PREFIX || '!',
  moderationLogChannelId: process.env.MODERATION_LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID || '',
  inviteLogChannelId: process.env.INVITE_LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID || '',
  modRoleId: process.env.MOD_ROLE_ID || '',
  developerId: process.env.DEVELOPER_ID || '',
  spamThreshold: Number(process.env.SPAM_THRESHOLD || 6),
  spamWindowMs: Number(process.env.SPAM_WINDOW_MS || 8000),
  raidJoinThreshold: Number(process.env.RAID_JOIN_THRESHOLD || 8),
  raidWindowMs: Number(process.env.RAID_WINDOW_MS || 20000),
  timeoutDurationMinutes: Number(process.env.TIMEOUT_DURATION_MINUTES || 10),
  blockExternalApps: process.env.BLOCK_EXTERNAL_APPS === 'true',
  spamProtectionEnabled: process.env.SPAM_PROTECTION_ENABLED !== 'false',
  raidProtectionEnabled: process.env.RAID_PROTECTION_ENABLED !== 'false',
  imageSpamDetectionEnabled: process.env.IMAGE_SPAM_DETECTION_ENABLED !== 'false',
  invitePanelChannelId: process.env.INVITE_PANEL_CHANNEL_ID || '',
  evaluationForumChannelId: process.env.EVALUATION_FORUM_CHANNEL_ID || '',
  evaluationThreadRoleIds: [],
};

const unifiedDbPath = process.env.UNIFIED_DB_PATH || process.env.DB_PATH || process.env.CURRENCY_DB_PATH || path.join(process.cwd(), 'data', 'unified.db');
const unifiedDb = new BetterSqlite3(unifiedDbPath);
unifiedDb.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    namespace TEXT NOT NULL,
    state_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, state_key)
  )
`);

function readState(namespace, stateKey) {
  const row = unifiedDb.prepare('SELECT value_json FROM app_state WHERE namespace = ? AND state_key = ?').get(namespace, stateKey);
  if (!row?.value_json) return null;

  try {
    return JSON.parse(row.value_json);
  } catch (_) {
    return null;
  }
}

function writeState(namespace, stateKey, value) {
  const valueJson = JSON.stringify(value);
  unifiedDb.prepare(
    `INSERT INTO app_state (namespace, state_key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(namespace, state_key)
     DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(namespace, stateKey, valueJson, Date.now());
}

function loadConfig() {
  const baseConfig = {
    ...defaultConfig,
    token: process.env.TOKEN || '',
    clientId: process.env.CLIENT_ID || '',
    guildId: process.env.GUILD_ID || '',
  };

  try {
    const savedConfig = readState('security', 'config') || {};
    const mergedConfig = {
      ...baseConfig,
      ...savedConfig,
      token: process.env.TOKEN || '',
      clientId: process.env.CLIENT_ID || '',
      guildId: process.env.GUILD_ID || '',
    };

    if (!mergedConfig.developerId && process.env.DEVELOPER_ID) {
      mergedConfig.developerId = process.env.DEVELOPER_ID;
    }

    if (!mergedConfig.moderationLogChannelId && mergedConfig.logChannelId) {
      mergedConfig.moderationLogChannelId = mergedConfig.logChannelId;
    }

    if (!mergedConfig.inviteLogChannelId && mergedConfig.logChannelId) {
      mergedConfig.inviteLogChannelId = mergedConfig.logChannelId;
    }

    return mergedConfig;
  } catch (error) {
    console.warn('Failed to read security config from DB. Using defaults.', error.message);
    return baseConfig;
  }
}

const config = loadConfig();

function loadManagedInvites() {
  const managedInvites = new Map();
  const savedInvites = Array.isArray(config.managedInvites) ? config.managedInvites : [];

  for (const invite of savedInvites) {
    if (!invite?.guildId || !invite?.code) continue;

    const guildInvites = managedInvites.get(invite.guildId) || new Map();
    guildInvites.set(invite.code, {
      inviterId: invite.inviterId || null,
      inviterTag: invite.inviterTag || null,
      channelId: invite.channelId || null,
    });
    managedInvites.set(invite.guildId, guildInvites);
  }

  return managedInvites;
}

const managedInviteOwners = loadManagedInvites();

function serializeManagedInvites() {
  const serialized = [];

  for (const [guildId, guildInvites] of managedInviteOwners.entries()) {
    for (const [code, invite] of guildInvites.entries()) {
      serialized.push({
        guildId,
        code,
        inviterId: invite.inviterId || null,
        inviterTag: invite.inviterTag || null,
        channelId: invite.channelId || null,
      });
    }
  }

  return serialized;
}

function rememberManagedInvite(guildId, code, invite) {
  const guildInvites = managedInviteOwners.get(guildId) || new Map();
  guildInvites.set(code, {
    inviterId: invite.inviterId || null,
    inviterTag: invite.inviterTag || null,
    channelId: invite.channelId || null,
  });
  managedInviteOwners.set(guildId, guildInvites);
}

function forgetManagedInvite(guildId, code) {
  const guildInvites = managedInviteOwners.get(guildId);
  if (!guildInvites) return;
  guildInvites.delete(code);
  if (guildInvites.size === 0) {
    managedInviteOwners.delete(guildId);
  }
}

function saveConfig() {
  const persistedConfig = {
    prefix: config.prefix,
    moderationLogChannelId: config.moderationLogChannelId,
    inviteLogChannelId: config.inviteLogChannelId,
    modRoleId: config.modRoleId,
    developerId: config.developerId,
    spamThreshold: config.spamThreshold,
    spamWindowMs: config.spamWindowMs,
    raidJoinThreshold: config.raidJoinThreshold,
    raidWindowMs: config.raidWindowMs,
    timeoutDurationMinutes: config.timeoutDurationMinutes,
    blockExternalApps: config.blockExternalApps,
    spamProtectionEnabled: config.spamProtectionEnabled,
    raidProtectionEnabled: config.raidProtectionEnabled,
    imageSpamDetectionEnabled: config.imageSpamDetectionEnabled,
    invitePanelChannelId: config.invitePanelChannelId,
    evaluationForumChannelId: config.evaluationForumChannelId,
    evaluationThreadRoleIds: config.evaluationThreadRoleIds,
    managedInvites: serializeManagedInvites(),
  };

  writeState('security', 'config', persistedConfig);
}

function resetBotSettings(guildId) {
  const settingTables = [
    'settings',
    'permitted_roles',
    'vc_transfer_settings',
    'child_vcs',
    'ticket_panels',
    'tickets',
    'inquiry_forum_settings',
    'inquiry_forum_items',
    'inquiry_forum_tickets',
    'reaction_role_messages',
    'reaction_role_mappings',
    'pinned_messages',
    'leveling_thresholds',
    'leveling_roles',
    'role_voice_time_channels',
    'role_voice_time_periods',
    'role_voice_time_rewards',
    'role_voice_time_reward_claims',
    'role_voice_time_reward_rules',
    'role_voice_time_reward_rule_claims',
    'role_voice_time_sessions',
    'role_salary_settings',
    'vending_panels',
    'vending_products',
    'vending_panels_multi',
    'vending_products_multi',
    'vc_vending_panels_multi',
    'vc_vending_products_multi',
    'gacha_panels',
    'gacha_products',
    'box_gachas',
    'box_gacha_products',
    'box_gacha_panels',
    'box_gacha_log_channels',
    'box_gacha_next_products',
    'bank_transfer_roles',
    'currency_support_roles',
    'bank_panels',
  ];
  const existingTables = new Set(
    unifiedDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  let deletedCount = 0;

  unifiedDb.transaction(() => {
    for (const table of settingTables) {
      if (!existingTables.has(table)) continue;
      deletedCount += unifiedDb.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId).changes;
    }
    unifiedDb.prepare('DELETE FROM app_state WHERE namespace = ? AND state_key = ?').run('security', 'config');
  })();

  managedInviteOwners.clear();
  Object.assign(config, loadConfig());
  return deletedCount;
}

const spamCache = new Map();
const joinHistoryByGuild = new Map();
const raidModeByGuild = new Map();
const inviteState = new Map();
const invitePanelButtonId = 'issue-personal-invite';

const slashCommands = [
  new SlashCommandBuilder()
    .setName('setmodlog')
    .setNameLocalization('ja', 'モデレーションログ設定')
    .setDescription('モデレーションログを送るチャンネルを設定します')
    .setDescriptionLocalization('ja', 'モデレーションログを送るチャンネルを設定します')
    .addChannelOption((option) =>
      option.setName('channel').setNameLocalization('ja', 'チャンネル').setDescription('モデレーションログを送るチャンネル').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setinvitelog')
    .setNameLocalization('ja', '招待ログ設定')
    .setDescription('招待ログを送るチャンネルを設定します')
    .setDescriptionLocalization('ja', '招待ログを送るチャンネルを設定します')
    .addChannelOption((option) =>
      option.setName('channel').setNameLocalization('ja', 'チャンネル').setDescription('招待ログを送るチャンネル').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('settimeout')
    .setNameLocalization('ja', 'タイムアウト設定')
    .setDescription('タイムアウト時間を分単位で設定します')
    .setDescriptionLocalization('ja', 'タイムアウト時間を分単位で設定します')
    .addIntegerOption((option) =>
      option.setName('minutes').setNameLocalization('ja', '分').setDescription('タイムアウトする分数').setRequired(true).setMinValue(1).setMaxValue(10080),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setspam')
    .setNameLocalization('ja', 'スパム設定')
    .setDescription('スパム検知のしきい値を設定します')
    .setDescriptionLocalization('ja', 'スパム検知のしきい値を設定します')
    .addIntegerOption((option) => option.setName('threshold').setNameLocalization('ja', '回数').setDescription('窓内で検知するメッセージ数').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('window').setNameLocalization('ja', '時間').setDescription('判定する時間（ミリ秒）').setRequired(true).setMinValue(1000))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setraid')
    .setNameLocalization('ja', 'レイド設定')
    .setDescription('レイド検知のしきい値を設定します')
    .setDescriptionLocalization('ja', 'レイド検知のしきい値を設定します')
    .addIntegerOption((option) => option.setName('threshold').setNameLocalization('ja', '回数').setDescription('窓内で検知する入室数').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('window').setNameLocalization('ja', '時間').setDescription('判定する時間（ミリ秒）').setRequired(true).setMinValue(1000))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('blockapps')
    .setNameLocalization('ja', '外部アプリ制限')
    .setDescription('サーバー全体で外部アプリの利用を制限します')
    .setDescriptionLocalization('ja', 'サーバー全体で外部アプリの利用を制限します')
    .addStringOption((option) =>
      option.setName('mode').setNameLocalization('ja', 'モード').setDescription('有効/無効').setRequired(true).addChoices(
        { name: '有効', value: 'on' },
        { name: '無効', value: 'off' },
      ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setprotection')
    .setNameLocalization('ja', '対策切替')
    .setDescription('スパム・レイド・画像判定の有効/無効を切り替えます')
    .setDescriptionLocalization('ja', 'スパム・レイド・画像判定の有効/無効を切り替えます')
    .addStringOption((option) =>
      option.setName('target').setNameLocalization('ja', '対象').setDescription('切り替える対象').setRequired(true).addChoices(
        { name: 'スパム判定', value: 'spam' },
        { name: 'レイド判定', value: 'raid' },
        { name: '画像判定', value: 'image' },
      ),
    )
    .addStringOption((option) =>
      option.setName('mode').setNameLocalization('ja', 'モード').setDescription('有効/無効').setRequired(true).addChoices(
        { name: '有効', value: 'on' },
        { name: '無効', value: 'off' },
      ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('invitepanel')
    .setNameLocalization('ja', '招待パネル設置')
    .setDescription('招待リンク発行パネルを設置します')
    .setDescriptionLocalization('ja', '招待リンク発行パネルを設置します')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setNameLocalization('ja', 'チャンネル')
        .setDescription('パネルを設置するテキストチャンネル')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setmodrole')
    .setNameLocalization('ja', 'モデレーター役職設定')
    .setDescription('モデレーター役職を設定します')
    .setDescriptionLocalization('ja', 'モデレーター役職を設定します')
    .addRoleOption((option) =>
      option.setName('role').setNameLocalization('ja', '役職').setDescription('モデレーター役職').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('allow')
    .setNameLocalization('ja', '解除')
    .setDescription('ユーザーのタイムアウトを解除します')
    .setDescriptionLocalization('ja', 'ユーザーのタイムアウトを解除します')
    .addUserOption((option) =>
      option.setName('user').setNameLocalization('ja', 'ユーザー').setDescription('タイムアウトを解除するユーザー').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('createevaluationthread')
    .setNameLocalization('ja', '評価スレッド作成')
    .setDescription('指定ユーザーの評価用フォーラム投稿を作成します')
    .setDescriptionLocalization('ja', '指定ユーザーの評価用フォーラム投稿を作成します')
    .addUserOption((option) =>
      option
        .setName('user')
        .setNameLocalization('ja', '対象者')
        .setDescription('評価対象のユーザー')
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setevaluationforum')
    .setNameLocalization('ja', '評価フォーラム設定')
    .setDescription('評価スレッドを作成するフォーラムを設定します')
    .setDescriptionLocalization('ja', '評価スレッドを作成するフォーラムを設定します')
    .addChannelOption((option) =>
      option
        .setName('forum')
        .setNameLocalization('ja', '対象フォーラム')
        .setDescription('評価投稿を作成するフォーラム')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('setevaluationthreadroles')
    .setNameLocalization('ja', '評価スレッド許可ロール設定')
    .setDescription('評価スレッドを作成できるロールを設定します')
    .setDescriptionLocalization('ja', '評価スレッドを作成できるロールを設定します')
    .addRoleOption((option) =>
      option.setName('role1').setNameLocalization('ja', 'ロール1').setDescription('作成を許可するロール').setRequired(true),
    )
    .addRoleOption((option) =>
      option.setName('role2').setNameLocalization('ja', 'ロール2').setDescription('追加で許可するロール').setRequired(false),
    )
    .addRoleOption((option) =>
      option.setName('role3').setNameLocalization('ja', 'ロール3').setDescription('追加で許可するロール').setRequired(false),
    )
    .addRoleOption((option) =>
      option.setName('role4').setNameLocalization('ja', 'ロール4').setDescription('追加で許可するロール').setRequired(false),
    )
    .addRoleOption((option) =>
      option.setName('role5').setNameLocalization('ja', 'ロール5').setDescription('追加で許可するロール').setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('resetbotsettings')
    .setNameLocalization('ja', 'ボット設定リセット')
    .setDescription('開発者専用: ボット設定を初期値へ戻します')
    .setDescriptionLocalization('ja', '開発者専用: ボット設定を初期値へ戻します')
    .toJSON(),
];

const commandAliases = {
  setmodlog: ['setmodlog', 'モデレーションログ設定'],
  setinvitelog: ['setinvitelog', '招待ログ設定'],
  settimeout: ['settimeout', 'タイムアウト設定', 'timeout'],
  setspam: ['setspam', 'スパム設定', 'spam'],
  setraid: ['setraid', 'レイド設定', 'raid'],
  blockapps: ['blockapps', '外部アプリ制限', 'apps'],
  setprotection: ['setprotection', '対策切替', 'protection'],
  invitepanel: ['invitepanel', '招待パネル設置', 'panel'],
  setmodrole: ['setmodrole', 'モデレーター役職設定', 'modrole'],
  allow: ['allow', '解除', 'clear'],
  createevaluationthread: ['createevaluationthread', '評価スレッド作成'],
  setevaluationforum: ['setevaluationforum', '評価フォーラム設定'],
  setevaluationthreadroles: ['setevaluationthreadroles', '評価スレッド許可ロール設定'],
  resetbotsettings: ['resetbotsettings', 'ボット設定リセット'],
};

function getCommandKey(command) {
  const normalized = String(command || '').toLowerCase();
  for (const [key, aliases] of Object.entries(commandAliases)) {
    if (aliases.includes(normalized)) return key;
  }
  return normalized;
}

const commandDescriptions = {
  setmodlog: 'モデレーションログを送るチャンネルを設定します。',
  setinvitelog: '招待ログを送るチャンネルを設定します。',
  settimeout: 'タイムアウト時間を分単位で設定します。',
  setspam: 'スパム検知のしきい値を設定します。',
  setraid: 'レイド検知のしきい値を設定します。',
  blockapps: '外部アプリの利用を制限します。',
  setprotection: 'スパム・レイド・画像判定の有効/無効を切り替えます。',
  invitepanel: '招待パネルを設置します。',
  setmodrole: 'モデレーター役職を設定します。',
  allow: 'ユーザーのタイムアウトを解除します。',
  createevaluationthread: '評価用フォーラム投稿を作成します。',
  setevaluationforum: '評価スレッドを作成するフォーラムを設定します。',
  setevaluationthreadroles: '評価スレッドを作成できるロールを設定します。',
  resetbotsettings: '開発者専用: ボット設定を初期値へ戻します。',
};

function isMod(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.modRoleId && member.roles.cache.has(config.modRoleId)) return true;
  return false;
}

function canCreateEvaluationThread(member) {
  const allowedRoleIds = Array.isArray(config.evaluationThreadRoleIds) ? config.evaluationThreadRoleIds : [];
  return allowedRoleIds.some((roleId) => member?.roles?.cache?.has(roleId));
}

async function setExternalAppsRestriction(guild, restricted) {
  const channels = [...guild.channels.cache.values()];
  const roles = [...guild.roles.cache.values()];
  let updatedCount = 0;
  let failedCount = 0;

  for (const channel of channels) {
    for (const role of roles) {
      try {
        await channel.permissionOverwrites.edit(role, {
          UseExternalApps: restricted ? false : null,
        }, { reason: restricted ? '外部アプリコマンド制限を有効化' : '外部アプリコマンド制限を無効化' });
        updatedCount++;
      } catch (error) {
        failedCount++;
        console.warn(`外部アプリ権限の更新に失敗しました (${channel.id}/${role.id}): ${error.message}`);
      }
    }
  }

  return { updatedCount, failedCount };
}

function pruneTimestamps(list, windowMs, now) {
  return list.filter((timestamp) => now - timestamp < windowMs);
}

function isRaidModeEnabled(guildId) {
  return Boolean(raidModeByGuild.get(guildId));
}

function buildInvitePanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('招待リンク発行パネル')
    .setDescription('下のボタンを押すと、あなた専用の招待リンクを Bot が DM に送信します。');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(invitePanelButtonId).setLabel('招待リンクを発行').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

async function logAction(guild, title, description, kind = 'moderation', targetChannel = null) {
  const targets = [];
  const configuredLogChannelId = kind === 'invite' ? config.inviteLogChannelId : config.moderationLogChannelId;

  if (configuredLogChannelId) {
    try {
      const logChannel = await guild.channels.fetch(configuredLogChannelId);
      if (logChannel?.isTextBased?.()) {
        targets.push(logChannel);
      }
    } catch (error) {
      console.warn(`ログチャンネル ${configuredLogChannelId} への送信に失敗しました: ${error.message}`);
    }
  }

  if (targetChannel && targetChannel.isTextBased?.() && targetChannel.guildId === guild.id) {
    if (!targets.some((channel) => channel.id === targetChannel.id)) {
      targets.push(targetChannel);
    }
  }

  if (targets.length === 0) return;

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();

  for (const channel of targets) {
    try {
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.warn(`ログ送信に失敗しました (${channel.id}): ${error.message}`);
    }
  }
}

async function timeoutUser(member, reason) {
  const timeoutMs = config.timeoutDurationMinutes * 60_000;
  const me = member.guild.members.me;

  if (!me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new Error('The bot lacks Moderate Members permission.');
  }

  await member.timeout(timeoutMs, reason);
}

async function getLinkedMessageContent(message) {
  const linkMatch = message.content.match(/https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!linkMatch) return null;

  const [, guildId, channelId, messageId] = linkMatch;
  if (!guildId || !channelId || !messageId) return null;

  try {
    const targetGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!targetGuild) return null;

    const targetChannel = await targetGuild.channels.fetch(channelId).catch(() => null);
    if (!targetChannel?.isTextBased?.()) return null;

    const targetMessage = await targetChannel.messages.fetch(messageId).catch(() => null);
    if (!targetMessage) return null;

    return targetMessage.content?.trim() || null;
  } catch (error) {
    console.warn(`メッセージリンクの本文取得に失敗しました: ${error.message}`);
    return null;
  }
}

async function postLinkedMessageContent(message) {
  const linkMatch = message.content.match(/https:\/\/(?:discord(?:app)?\.com|discord\.gg)\/channels\/(\d+)\/(\d+)\/(\d+)/i);
  if (!linkMatch) return;

  const [, guildId, channelId, messageId] = linkMatch;
  if (!guildId || !channelId || !messageId) return;

  try {
    const targetGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!targetGuild) return;

    const targetChannel = await targetGuild.channels.fetch(channelId).catch(() => null);
    if (!targetChannel?.isTextBased?.()) return;

    const targetMessage = await targetChannel.messages.fetch(messageId).catch(() => null);
    if (!targetMessage) return;

    const contentParts = [
      targetMessage.content?.trim(),
      targetMessage.embeds?.map((embed) => embed.description || embed.title).filter(Boolean).join('\n'),
    ].filter(Boolean);
    const content = contentParts.join('\n\n');
    if (!content) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('リンク先のメッセージ内容')
      .setDescription(content.slice(0, 1800))
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
  } catch (error) {
    console.warn(`リンク先メッセージの表示に失敗しました: ${error.message}`);
  }
}

async function snapshotGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const snapshot = new Map();

    for (const invite of invites.values()) {
      const managedInvite = managedInviteOwners.get(guild.id)?.get(invite.code);
      snapshot.set(invite.code, {
        uses: invite.uses ?? 0,
        inviterId: managedInvite?.inviterId || invite.inviter?.id || null,
        inviterTag: managedInvite?.inviterTag || invite.inviter?.tag || null,
        channelId: managedInvite?.channelId || invite.channel?.id || null,
      });
    }

    inviteState.set(guild.id, snapshot);
  } catch (error) {
    console.warn(`招待リンク一覧の取得に失敗しました (${guild.id}): ${error.message}`);
  }
}

async function registerSlashCommands() {
  if (!config.token || !config.clientId) return;

  const rest = new REST({ version: '10' }).setToken(config.token);
  const sharedAppMode = process.env.ONE_TOKEN_MODE === 'true';

  try {
    if (config.guildId && !sharedAppMode) {
      // Legacy cleanup: if guild scope was used before, clear it to avoid duplicate command entries.
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [] });
      console.log('Guild slash commands cleared.');
    }

    for (const command of slashCommands) {
      await rest.post(Routes.applicationCommands(config.clientId), { body: command });
    }
    console.log('Global slash commands registered.');
  } catch (error) {
    console.warn('Failed to register slash commands.', error.message);
  }
}

function getPanelChannel(guild, fallbackChannel = null) {
  if (fallbackChannel?.type === ChannelType.GuildText) return fallbackChannel;
  if (config.invitePanelChannelId) {
    return guild.channels.cache.get(config.invitePanelChannelId) || null;
  }
  return null;
}

async function sendInvitePanel(channel) {
  await channel.send(buildInvitePanelPayload());
}

async function createPersonalInvite(member, sourceChannel) {
  const channel = getPanelChannel(member.guild, sourceChannel);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('招待パネル用のテキストチャンネルが未設定です。');
  }

  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
    throw new Error('Bot に招待リンク作成権限がありません。');
  }

  const botPermissions = channel.permissionsFor(me);
  if (!botPermissions?.has(PermissionFlagsBits.CreateInstantInvite)) {
    throw new Error('このチャンネルで招待リンクを作成する権限がありません。');
  }

  const invite = await channel.createInvite({
    maxAge: 0,
    maxUses: 0,
    unique: true,
    reason: `${member.user.tag} 用の個別招待リンク`,
  });

  const guildSnapshot = inviteState.get(member.guild.id) || new Map();
  guildSnapshot.set(invite.code, {
    uses: invite.uses ?? 0,
    inviterId: member.id,
    inviterTag: member.user.tag,
    channelId: channel.id,
  });
  inviteState.set(member.guild.id, guildSnapshot);

  rememberManagedInvite(member.guild.id, invite.code, {
    inviterId: member.id,
    inviterTag: member.user.tag,
    channelId: channel.id,
  });
  saveConfig();

  return invite;
}

async function handleInvitePanelCommand(target, guild, requestedChannel) {
  const channel = getPanelChannel(guild, requestedChannel || target.channel);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await target.reply({ content: '設置先のテキストチャンネルを指定してください。', ephemeral: true });
    return;
  }

  config.invitePanelChannelId = channel.id;
  saveConfig();

  await sendInvitePanel(channel);
  await target.reply({ content: `招待パネルを ${channel} に設置しました。`, ephemeral: true });
}

async function handleInviteButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'このボタンはサーバー内でのみ使えます。', ephemeral: true });
    return;
  }

  try {
    const invite = await createPersonalInvite(interaction.member, interaction.channel);

    await interaction.user.send([
      `${interaction.guild.name} のあなた専用招待リンクです。`,
      invite.url,
      'このリンクから参加したユーザーは、あなたの招待としてログに残ります。',
    ].join('\n'));

    await interaction.reply({ content: '招待リンクを DM に送りました。', ephemeral: true });
    await logAction(interaction.guild, '招待リンクを発行', `${interaction.user.tag} に個別招待リンクを発行しました。\n${invite.url}`, 'invite');
  } catch (error) {
    const content = error.code === 50007
      ? 'DM を送れませんでした。DM を受け取れる設定にしてからもう一度試してください。'
      : `招待リンクの発行に失敗しました: ${error.message}`;

    await interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
}

async function captureUsedInvite(member) {
  let usedInvite = null;

  try {
    const previousSnapshot = inviteState.get(member.guild.id) || new Map();
    const currentInvites = await member.guild.invites.fetch();
    const nextSnapshot = new Map();

    for (const invite of currentInvites.values()) {
      const uses = invite.uses ?? 0;
      const managedInvite = managedInviteOwners.get(member.guild.id)?.get(invite.code);
      nextSnapshot.set(invite.code, {
        uses,
        inviterId: previousSnapshot.get(invite.code)?.inviterId || managedInvite?.inviterId || invite.inviter?.id || null,
        inviterTag: previousSnapshot.get(invite.code)?.inviterTag || managedInvite?.inviterTag || invite.inviter?.tag || null,
        channelId: invite.channel?.id || previousSnapshot.get(invite.code)?.channelId || managedInvite?.channelId || null,
      });

      const previousUses = previousSnapshot.get(invite.code)?.uses ?? 0;
      if (!usedInvite && uses > previousUses) {
        usedInvite = nextSnapshot.get(invite.code);
        usedInvite.code = invite.code;
      }
    }

    inviteState.set(member.guild.id, nextSnapshot);
  } catch (error) {
    console.warn(`参加時の招待リンク追跡に失敗しました: ${error.message}`);
  }

  return usedInvite;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`ログインしました: ${readyClient.user.tag}`);
  await registerSlashCommands();

  for (const guild of readyClient.guilds.cache.values()) {
    await snapshotGuildInvites(guild);
  }
});

client.on(Events.InviteCreate, async (invite) => {
  const guildSnapshot = inviteState.get(invite.guild.id) || new Map();
  const managedInvite = managedInviteOwners.get(invite.guild.id)?.get(invite.code);
  guildSnapshot.set(invite.code, {
    uses: invite.uses ?? 0,
    inviterId: managedInvite?.inviterId || invite.inviter?.id || null,
    inviterTag: managedInvite?.inviterTag || invite.inviter?.tag || null,
    channelId: managedInvite?.channelId || invite.channel?.id || null,
  });
  inviteState.set(invite.guild.id, guildSnapshot);
});

client.on(Events.InviteDelete, async (invite) => {
  const guildSnapshot = inviteState.get(invite.guild.id);
  if (guildSnapshot) {
    guildSnapshot.delete(invite.code);
  }
  forgetManagedInvite(invite.guild.id, invite.code);
  saveConfig();
});

client.on(Events.ChannelCreate, async (channel) => {
  if (!config.blockExternalApps || !channel.guild) return;

  try {
    const roles = [...channel.guild.roles.cache.values()];
    for (const role of roles) {
      await channel.permissionOverwrites.edit(role, {
        UseExternalApps: false,
      }, { reason: '外部アプリコマンド制限を適用' });
    }
  } catch (error) {
    console.warn(`新規チャンネルへの外部アプリ権限適用に失敗しました (${channel.id}): ${error.message}`);
  }
});

client.on(Events.GuildRoleCreate, async (role) => {
  if (!config.blockExternalApps) return;

  for (const channel of role.guild.channels.cache.values()) {
    await channel.permissionOverwrites.edit(role, {
      UseExternalApps: false,
    }, { reason: '外部アプリコマンド制限を適用' }).catch((error) => {
      console.warn(`新規ロールへの外部アプリ権限適用に失敗しました (${channel.id}/${role.id}): ${error.message}`);
    });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === invitePanelButtonId) {
      await handleInviteButton(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'このボットはサーバー内でのみ利用できます。', ephemeral: true });
    return;
  }

  const commandKey = getCommandKey(interaction.commandName);
  const usesDedicatedPermission = commandKey === 'createevaluationthread' || commandKey === 'resetbotsettings';
  if (!usesDedicatedPermission && !interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '管理者のみがこのコマンドを使用できます。', ephemeral: true });
    return;
  }

  if (commandKey === 'resetbotsettings') {
    if (!config.developerId || interaction.user.id !== config.developerId) {
      await interaction.reply({ content: 'このコマンドは開発者のみ実行できます。', ephemeral: true });
      return;
    }

    const deletedCount = resetBotSettings(interaction.guild.id);
    await interaction.reply({
      content: `ボット設定を初期値へ戻しました。削除した設定: ${deletedCount}件。チケット、VC転送、面接、評価、ログ、レベリング、自販機、ガチャ、銀行、リアクションロールの設定を含みます。残高、面接通過履歴、購入履歴、Discord上の投稿・チャンネル・ロールは変更していません。`,
      ephemeral: true,
    });
    return;
  }

  if (commandKey === 'setmodlog') {
    const channel = interaction.options.getChannel('channel');
    if (!channel?.isTextBased?.()) {
      await interaction.reply({ content: 'テキストチャンネルを指定してください。', ephemeral: true });
      return;
    }

    config.moderationLogChannelId = channel.id;
    saveConfig();

    try {
      const testEmbed = new EmbedBuilder()
        .setColor(0x00cc66)
        .setTitle('モデレーションログを設定しました')
        .setDescription('これ以降のモデレーションログを送信します。')
        .setTimestamp();
      await channel.send({ embeds: [testEmbed] });
      await interaction.reply({ content: `モデレーションログを ${channel} に設定し、テスト投稿を送信しました。`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `モデレーションログを ${channel} に設定しましたが、テスト投稿に失敗しました。${error.message}`, ephemeral: true });
    }
    return;
  }

  if (commandKey === 'setinvitelog') {
    const channel = interaction.options.getChannel('channel');
    if (!channel?.isTextBased?.()) {
      await interaction.reply({ content: 'テキストチャンネルを指定してください。', ephemeral: true });
      return;
    }

    config.inviteLogChannelId = channel.id;
    saveConfig();

    try {
      const testEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('招待ログを設定しました')
        .setDescription('これ以降の招待ログを送信します。')
        .setTimestamp();
      await channel.send({ embeds: [testEmbed] });
      await interaction.reply({ content: `招待ログを ${channel} に設定し、テスト投稿を送信しました。`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `招待ログを ${channel} に設定しましたが、テスト投稿に失敗しました。${error.message}`, ephemeral: true });
    }
    return;
  }

  if (commandKey === 'settimeout') {
    const minutes = interaction.options.getInteger('minutes');
    config.timeoutDurationMinutes = minutes;
    saveConfig();
    await interaction.reply({ content: `タイムアウト時間を ${minutes} 分に設定しました。`, ephemeral: true });
    return;
  }

  if (commandKey === 'setspam') {
    const threshold = interaction.options.getInteger('threshold');
    const windowMs = interaction.options.getInteger('window');
    config.spamThreshold = threshold;
    config.spamWindowMs = windowMs;
    saveConfig();
    await interaction.reply({ content: `スパム設定を更新しました。しきい値: ${threshold} 回 / 窓: ${windowMs} ミリ秒。`, ephemeral: true });
    return;
  }

  if (commandKey === 'setraid') {
    const threshold = interaction.options.getInteger('threshold');
    const windowMs = interaction.options.getInteger('window');
    config.raidJoinThreshold = threshold;
    config.raidWindowMs = windowMs;
    saveConfig();
    await interaction.reply({ content: `レイド設定を更新しました。しきい値: ${threshold} 回 / 窓: ${windowMs} ミリ秒。`, ephemeral: true });
    return;
  }

  if (commandKey === 'blockapps') {
    if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'サーバー全体の外部アプリ制限は管理者のみ変更できます。', ephemeral: true });
      return;
    }

    const mode = interaction.options.getString('mode');
    const restricted = mode === 'on';
    const result = await setExternalAppsRestriction(interaction.guild, restricted);
    config.blockExternalApps = restricted;
    saveConfig();
    await interaction.reply({
      content: [
        `外部Botのコマンド利用制限を ${restricted ? '有効' : '無効'} にしました。`,
        `更新: ${result.updatedCount}チャンネル / 失敗: ${result.failedCount}チャンネル`,
        restricted ? 'Discordの権限で外部アプリコマンドを拒否します。' : '外部アプリコマンドの拒否を解除しました。',
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (commandKey === 'setprotection') {
    const target = interaction.options.getString('target');
    const mode = interaction.options.getString('mode');
    const enabled = mode === 'on';

    if (target === 'spam') {
      config.spamProtectionEnabled = enabled;
    } else if (target === 'raid') {
      config.raidProtectionEnabled = enabled;
    } else if (target === 'image') {
      config.imageSpamDetectionEnabled = enabled;
    }

    saveConfig();
    const label = target === 'spam' ? 'スパム判定' : target === 'raid' ? 'レイド判定' : '画像判定';
    await interaction.reply({ content: `${label} を ${enabled ? '有効' : '無効'} にしました。`, ephemeral: true });
    return;
  }

  if (commandKey === 'setmodrole') {
    if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '管理者のみがモデレーター役職を変更できます。', ephemeral: true });
      return;
    }

    const role = interaction.options.getRole('role');
    config.modRoleId = role.id;
    saveConfig();
    await interaction.reply({ content: `モデレーター役職を ${role} に設定しました。`, ephemeral: true });
    return;
  }

  if (commandKey === 'invitepanel') {
    const channel = interaction.options.getChannel('channel');
    await handleInvitePanelCommand(interaction, interaction.guild, channel);
    return;
  }

  if (commandKey === 'allow') {
    const targetUser = interaction.options.getUser('user');
    const targetMember = targetUser ? await interaction.guild.members.fetch(targetUser.id).catch(() => null) : null;
    if (!targetMember) {
      await interaction.reply({ content: '対象ユーザーがサーバー内で見つかりません。', ephemeral: true });
      return;
    }

    try {
      await targetMember.timeout(null, 'モデレーターがタイムアウトを解除しました');
      await interaction.reply({ content: `${targetMember.user.tag} のタイムアウトを解除しました。`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `タイムアウト解除に失敗しました: ${error.message}`, ephemeral: true });
    }
    return;
  }

  if (commandKey === 'createevaluationthread') {
    if (!canCreateEvaluationThread(interaction.member)) {
      await interaction.reply({ content: 'このコマンドを実行できるロールが設定されていないか、あなたに許可ロールがありません。', ephemeral: true });
      return;
    }

    const targetUser = interaction.options.getUser('user');
    const forum = config.evaluationForumChannelId
      ? await interaction.guild.channels.fetch(config.evaluationForumChannelId).catch(() => null)
      : null;

    if (!forum || forum.type !== ChannelType.GuildForum || !targetUser) {
      await interaction.reply({ content: '評価フォーラムが未設定です。先に `/評価フォーラム設定` でフォーラムを設定してください。', ephemeral: true });
      return;
    }

    const settings = economyDb.getSettings(interaction.guild.id);
    const evaluationDays = Math.max(0, Math.floor(Number(settings.evaluation_days || 0)));
    if (evaluationDays <= 0) {
      await interaction.reply({ content: '評価期限日数が未設定です。先に `/評価期限設定` で日数を設定してください。', ephemeral: true });
      return;
    }

    const evaluation = economyDb.getInterviewEvaluation(targetUser.id, interaction.guild.id);
    if (!evaluation) {
      await interaction.reply({ content: `${targetUser.username} は面接通過済みではないため、評価スレッドを作成できません。`, ephemeral: true });
      return;
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const periodStartAt = (Math.floor((evaluation.passed_at + jstOffsetMs) / dayMs) * dayMs) + dayMs - jstOffsetMs;
    const deadlineAt = periodStartAt + (evaluationDays * dayMs);
    const deadline = new Date(deadlineAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const threadTitle = `${targetUser.username}: @${targetUser.username}: ${deadline}`.slice(0, 100);
    const postContent = `${targetUser.username}: <@${targetUser.id}>: ${deadline}`;

    try {
      await forum.threads.fetch();
      const existingThread = forum.threads.cache.find((thread) => thread.name === threadTitle);
      if (existingThread) {
        const threadLink = `https://discord.com/channels/${interaction.guild.id}/${existingThread.id}`;
        try {
          await targetUser.send(`あなたの評価スレッドはすでに作成されています。\n${threadLink}`);
          await interaction.reply({ content: `${targetUser.username} の評価スレッドはすでにあります。対象ユーザーへリンクを DM で送信しました。`, ephemeral: true });
        } catch (error) {
          await interaction.reply({ content: `${targetUser.username} の評価スレッドはすでにありますが、DM を送信できませんでした。\n${threadLink}`, ephemeral: true });
        }
        return;
      }

      const thread = await forum.threads.create({
        name: threadTitle,
        message: { content: postContent },
        reason: `${interaction.user.tag} が ${targetUser.tag} の評価スレッドを作成`,
      });
      await interaction.reply({ content: `${thread} に ${targetUser.username} の評価スレッドを作成しました。`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `評価スレッドの作成に失敗しました: ${error.message}`, ephemeral: true });
    }
    return;
  }

  if (commandKey === 'setevaluationthreadroles') {
    if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '管理者のみが評価スレッドの許可ロールを設定できます。', ephemeral: true });
      return;
    }

    const roleIds = [1, 2, 3, 4, 5]
      .map((index) => interaction.options.getRole(`role${index}`)?.id)
      .filter(Boolean);
    config.evaluationThreadRoleIds = [...new Set(roleIds)];
    saveConfig();
    await interaction.reply({
      content: `評価スレッド作成を許可するロールを設定しました。\n${config.evaluationThreadRoleIds.map((roleId) => `<@&${roleId}>`).join('\n')}`,
      ephemeral: true,
    });
    return;
  }

  if (commandKey === 'setevaluationforum') {
    const forum = interaction.options.getChannel('forum');
    if (!forum || forum.type !== ChannelType.GuildForum) {
      await interaction.reply({ content: '評価スレッドを作成するフォーラムを指定してください。', ephemeral: true });
      return;
    }

    config.evaluationForumChannelId = forum.id;
    saveConfig();
    await interaction.reply({ content: `評価スレッドの作成先を ${forum} に設定しました。`, ephemeral: true });
    return;
  }

  // Removed developer commands handling
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || message.channel.type === ChannelType.DM) return;

  if (/https:\/\/(?:discord(?:app)?\.com|discord\.gg)\/channels\//i.test(message.content)) {
    await postLinkedMessageContent(message);
  }

  if (config.blockExternalApps) {
    const appPattern = /(discordapp\.com\/oauth2|discord\.com\/oauth2|discord\.com\/api|https?:\/\/.*(bot|oauth|login|connect))/i;
    if (appPattern.test(message.content)) {
      await message.delete().catch(() => {});
      await message.reply('外部アプリの利用は制限されています。').catch(() => {});
      return;
    }
  }

  const member = message.member;
  if (!member || isMod(member)) return;

  const hasMedia = hasMediaAttachment(message);
  const imageEnabled = isImageSpamDetectionEnabled(config);
  const spamEnabled = isSpamProtectionEnabled(config);

  if (!spamEnabled) return;

  const now = Date.now();
  const userKey = `${message.guild.id}:${message.author.id}`;
  const userState = spamCache.get(userKey) || { timestamps: [], repeated: 0, lastContent: '' };

  userState.timestamps = pruneTimestamps(userState.timestamps, config.spamWindowMs, now);
  userState.timestamps.push(now);

  if (userState.lastContent === message.content) {
    userState.repeated += 1;
  } else {
    userState.repeated = 0;
  }

  userState.lastContent = message.content;
  spamCache.set(userKey, userState);

  const isSpam = userState.timestamps.length >= config.spamThreshold || userState.repeated >= 2 || (imageEnabled && hasMedia && userState.timestamps.length >= Math.max(1, Math.floor(config.spamThreshold / 2)));

  if (!isSpam) return;

  try {
    await message.delete().catch(() => {});
    await timeoutUser(member, 'スパムまたは連投行為');

    const linkedContent = await getLinkedMessageContent(message);
    const linkedText = linkedContent ? `\n\nリンク先の文章:\n${linkedContent}` : '';

    const noticeEmbed = new EmbedBuilder()
      .setColor(0xff4d4d)
      .setTitle('スパム検知')
      .setDescription(`${message.author.tag} を ${config.timeoutDurationMinutes} 分間タイムアウトしました。${linkedText}`)
      .setTimestamp();

    try {
      await message.channel.send({ embeds: [noticeEmbed] });
    } catch (error) {
      console.warn(`通知メッセージの送信に失敗しました: ${error.message}`);
    }

    await logAction(
      message.guild,
      'スパム検出',
      `${message.author.tag} がスパム行為としてタイムアウトされました。${config.timeoutDurationMinutes}分間のタイムアウトです。${linkedText}`,
      'moderation',
      message.channel,
    );
  } catch (error) {
    console.warn(`${message.author.tag} のモデレーションに失敗しました: ${error.message}`);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;

  const usedInvite = await captureUsedInvite(member);
  const inviterText = usedInvite
    ? usedInvite.inviterId
      ? `<@${usedInvite.inviterId}> (${usedInvite.inviterTag || usedInvite.inviterId})`
      : usedInvite.inviterTag || '不明'
    : '特定できませんでした';

  const inviteDetails = usedInvite
    ? `\n招待コード: ${usedInvite.code}\n招待者: ${inviterText}`
    : '\n招待元は特定できませんでした。';

  await logAction(member.guild, '新規参加', `${member.user.tag} が参加しました。${inviteDetails}`, 'invite');

  const now = Date.now();
  const joinHistory = joinHistoryByGuild.get(member.guild.id) || [];
  joinHistory.push(now);
  const recentJoins = pruneTimestamps(joinHistory, config.raidWindowMs, now);
  joinHistoryByGuild.set(member.guild.id, recentJoins);

  if (!isRaidProtectionEnabled(config)) return;

  if (recentJoins.length >= config.raidJoinThreshold) {
    raidModeByGuild.set(member.guild.id, true);
    await logAction(member.guild, 'Raid detection', `${config.raidWindowMs / 1000} 秒以内に ${recentJoins.length} 人の参加を検知しました。`, 'moderation');
    setTimeout(() => {
      raidModeByGuild.set(member.guild.id, false);
    }, 5 * 60_000);
  }

  if (!isRaidModeEnabled(member.guild.id)) return;

  try {
    await timeoutUser(member, 'Raid mode protection');
    await logAction(member.guild, '新規参加ユーザーをタイムアウト', `User ${member.user.tag} was timed out because raid mode is active.${inviteDetails}`, 'moderation');
  } catch (error) {
    console.warn(`Raid moderation failed for ${member.user.tag}: ${error.message}`);
  }
});

if (!config.token) {
  throw new Error('TOKEN is not set. Please configure your bot token in the .env file.');
}

client.login(config.token);