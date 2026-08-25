require('dotenv').config();

process.on('uncaughtException', (err) => {
  process.stdout.write('[FATAL] uncaughtException: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stdout.write('[FATAL] unhandledRejection: ' + String(reason) + '\n');
  process.exit(1);
});

process.stdout.write('[STARTUP] index.js loaded\n');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  MessageFlags,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
} = require('discord.js');

const db = require('./database.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN || process.env.UNIFIED_DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.UNIFIED_CLIENT_ID;
const DEVELOPER_ID = process.env.DEVELOPER_ID || process.env.UNIFIED_DEVELOPER_ID;
const GUILD_ID = process.env.GUILD_ID || process.env.UNIFIED_GUILD_ID;
const repinningChannels = new Set();
const STATUS_REFRESH_INTERVAL_MS = 60 * 1000;
const STATUS_MEMBER_SYNC_COOLDOWN_MS = 30 * 60 * 1000;
const statusMemberSyncTimestamps = new Map();
const statusMemberSyncInFlight = new Map();
const MESSAGE_LINK_REGEX = /<?https?:\/\/(?:ptb\.|canary\.|www\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)>?/i;

function parseNewlines(text) {
  if (!text) return text;
  return text.replace(/\\n|\\/g, '\n');
}

function emojiToKey(emoji) {
  if (emoji.id) {
    return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
  }
  return emoji.name;
}

async function buildTranscript(channel) {
  const lines = [];
  let before;

  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    messages.forEach((msg) => {
      const time = msg.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const content = msg.content || (msg.embeds.length ? '[Embed]' : '[メッセージなし]');
      const attachments = msg.attachments.size
        ? ` [添付: ${[...msg.attachments.values()].map((a) => a.url).join(', ')}]`
        : '';
      lines.unshift(`[${time}] ${msg.author.tag}: ${content}${attachments}`);
    });

    before = messages.last()?.id;
    if (messages.size < 100) break;
  }

  return lines.join('\n') || '(メッセージなし)';
}

async function getGuildInvite(guild) {
  try {
    const channel = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)
    );
    if (!channel) return '招待リンクを作成できません';

    const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: false });
    return `https://discord.gg/${invite.code}`;
  } catch (_) {
    return '招待リンクを作成できません';
  }
}

function extractMessageLink(text) {
  if (!text) return null;
  const match = text.match(MESSAGE_LINK_REGEX);
  if (!match) return null;
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
  };
}

async function resolveLinkedMessage(linkData) {
  if (!linkData) return null;

  const channel = await client.channels.fetch(linkData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.messages) return null;

  const message = await channel.messages.fetch(linkData.messageId).catch(() => null);
  if (!message) return null;

  return { channel, message };
}

function buildLinkedMessageText(message) {
  const main = message.content?.trim();
  if (main) return main;

  const firstEmbed = message.embeds?.[0];
  if (firstEmbed?.description?.trim()) return firstEmbed.description.trim();
  if (firstEmbed?.title?.trim()) return firstEmbed.title.trim();

  if (message.attachments?.size) {
    return [...message.attachments.values()].map((a) => a.url).join('\n');
  }

  return null;
}

function buildQuotedMessageContent(message) {
  const text = buildLinkedMessageText(message);
  if (!text) return null;

  const quoteBody = text
    .split('\n')
    .map((line) => `> ${line || ' '}`)
    .join('\n');

  const sourceLink = message.url || `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  const authorName = message.author?.tag || message.author?.username || 'unknown';

  return `${quoteBody}\n\n- ${authorName} / [元メッセージ](${sourceLink})`;
}

function getOrdinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function buildStatusDateLabel() {
  const now = new Date();
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = now.getDate();
  return `📅 ${weekdays[now.getDay()]} ${months[now.getMonth()]} ${day}${getOrdinal(day)}`;
}

async function ensureStatusChannel(guild, category, prefix, targetName) {
  const existing = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildVoice && ch.parentId === category.id && ch.name.startsWith(prefix)
  );

  const overwrite = {
    id: guild.id,
    allow: [PermissionFlagsBits.ViewChannel],
    deny: [PermissionFlagsBits.Connect],
  };

  if (existing) {
    if (existing.name !== targetName) {
      await existing.edit({ name: targetName, permissionOverwrites: [overwrite] });
    }
    return existing;
  }

  return guild.channels.create({
    name: targetName,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [overwrite],
  });
}

async function syncGuildMembersWithCooldown(guild, options = {}) {
  const force = options.force === true;
  const now = Date.now();
  const lastSyncedAt = statusMemberSyncTimestamps.get(guild.id) || 0;

  if (!force && now - lastSyncedAt < STATUS_MEMBER_SYNC_COOLDOWN_MS) {
    return false;
  }

  const inFlight = statusMemberSyncInFlight.get(guild.id);
  if (inFlight) {
    await inFlight.catch(() => {});
    return false;
  }

  const syncPromise = guild.members.fetch();
  statusMemberSyncInFlight.set(guild.id, syncPromise);

  try {
    await syncPromise;
    statusMemberSyncTimestamps.set(guild.id, Date.now());
    return true;
  } catch (err) {
    if (err?.name === 'GatewayRateLimitError') {
      statusMemberSyncTimestamps.set(guild.id, Date.now());
      console.warn(`statusメンバー同期をスキップ (${guild.id}): gateway rate limited`);
      return false;
    }
    throw err;
  } finally {
    statusMemberSyncInFlight.delete(guild.id);
  }
}

async function renderStatusBoard(guild, options = {}) {
  const createIfMissing = options.createIfMissing !== false;
  const syncMembers = options.syncMembers === true;
  const forceMemberSync = options.forceMemberSync === true;

  if (syncMembers) {
    await syncGuildMembersWithCooldown(guild, { force: forceMemberSync });
  }

  const members = guild.members.cache.filter((m) => !m.user.bot);
  const users = members.size;
  const inVoice = members.filter((m) => !!m.voice?.channelId).size;
  const online = members.filter((m) => (m.presence?.status || 'offline') === 'online').size;
  const dnd = members.filter((m) => (m.presence?.status || 'offline') === 'dnd').size;
  const idle = members.filter((m) => (m.presence?.status || 'offline') === 'idle').size;

  let category = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === 'status');
  if (!category) {
    if (!createIfMissing) return false;
    category = await guild.channels.create({
      name: 'status',
      type: ChannelType.GuildCategory,
    });
  }

  await ensureStatusChannel(guild, category, '📅', buildStatusDateLabel());
  await ensureStatusChannel(guild, category, '🟢', `🟢${online} 🔴${dnd} 🌙${idle}`);
  await ensureStatusChannel(guild, category, 'Users:', `Users: ${users}`);
  await ensureStatusChannel(guild, category, 'In Voice:', `In Voice: ${inVoice}`);

  return true;
}

async function refreshAllStatusBoards() {
  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.channels.fetch();
      await renderStatusBoard(guild, { createIfMissing: false, syncMembers: false });
    } catch (err) {
      console.error(`status更新エラー (${guild.id}):`, err);
    }
  }
}

function buildVcControlPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('vc設定パネル')
    .setDescription('このパネルから参加中のvcを管理できます。')
    .setColor(0x2b2d31)
    .setFooter({ text: '子VCに参加している時だけ操作できます' });
}

function buildVcControlPanelRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_panel_rename').setLabel('名前').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('vc_panel_limit').setLabel('人数上限').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('vc_panel_claim').setLabel('権限取得').setStyle(ButtonStyle.Secondary).setEmoji('👑')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_panel_lock').setLabel('ロック').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('vc_panel_unlock').setLabel('ロック解除').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
    new ButtonBuilder().setCustomId('vc_panel_disconnect_all').setLabel('全員切断').setStyle(ButtonStyle.Danger).setEmoji('📞')
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_panel_hide').setLabel('非表示').setStyle(ButtonStyle.Secondary).setEmoji('🙈'),
    new ButtonBuilder().setCustomId('vc_panel_show').setLabel('表示').setStyle(ButtonStyle.Secondary).setEmoji('👀'),
    new ButtonBuilder().setCustomId('vc_panel_add_user').setLabel('ユーザー追加').setStyle(ButtonStyle.Secondary).setEmoji('➕'),
    new ButtonBuilder().setCustomId('vc_panel_delete').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );

  return [row1, row2, row3];
}

function getUserManagedChildVc(interaction) {
  const channelId = interaction.member?.voice?.channelId;
  if (!channelId) return { error: '❌ 先に子VCへ参加してください。' };

  const child = db.getChildVc(interaction.guild.id, channelId);
  if (!child) return { error: '❌ このVCはTempVoiceの管理対象ではありません。' };

  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    return { error: '❌ VCチャンネルが見つかりません。' };
  }

  return { child, channel };
}

function canEditVcPermissions(member, child) {
  const transfer = db.getVcTransferByParent(member.guild.id, child.parent_vc_id);
  const roleId = transfer?.permission_role_id;
  if (!roleId) return true;

  return member.roles.cache.has(roleId);
}

function canUseVcAction(member, child, action) {
  const transfer = db.getVcTransferByParent(member.guild.id, child.parent_vc_id);
  const roleMap = {
    lock: transfer?.lock_role_id,
    unlock: transfer?.unlock_role_id,
    hide: transfer?.hide_role_id,
    show: transfer?.show_role_id,
    delete: transfer?.delete_role_id,
  };

  const roleId = roleMap[action] || transfer?.permission_role_id;
  if (!roleId) return true;

  return member.roles.cache.has(roleId);
}

function parseRoleIdList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id.length > 0);
  } catch (_) {
    return [];
  }
}

function buildVcPanelAddUserSelectComponents(channelId, actorId) {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`vc_panel_add_user_select:${channelId}:${actorId}`)
        .setPlaceholder('VCに追加するユーザーを選択')
        .setMinValues(1)
        .setMaxValues(5),
    ),
  ];
}

async function setChildVcVisibility(guild, channel, child, visible) {
  const transfer = db.getVcTransferByParent(guild.id, child.parent_vc_id);
  const visibleRoleIds = parseRoleIdList(transfer?.visible_role_ids);
  const connectRoleIds = parseRoleIdList(transfer?.connect_role_ids);
  const visibleRoleIdSet = new Set(visibleRoleIds);
  const roleIds = [...new Set([...visibleRoleIds, ...connectRoleIds])];

  await channel.permissionOverwrites.edit(guild.id, {
    ViewChannel: visible ? (visibleRoleIds.length > 0 ? false : null) : false,
  });

  for (const roleId of roleIds) {
    if (!guild.roles.cache.has(roleId)) continue;
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: visible ? (visibleRoleIdSet.has(roleId) ? true : null) : false,
    });
  }
}

function collectRoleOptionIds(interaction, baseName, maxCount = 5) {
  const ids = [];
  for (let i = 1; i <= maxCount; i++) {
    const role = interaction.options.getRole(`${baseName}${i}`);
    if (role) ids.push(role.id);
  }
  return [...new Set(ids)];
}

function formatRoleMentions(roleIds) {
  if (!roleIds || roleIds.length === 0) return '未設定';
  return roleIds.map((id) => `<@&${id}>`).join(', ');
}

function buildInquiryForumPanelEmbed(title, description, items) {
  return new EmbedBuilder()
    .setTitle(`📩 ${title}`)
    .setDescription(parseNewlines(description))
    .setColor(0x5865f2)
    .setFooter({ text: '下のメニューからお問い合わせ内容を選択してください' });
}

function resolveGuildEmoji(guild, rawEmoji) {
  const value = rawEmoji?.trim();
  if (!value) return null;

  const customMatch = value.match(/^<a?:([\w~]+):(\d+)>$/) || value.match(/^:([\w~]+):$/);
  if (customMatch) {
    const emoji = customMatch[2]
      ? guild.emojis.cache.get(customMatch[2])
      : guild.emojis.cache.find(item => item.name === customMatch[1]);
    if (!emoji) return null;
    return emoji.toString();
  }

  if (value.includes(':')) return null;
  return value;
}

function buildInquiryForumSelect(items) {
  const options = items.slice(0, 25).map((item) => {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(item.name.slice(0, 100))
      .setDescription(parseNewlines(item.description).replace(/\s+/g, ' ').slice(0, 100))
      .setValue(item.item_key);
    if (item.emoji) option.setEmoji(item.emoji);
    return option;
  });

  return new StringSelectMenuBuilder()
    .setCustomId('inquiry_forum_open')
    .setPlaceholder('お問い合わせ内容を選択してください')
    .addOptions(options);
}

function isTextBasedChannel(channel) {
  return !!channel && typeof channel.isTextBased === 'function' && channel.isTextBased();
}

function isLogChannel(channel, guild) {
  const logChannelId = db.getSettings(guild.id).all_log_channel_id;
  return !!logChannelId && (channel?.id === logChannelId || channel?.parentId === logChannelId);
}

async function ensureLogForumThread(guild, threadName) {
  const settings = db.getSettings(guild.id);
  if (!settings.all_log_channel_id) return null;

  const forum = guild.channels.cache.get(settings.all_log_channel_id)
    || await guild.channels.fetch(settings.all_log_channel_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return null;

  await forum.threads.fetch().catch(() => null);
  const safeName = String(threadName || 'その他').slice(0, 100);
  const existing = forum.threads.cache.find(thread => thread.name === safeName);
  if (existing) return existing;
  return forum.threads.create({ name: safeName, message: { content: `${safeName}ログ` } }).catch(() => null);
}

async function sendAuditLog(guild, threadName, embed) {
  const thread = await ensureLogForumThread(guild, threadName);
  if (!thread) return;
  await thread.send({ embeds: [embed] }).catch(() => null);
}

async function sendVcTransferLog(guild, channelId, embed) {
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.warn(`VC転送ログ先が見つかりません (${channelId})`);
    return false;
  }

  if (channel.type === ChannelType.GuildForum) {
    await channel.threads.fetch().catch(() => null);
    const thread = channel.threads.cache.find(item => item.name === 'VC転送')
      || await channel.threads.create({ name: 'VC転送', message: { content: 'VC転送ログ' } }).catch(() => null);
    if (!thread) {
      console.warn(`VC転送ログのスレッドを作成できません (${channelId})`);
      return false;
    }
    const message = await thread.send({ embeds: [embed] }).catch(error => {
      console.warn('VC転送ログの送信に失敗しました:', error.message);
      return null;
    });
    return !!message;
  }

  if (isTextBasedChannel(channel)) {
    const message = await channel.send({ embeds: [embed] }).catch(error => {
      console.warn('VC転送ログの送信に失敗しました:', error.message);
      return null;
    });
    return !!message;
  }

  console.warn(`VC転送ログ先がテキスト/フォーラムではありません (${channelId})`);
  return false;
}

async function findRecentAuditEntry(guild, type, targetId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const auditLogs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
    const entry = auditLogs?.entries.find(item =>
      (!targetId || item.target?.id === targetId) && Date.now() - item.createdTimestamp < 15 * 1000
    );
    if (entry) return entry;
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

const SHARED_APP_MODE = process.env.ONE_TOKEN_MODE === 'true';
const COMMUNITY_BLOCKED_COMMANDS_IN_SHARED_MODE = new Set(['コマンド一覧', 'bot情報']);

const commands = [
  new SlashCommandBuilder()
    .setName('vc転送')
    .setDescription('[管理者] 親VCに参加したユーザーを子VCに自動転送する設定をします')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt.setName('親vc').setDescription('参加を検知する親VC').setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice)
    )
    .addStringOption((opt) => opt.setName('vcベース名').setDescription('子VCのベース名（例: 部屋）').setRequired(true))
    .addChannelOption((opt) =>
      opt.setName('作成先カテゴリ').setDescription('子VCを作成するカテゴリ').setRequired(true)
        .addChannelTypes(ChannelType.GuildCategory)
    )
    .addChannelOption((opt) =>
      opt.setName('ログチャンネル').setDescription('子VC作成ログの保存先（省略可）').setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)
    )
    .addRoleOption((opt) => opt.setName('閲覧ロール1').setDescription('子VCを閲覧できるロール1').setRequired(false))
    .addRoleOption((opt) => opt.setName('閲覧ロール2').setDescription('子VCを閲覧できるロール2').setRequired(false))
    .addRoleOption((opt) => opt.setName('閲覧ロール3').setDescription('子VCを閲覧できるロール3').setRequired(false))
    .addRoleOption((opt) => opt.setName('閲覧ロール4').setDescription('子VCを閲覧できるロール4').setRequired(false))
    .addRoleOption((opt) => opt.setName('閲覧ロール5').setDescription('子VCを閲覧できるロール5').setRequired(false))
    .addRoleOption((opt) => opt.setName('参加ロール1').setDescription('子VCへ参加できるロール1').setRequired(false))
    .addRoleOption((opt) => opt.setName('参加ロール2').setDescription('子VCへ参加できるロール2').setRequired(false))
    .addRoleOption((opt) => opt.setName('参加ロール3').setDescription('子VCへ参加できるロール3').setRequired(false))
    .addRoleOption((opt) => opt.setName('参加ロール4').setDescription('子VCへ参加できるロール4').setRequired(false))
    .addRoleOption((opt) => opt.setName('参加ロール5').setDescription('子VCへ参加できるロール5').setRequired(false))
    .addRoleOption((opt) => opt.setName('権限ロール').setDescription('共通の権限変更ロール').setRequired(false))
    .addRoleOption((opt) => opt.setName('ロックロール').setDescription('ロックを使えるロール').setRequired(false))
    .addRoleOption((opt) => opt.setName('解除ロール').setDescription('ロック解除を使えるロール').setRequired(false))
    .addRoleOption((opt) => opt.setName('非表示ロール').setDescription('非表示を使えるロール').setRequired(false))
    .addRoleOption((opt) => opt.setName('表示ロール').setDescription('表示を使えるロール').setRequired(false))
    .addRoleOption((opt) => opt.setName('削除ロール').setDescription('削除を使えるロール').setRequired(false)),

  new SlashCommandBuilder()
    .setName('vcパネル')
    .setDescription('[管理者] 公開のVC設定パネルを現在のチャンネルに設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('チケットパネル')
    .setDescription('[管理者] お問い合わせチケットパネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) => opt.setName('タイトル').setDescription('パネルのタイトル').setRequired(true))
    .addStringOption((opt) => opt.setName('説明').setDescription('パネルの説明（\\で改行）').setRequired(true))
    .addStringOption((opt) => opt.setName('ラベル').setDescription('ボタンのラベル').setRequired(true))
    .addChannelOption((opt) =>
      opt.setName('作成先カテゴリ').setDescription('チケットを作成するカテゴリ').setRequired(true)
        .addChannelTypes(ChannelType.GuildCategory)
    )
    .addChannelOption((opt) =>
      opt.setName('保存先チャンネル').setDescription('閉じたチケットのログ送信先').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addStringOption((opt) => opt.setName('自動送信メッセージ').setDescription('チケット作成時に自動送信するメッセージ（\\で改行）').setRequired(true))
    .addStringOption((opt) => opt.setName('絵文字').setDescription('ボタンに表示するサーバー絵文字（名前または絵文字コード）').setRequired(false).setMaxLength(100))
    .addRoleOption((opt) => opt.setName('ロール1').setDescription('チケットを閲覧できるロール1').setRequired(false))
    .addRoleOption((opt) => opt.setName('ロール2').setDescription('チケットを閲覧できるロール2').setRequired(false))
    .addRoleOption((opt) => opt.setName('ロール3').setDescription('チケットを閲覧できるロール3').setRequired(false)),

  new SlashCommandBuilder()
    .setName('チケットパネル削除')
    .setDescription('[管理者] チケットパネルを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((opt) => opt.setName('パネルid').setDescription('削除するパネルID').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('お問い合わせ設定')
    .setDescription('[管理者] お問い合わせ受付の作成先カテゴリと項目を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) => opt.setName('受付id').setDescription('受付項目の識別子（英数字・_・-）').setRequired(true).setMaxLength(30))
    .addStringOption((opt) => opt.setName('受付名').setDescription('パネルに表示する受付名').setRequired(true).setMaxLength(100))
    .addStringOption((opt) => opt.setName('説明').setDescription('受付項目の説明').setRequired(true).setMaxLength(200))
    .addChannelOption((opt) => opt.setName('作成先カテゴリ').setDescription('専用テキストチャンネルを作成するカテゴリ').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption((opt) => opt.setName('保存先チャンネル').setDescription('閉じたお問い合わせのログ送信先').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption((opt) => opt.setName('自動送信メッセージ').setDescription('作成時に送信する案内文（\\で改行）').setRequired(true).setMaxLength(2000))
    .addStringOption((opt) => opt.setName('絵文字').setDescription('表示する絵文字（省略可）').setRequired(false).setMaxLength(20))
    .addRoleOption((opt) => opt.setName('ロール1').setDescription('投稿を確認するロール1').setRequired(false))
    .addRoleOption((opt) => opt.setName('ロール2').setDescription('投稿を確認するロール2').setRequired(false))
    .addRoleOption((opt) => opt.setName('ロール3').setDescription('投稿を確認するロール3').setRequired(false)),

  new SlashCommandBuilder()
    .setName('お問い合わせ設定削除')
    .setDescription('[管理者] お問い合わせ受付の設定を削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) => opt.setName('受付id').setDescription('削除する受付項目のID').setRequired(true).setMaxLength(30)),

  new SlashCommandBuilder()
    .setName('お問い合わせフォーラムパネル設置')
    .setDescription('[管理者] 保存済みのお問い合わせ受付パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) => opt.setName('チャンネル').setDescription('パネルの設置先（省略時は現在のチャンネル）').setRequired(false).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((opt) => opt.setName('タイトル').setDescription('パネルのタイトル').setRequired(false).setMaxLength(100))
    .addStringOption((opt) => opt.setName('説明').setDescription('パネルの説明（\\で改行）').setRequired(false).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('リアクションロールメッセージ')
    .setDescription('[管理者] リアクションロール用のメッセージを送信します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) => opt.setName('メッセージ').setDescription('送信するメッセージ（\\で改行）').setRequired(true))
    .addStringOption((opt) => opt.setName('リアクション').setDescription('絵文字をカンマ区切りで入力（例: 🎉,👍,❤️）').setRequired(true)),

  new SlashCommandBuilder()
    .setName('リアクションロールセット')
    .setDescription('[管理者] リアクションロールのロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('固定メッセージ')
    .setDescription('[管理者] このチャンネルに常に最新で表示され続けるEmbedメッセージを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) => opt.setName('タイトル').setDescription('Embedのタイトル').setRequired(true))
    .addStringOption((opt) => opt.setName('説明').setDescription('Embedの説明文（\\で改行）').setRequired(true)),

  new SlashCommandBuilder()
    .setName('nuke')
    .setDescription('[管理者] このチャンネルをリセットします')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName('モード').setDescription('リセット方法').setRequired(true)
        .addChoices(
          { name: '作り直し（チャンネルを再作成）', value: 'recreate' },
          { name: '保持（メッセージを全削除）', value: 'purge' }
        )
    ),

  new SlashCommandBuilder()
    .setName('入室ログ')
    .setDescription('[管理者] ユーザーのサーバー参加を通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt.setName('チャンネル').setDescription('通知先チャンネル').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName('退出ログ')
    .setDescription('[管理者] ユーザーのサーバー退出を通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt.setName('チャンネル').setDescription('通知先チャンネル').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName('ログフォーラム')
    .setDescription('[管理者] 各種ログをまとめて記録するフォーラムを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) => opt
      .setName('フォーラム')
      .setDescription('ログの保存先フォーラム')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildForum)),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('[管理者] statusカテゴリの統計チャンネルを作成/更新します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('bot送信')
    .setDescription('メッセージリンク先の本文をBOTが送信します')
    .addStringOption((opt) =>
      opt.setName('メッセージリンク').setDescription('discord.com/channels/... のメッセージリンク').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('メッセージリンク表示')
    .setDescription('[管理者] メッセージリンク自動表示のオン/オフを切り替えます')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName('状態').setDescription('自動表示の状態').setRequired(true)
        .addChoices(
          { name: 'オン', value: 'on' },
          { name: 'オフ', value: 'off' }
        )
    ),

  new SlashCommandBuilder()
    .setName('コマンド一覧')
    .setDescription('[管理者・開発者] 利用可能コマンドの一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('bot情報')
    .setDescription('[開発者専用] BOTが参加しているサーバー一覧を表示します')
    .addStringOption((opt) =>
      opt.setName('表示').setDescription('表示形式を選択してください').setRequired(true)
        .addChoices(
          { name: '見える（全員に表示）', value: 'visible' },
          { name: '見えない（自分だけ）', value: 'hidden' }
        )
    ),
]
  .map((cmd) => cmd.toJSON())
  .filter((cmd) => !(SHARED_APP_MODE && COMMUNITY_BLOCKED_COMMANDS_IN_SHARED_MODE.has(cmd.name)));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('スラッシュコマンドを登録中...');
    for (const command of commands) {
      await rest.post(Routes.applicationCommands(CLIENT_ID), { body: command });
    }

    const statusCommand = commands.find((command) => command.name === 'status');
    if (GUILD_ID && statusCommand) {
      const guildCommands = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID));
      const existingStatusCommand = guildCommands.find((command) => command.name === 'status');
      if (existingStatusCommand) {
        await rest.patch(
          Routes.applicationGuildCommand(CLIENT_ID, GUILD_ID, existingStatusCommand.id),
          { body: statusCommand },
        );
      } else {
        await rest.post(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: statusCommand });
      }
      console.log(`ギルドコマンドを登録しました: /status (${GUILD_ID})`);
    }

    console.log('スラッシュコマンドの登録が完了しました');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
}

client.once('clientReady', async (c) => {
  console.log(`ログイン成功: ${c.user.tag}`);
  await registerCommands();
  await refreshAllStatusBoards();
  setInterval(() => {
    refreshAllStatusBoards().catch((err) => console.error('status定期更新エラー:', err));
  }, STATUS_REFRESH_INTERVAL_MS);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id;

  if (newState.channelId && newState.channelId !== oldState.channelId) {
    try {
      const parentVcId = newState.channelId;
      const config = db.getVcTransferByParent(guildId, parentVcId);
      if (config) {
        const number = db.getNextChildVcNumber(guildId, parentVcId);
        const parentChannel = newState.guild.channels.cache.get(parentVcId);
        const visibleRoleIds = parseRoleIdList(config.visible_role_ids);
        const connectRoleIds = parseRoleIdList(config.connect_role_ids);
        const permissionOverwrites = [];

        if (visibleRoleIds.length > 0) {
          permissionOverwrites.push({ id: newState.guild.id, deny: [PermissionFlagsBits.ViewChannel] });
          for (const roleId of visibleRoleIds) {
            permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel] });
          }
        }

        if (connectRoleIds.length > 0) {
          permissionOverwrites.push({ id: newState.guild.id, deny: [PermissionFlagsBits.Connect] });
          for (const roleId of connectRoleIds) {
            permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.Connect] });
          }
        }

        permissionOverwrites.push({
          id: newState.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        });

        const childVc = await newState.guild.channels.create({
          name: `${config.base_name} ${number}`,
          type: ChannelType.GuildVoice,
          parent: config.category_id,
          userLimit: parentChannel?.userLimit ?? 0,
          permissionOverwrites,
        });
        db.addChildVc(guildId, childVc.id, parentVcId, number, newState.id);
        let transferSucceeded = true;
        let transferError = null;
        try {
          await newState.setChannel(childVc);
        } catch (error) {
          transferSucceeded = false;
          transferError = error.message;
          console.error('VC転送先への移動に失敗しました:', error);
        }
        await sendVcTransferLog(newState.guild, config.log_channel_id, new EmbedBuilder()
          .setTitle('🔊 VC転送で子VCが作成されました')
          .setColor(0x57f287)
          .addFields(
            { name: '作成者', value: `<@${newState.id}>`, inline: true },
            { name: '作成時刻', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
            { name: '親VC', value: `<#${parentVcId}>`, inline: true },
            { name: '作成された子VC', value: `<#${childVc.id}>`, inline: true },
            { name: 'カテゴリ', value: `<#${config.category_id}>`, inline: true },
            { name: '転送結果', value: transferSucceeded ? '成功' : `失敗: ${transferError || '不明'}`, inline: false },
          )
          .setTimestamp());
      }
    } catch (err) {
      console.error('VC転送エラー:', err);
    }
  }

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    try {
      const childData = db.getChildVc(guildId, oldState.channelId);
      if (childData) {
        const channel = oldState.guild.channels.cache.get(oldState.channelId);
        if (channel && channel.members.size === 0) {
          await channel.delete();
          db.removeChildVc(guildId, oldState.channelId);
        } else if (channel && childData.owner_id === oldState.id) {
          const nextOwner = channel.members.find((m) => !m.user.bot);
          db.setChildVcOwner(guildId, oldState.channelId, nextOwner?.id || null);
        }
      }
    } catch (err) {
      console.error('子VC削除エラー:', err);
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    const settings = db.getSettings(member.guild.id);
    if (settings.all_log_channel_id) {
      const user = member.user;
      await sendAuditLog(member.guild, '入室', new EmbedBuilder()
        .setTitle('📥 メンバーが参加しました')
        .setColor(0x57f287)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 64 }))
        .addFields(
          { name: '表示名', value: member.displayName, inline: true },
          { name: 'ユーザー名', value: user.username, inline: true },
          { name: 'ユーザーID', value: user.id, inline: true },
          { name: 'メンション', value: `<@${user.id}>`, inline: true },
        )
        .setTimestamp());
      return;
    }
    if (!settings.join_log_channel_id) return;

    const logChannel = member.guild.channels.cache.get(settings.join_log_channel_id);
    if (!logChannel) return;

    const user = member.user;
    const embed = new EmbedBuilder()
      .setTitle('📥 メンバーが参加しました')
      .setColor(0x57f287)
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 64 }))
      .addFields(
        { name: '表示名', value: member.displayName, inline: true },
        { name: 'ユーザー名', value: user.username, inline: true },
        { name: 'ユーザーID', value: user.id, inline: true },
        { name: 'メンション', value: `<@${user.id}>`, inline: true }
      )
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('入室ログエラー:', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const settings = db.getSettings(member.guild.id);
    if (settings.all_log_channel_id) {
      const auditLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 }).catch(() => null);
      const kickLog = auditLogs?.entries.find(entry =>
        entry.target?.id === member.id && Date.now() - entry.createdTimestamp < 15 * 1000
      );
      if (kickLog) {
        await sendAuditLog(member.guild, 'ban・kick', new EmbedBuilder()
          .setTitle('👢 メンバーがKICKされました')
          .setColor(0xed4245)
          .addFields(
            { name: '対象', value: `<@${member.id}>`, inline: true },
            { name: '実行者', value: kickLog.executor ? `<@${kickLog.executor.id}>` : '不明', inline: true },
            { name: '理由', value: kickLog.reason || '理由なし', inline: false },
          )
          .setTimestamp());
        return;
      }
      const user = member.user;
      await sendAuditLog(member.guild, '退出', new EmbedBuilder()
        .setTitle('📤 メンバーが退出しました')
        .setColor(0xed4245)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 64 }))
        .addFields(
          { name: '表示名', value: member.displayName, inline: true },
          { name: 'ユーザー名', value: user.username, inline: true },
          { name: 'ユーザーID', value: user.id, inline: true },
          { name: 'メンション', value: `<@${user.id}>`, inline: true },
        )
        .setTimestamp());
      return;
    }
    if (!settings.leave_log_channel_id) return;

    const logChannel = member.guild.channels.cache.get(settings.leave_log_channel_id);
    if (!logChannel) return;

    const user = member.user;
    const embed = new EmbedBuilder()
      .setTitle('📤 メンバーが退出しました')
      .setColor(0xed4245)
      .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 64 }))
      .addFields(
        { name: '表示名', value: member.displayName, inline: true },
        { name: 'ユーザー名', value: user.username, inline: true },
        { name: 'ユーザーID', value: user.id, inline: true },
        { name: 'メンション', value: `<@${user.id}>`, inline: true }
      )
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('退出ログエラー:', err);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || isLogChannel(newMessage.channel, newMessage.guild)) return;
  if (oldMessage.content === newMessage.content) return;

  await sendAuditLog(newMessage.guild, 'メッセージ削除・編集', new EmbedBuilder()
    .setTitle('✏️ メッセージが編集されました')
    .setColor(0xfee75c)
    .addFields(
      { name: '投稿者', value: `<@${newMessage.author.id}>`, inline: true },
      { name: 'チャンネル', value: `<#${newMessage.channel.id}>`, inline: true },
      { name: 'メッセージ', value: `[メッセージを開く](${newMessage.url})`, inline: true },
      { name: '編集前', value: String(oldMessage.content || '（取得できませんでした）').slice(0, 1024), inline: false },
      { name: '編集後', value: String(newMessage.content || '（本文なし）').slice(0, 1024), inline: false },
    )
    .setTimestamp());
});

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot || isLogChannel(message.channel, message.guild)) return;

  await sendAuditLog(message.guild, 'メッセージ削除・編集', new EmbedBuilder()
    .setTitle('🗑️ メッセージが削除されました')
    .setColor(0xed4245)
    .addFields(
      { name: '投稿者', value: message.author ? `<@${message.author.id}>` : '不明', inline: true },
      { name: 'チャンネル', value: `<#${message.channel.id}>`, inline: true },
      { name: '内容', value: String(message.content || '（本文なし）').slice(0, 1024), inline: false },
    )
    .setTimestamp());
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.user.bot) return;
  const oldRoleIds = new Set(oldMember.roles.cache.keys());
  const newRoleIds = new Set(newMember.roles.cache.keys());
  const addedRoles = [...newRoleIds].filter(roleId => !oldRoleIds.has(roleId) && roleId !== newMember.guild.id);
  const removedRoles = [...oldRoleIds].filter(roleId => !newRoleIds.has(roleId) && roleId !== newMember.guild.id);
  const nameChanged = oldMember.displayName !== newMember.displayName;
  if (!nameChanged && addedRoles.length === 0 && removedRoles.length === 0) return;

  const roleAudit = (addedRoles.length > 0 || removedRoles.length > 0)
    ? await findRecentAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id)
    : null;

  await sendAuditLog(newMember.guild, '名前・ロール', new EmbedBuilder()
    .setTitle('👤 メンバー情報が変更されました')
    .setColor(0x5865f2)
    .addFields(
      { name: '対象', value: `<@${newMember.id}>`, inline: true },
      { name: '実行者', value: roleAudit?.executor ? `<@${roleAudit.executor.id}>` : '不明または本人', inline: true },
      { name: '名前', value: nameChanged ? `${oldMember.displayName} → ${newMember.displayName}` : '変更なし', inline: false },
      { name: '付与されたロール', value: addedRoles.map(roleId => `<@&${roleId}>`).join(' ') || 'なし', inline: false },
      { name: '外されたロール', value: removedRoles.map(roleId => `<@&${roleId}>`).join(' ') || 'なし', inline: false },
    )
    .setTimestamp());
});

client.on('roleCreate', async (role) => {
  const audit = await findRecentAuditEntry(role.guild, AuditLogEvent.RoleCreate, role.id);
  await sendAuditLog(role.guild, '名前・ロール', new EmbedBuilder()
    .setTitle('➕ ロールが作成されました')
    .setColor(0x57f287)
    .addFields(
      { name: 'ロール', value: `<@&${role.id}>`, inline: true },
      { name: '名前', value: role.name, inline: true },
      { name: '作成者', value: audit?.executor ? `<@${audit.executor.id}>` : '不明', inline: true },
      { name: 'ロールID', value: role.id, inline: false },
    )
    .setTimestamp());
});

client.on('roleDelete', async (role) => {
  const audit = await findRecentAuditEntry(role.guild, AuditLogEvent.RoleDelete, role.id);
  await sendAuditLog(role.guild, '名前・ロール', new EmbedBuilder()
    .setTitle('➖ ロールが削除されました')
    .setColor(0xed4245)
    .addFields(
      { name: 'ロール名', value: role.name, inline: true },
      { name: '削除者', value: audit?.executor ? `<@${audit.executor.id}>` : '不明', inline: true },
      { name: 'ロールID', value: role.id, inline: false },
    )
    .setTimestamp());
});

client.on('roleUpdate', async (oldRole, newRole) => {
  const changes = [];
  if (oldRole.name !== newRole.name) changes.push(`名前: ${oldRole.name} → ${newRole.name}`);
  if (oldRole.color !== newRole.color) changes.push(`色: #${oldRole.color.toString(16).padStart(6, '0')} → #${newRole.color.toString(16).padStart(6, '0')}`);
  if (oldRole.hoist !== newRole.hoist) changes.push(`別枠表示: ${oldRole.hoist ? 'オン' : 'オフ'} → ${newRole.hoist ? 'オン' : 'オフ'}`);
  if (oldRole.mentionable !== newRole.mentionable) changes.push(`メンション可否: ${oldRole.mentionable ? '可' : '不可'} → ${newRole.mentionable ? '可' : '不可'}`);
  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push('権限設定が変更されました');
  if (changes.length === 0) return;

  const audit = await findRecentAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  await sendAuditLog(newRole.guild, '名前・ロール', new EmbedBuilder()
    .setTitle('⚙️ ロール設定が変更されました')
    .setColor(0xfee75c)
    .addFields(
      { name: 'ロール', value: `<@&${newRole.id}>`, inline: true },
      { name: '変更者', value: audit?.executor ? `<@${audit.executor.id}>` : '不明', inline: true },
      { name: '変更内容', value: changes.join('\n'), inline: false },
    )
    .setTimestamp());
});

client.on('guildBanAdd', async (ban) => {
  await sendAuditLog(ban.guild, 'ban・kick', new EmbedBuilder()
    .setTitle('🔨 メンバーがBANされました')
    .setColor(0xed4245)
    .addFields(
      { name: '対象', value: `<@${ban.user.id}>`, inline: true },
      { name: 'ユーザーID', value: ban.user.id, inline: true },
      { name: '理由', value: ban.reason || '理由なし', inline: false },
    )
    .setTimestamp());
});

client.on('guildBanRemove', async (ban) => {
  await sendAuditLog(ban.guild, 'ban・kick', new EmbedBuilder()
    .setTitle('🔓 BANが解除されました')
    .setColor(0x57f287)
    .addFields({ name: '対象', value: `<@${ban.user.id}> (${ban.user.id})` })
    .setTimestamp());
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild || isLogChannel(channel, channel.guild)) return;
  const audit = await findRecentAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  await sendAuditLog(channel.guild, 'チャンネル・スレッド', new EmbedBuilder()
    .setTitle('📁 チャンネルが作成されました')
    .setColor(0x57f287)
    .addFields(
      { name: 'チャンネル', value: `<#${channel.id}>`, inline: true },
      { name: '種類', value: channel.type === ChannelType.GuildPublicThread || channel.type === ChannelType.GuildPrivateThread ? 'スレッド' : 'チャンネル', inline: true },
      { name: '作成者', value: audit?.executor ? `<@${audit.executor.id}>` : '不明', inline: true },
    )
    .setTimestamp());
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild || isLogChannel(channel, channel.guild)) return;
  await sendAuditLog(channel.guild, 'チャンネル・スレッド', new EmbedBuilder()
    .setTitle('🗑️ チャンネルが削除されました')
    .setColor(0xed4245)
    .addFields(
      { name: 'チャンネル名', value: channel.name || '不明', inline: true },
      { name: 'チャンネルID', value: channel.id, inline: true },
    )
    .setTimestamp());
});

function getChannelPermissionSnapshot(channel) {
  return [...(channel.permissionOverwrites?.cache?.values() || [])]
    .map(overwrite => `${overwrite.id}:${overwrite.type}:${overwrite.allow.bitfield}:${overwrite.deny.bitfield}`)
    .sort()
    .join('|');
}

function getChannelSettingValue(channel, key) {
  const value = channel[key];
  if (value === undefined || value === null) return 'なし';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function getChannelChanges(oldChannel, newChannel) {
  const changes = [];
  const settings = [
    ['名前', 'name'],
    ['カテゴリ', 'parentId'],
    ['トピック', 'topic'],
    ['NSFW', 'nsfw'],
    ['低速モード', 'rateLimitPerUser'],
    ['人数上限', 'userLimit'],
    ['ビットレート', 'bitrate'],
    ['地域', 'rtcRegion'],
    ['動画品質', 'videoQualityMode'],
    ['自動アーカイブ', 'defaultAutoArchiveDuration'],
    ['スレッド低速モード', 'defaultThreadRateLimitPerUser'],
    ['フォーラムレイアウト', 'defaultForumLayout'],
    ['フォーラム並び順', 'defaultSortOrder'],
    ['デフォルトリアクション', 'defaultReactionEmoji'],
    ['タグ', 'availableTags'],
  ];

  for (const [label, key] of settings) {
    const oldValue = getChannelSettingValue(oldChannel, key);
    const newValue = getChannelSettingValue(newChannel, key);
    if (oldValue !== newValue) {
      changes.push(`${label}: ${oldValue} → ${newValue}`);
    }
  }

  if (getChannelPermissionSnapshot(oldChannel) !== getChannelPermissionSnapshot(newChannel)) {
    changes.push('権限設定が変更されました');
  }

  return changes;
}

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild || isLogChannel(newChannel, newChannel.guild)) return;
  const changes = getChannelChanges(oldChannel, newChannel);
  if (changes.length === 0) return;
  const audit = await findRecentAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
  await sendAuditLog(newChannel.guild, 'チャンネル・スレッド', new EmbedBuilder()
    .setTitle('✏️ チャンネルが変更されました')
    .setColor(0xfee75c)
    .addFields(
      { name: 'チャンネル', value: `<#${newChannel.id}>`, inline: true },
      { name: '変更者', value: audit?.executor ? `<@${audit.executor.id}>` : '不明', inline: true },
      { name: '変更内容', value: changes.join('\n').slice(0, 1024), inline: false },
    )
    .setTimestamp());
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();

    const messageId = reaction.message.id;
    const guildId = reaction.message.guildId;
    if (!guildId) return;

    const key = emojiToKey(reaction.emoji);
    const mapping = db.getReactionRoleMapping(messageId, key);

    if (mapping && mapping.role_id) {
      const guild = reaction.message.guild;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) await member.roles.add(mapping.role_id).catch(() => {});
    }
  } catch (err) {
    console.error('リアクション追加エラー:', err);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();

    const messageId = reaction.message.id;
    const guildId = reaction.message.guildId;
    if (!guildId) return;

    const key = emojiToKey(reaction.emoji);
    const mapping = db.getReactionRoleMapping(messageId, key);

    if (mapping && mapping.role_id) {
      const guild = reaction.message.guild;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) await member.roles.remove(mapping.role_id).catch(() => {});
    }
  } catch (err) {
    console.error('リアクション削除エラー:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const previewEnabled = db.isMessageLinkPreviewEnabled(message.guild.id);
  if (previewEnabled) {
    const linkData = extractMessageLink(message.content);
    if (linkData) {
      const resolved = await resolveLinkedMessage(linkData);
      if (resolved) {
        const quoted = buildQuotedMessageContent(resolved.message);
        if (quoted) {
          await message.channel.send({ content: quoted }).catch(() => {});
          return;
        }
      }
    }
  }

  const guildId = message.guild.id;
  const channelId = message.channel.id;

  if (repinningChannels.has(channelId)) return;

  const pinned = db.getPinnedMessage(guildId, channelId);
  if (!pinned) return;

  if (message.id === pinned.message_id) return;

  repinningChannels.add(channelId);
  try {
    const oldMsg = await message.channel.messages.fetch(pinned.message_id).catch(() => null);
    if (oldMsg) await oldMsg.delete();

    const embed = new EmbedBuilder()
      .setTitle(pinned.title)
      .setDescription(parseNewlines(pinned.description))
      .setColor(0x5865f2);

    const sent = await message.channel.send({ embeds: [embed] });
    db.setPinnedMessage(guildId, channelId, sent.id, pinned.title, pinned.description);
  } catch (err) {
    console.error('固定メッセージ再送エラー:', err);
  } finally {
    repinningChannels.delete(channelId);
  }
});

client.on('interactionCreate', async (interaction) => {
  const guildId = interaction.guild?.id;

  try {
    if (interaction.isButton() && interaction.customId.startsWith('vc_panel_')) {
      const action = interaction.customId.replace('vc_panel_', '');
      const target = getUserManagedChildVc(interaction);
      if (target.error) {
        await interaction.reply({ content: target.error, flags: MessageFlags.Ephemeral });
        return;
      }

      const { child, channel } = target;
      const isOwner = child.owner_id === interaction.user.id;
      const canEditPermissions = canEditVcPermissions(interaction.member, child);
      const canLock = canUseVcAction(interaction.member, child, 'lock');
      const canUnlock = canUseVcAction(interaction.member, child, 'unlock');
      const canHide = canUseVcAction(interaction.member, child, 'hide');
      const canShow = canUseVcAction(interaction.member, child, 'show');
      const canDelete = canUseVcAction(interaction.member, child, 'delete');

      if (action === 'claim') {
        db.setChildVcOwner(guildId, channel.id, interaction.user.id);
        await interaction.reply({ content: `✅ <@${interaction.user.id}> がこのVCのオーナーになりました。`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (!isOwner) {
        await interaction.reply({ content: `❌ このVCのオーナーのみ操作できます。現在のオーナー: ${child.owner_id ? `<@${child.owner_id}>` : '未設定'}`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'rename') {
        const modal = new ModalBuilder().setCustomId(`vc_modal_rename_${channel.id}`).setTitle('VC名を変更');
        const nameInput = new TextInputBuilder()
          .setCustomId('vc_name')
          .setLabel('新しいVC名')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(channel.name);
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        await interaction.showModal(modal);
        return;
      }

      if (action === 'limit') {
        const modal = new ModalBuilder().setCustomId(`vc_modal_limit_${channel.id}`).setTitle('人数上限を変更');
        const limitInput = new TextInputBuilder()
          .setCustomId('vc_limit')
          .setLabel('人数上限 (0-99, 0は無制限)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setValue(String(channel.userLimit || 0));
        modal.addComponents(new ActionRowBuilder().addComponents(limitInput));
        await interaction.showModal(modal);
        return;
      }

      if (action === 'add_user') {
        if (!canEditPermissions) {
          await interaction.reply({ content: '❌ 権限ロールを持っている人だけできます。', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: '追加するユーザーを選択してください。',
          components: buildVcPanelAddUserSelectComponents(channel.id, interaction.user.id),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'lock') {
        if (!canLock) {
          await interaction.reply({ content: '❌ ロック権限ロールを持っている人だけできます。', flags: MessageFlags.Ephemeral });
          return;
        }
        await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
        await interaction.reply({ content: '✅ VCをロックしました。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'unlock') {
        if (!canUnlock) {
          await interaction.reply({ content: '❌ ロック解除権限ロールを持っている人だけできます。', flags: MessageFlags.Ephemeral });
          return;
        }
        await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: null });
        await interaction.reply({ content: '✅ VCのロックを解除しました。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'hide') {
        if (!canHide) {
          await interaction.reply({ content: '❌ 非表示権限ロールを持っている人だけできます。', flags: MessageFlags.Ephemeral });
          return;
        }
        await setChildVcVisibility(interaction.guild, channel, child, false);
        await interaction.reply({ content: '✅ VCを非表示にしました。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'show') {
        if (!canShow) {
          await interaction.reply({ content: '❌ 表示権限ロールを持っている人だけできます。', flags: MessageFlags.Ephemeral });
          return;
        }
        await setChildVcVisibility(interaction.guild, channel, child, true);
        await interaction.reply({ content: '✅ VCを表示状態に戻しました。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'disconnect_all') {
        const members = [...channel.members.values()].filter((m) => !m.user.bot);
        for (const m of members) {
          await m.voice.disconnect().catch(() => {});
        }
        await interaction.reply({ content: `✅ ${members.length}人をVCから切断しました。`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'delete') {
        if (!canDelete) {
          await interaction.reply({ content: '❌ 削除権限ロールを持っている人だけできます。', flags: MessageFlags.Ephemeral });
          return;
        }
        await channel.delete();
        db.removeChildVc(guildId, channel.id);
        await interaction.reply({ content: '✅ VCを削除しました。', flags: MessageFlags.Ephemeral });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('vc_modal_')) {
      const [, , modalType, channelId] = interaction.customId.split('_');
      const child = db.getChildVc(guildId, channelId);
      if (!child) {
        await interaction.reply({ content: '❌ このVCは既に削除されたか、管理対象外です。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (child.owner_id !== interaction.user.id) {
        await interaction.reply({ content: '❌ このVCのオーナーのみ変更できます。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ VCチャンネルが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (modalType === 'rename') {
        const nextName = interaction.fields.getTextInputValue('vc_name').trim();
        if (!nextName) {
          await interaction.reply({ content: '❌ VC名を入力してください。', flags: MessageFlags.Ephemeral });
          return;
        }

        await channel.setName(nextName.slice(0, 100));
        await interaction.reply({ content: `✅ VC名を **${nextName.slice(0, 100)}** に変更しました。`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (modalType === 'limit') {
        const raw = interaction.fields.getTextInputValue('vc_limit').trim();
        if (!/^\d{1,2}$/.test(raw)) {
          await interaction.reply({ content: '❌ 0-99の数字で入力してください。', flags: MessageFlags.Ephemeral });
          return;
        }

        const limit = Number(raw);
        if (limit < 0 || limit > 99) {
          await interaction.reply({ content: '❌ 人数上限は0-99の範囲で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }

        await channel.setUserLimit(limit);
        await interaction.reply({ content: `✅ 人数上限を **${limit}** に変更しました。`, flags: MessageFlags.Ephemeral });
        return;
      }
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_panel_add_user_select:')) {
      const [prefix, channelId, actorId] = interaction.customId.split(':');
      if (prefix !== 'vc_panel_add_user_select') return;

      const child = db.getChildVc(guildId, channelId);
      if (!child) {
        await interaction.update({ content: '❌ このVCは既に削除されたか、管理対象外です。', components: [] });
        return;
      }

      if (interaction.user.id !== actorId) {
        await interaction.update({ content: '❌ この選択UIを開いたユーザーのみ操作できます。', components: [] });
        return;
      }

      if (child.owner_id !== interaction.user.id) {
        await interaction.update({ content: '❌ このVCのオーナーのみ操作できます。', components: [] });
        return;
      }

      if (!canEditVcPermissions(interaction.member, child)) {
        await interaction.update({ content: '❌ 権限ロールを持っている人だけできます。', components: [] });
        return;
      }

      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.update({ content: '❌ VCチャンネルが見つかりません。', components: [] });
        return;
      }

      const addedMentions = [];
      for (const userId of interaction.values) {
        const targetMember = interaction.guild.members.cache.get(userId)
          || await interaction.guild.members.fetch(userId).catch(() => null);
        if (!targetMember || targetMember.user.bot) continue;

        await channel.permissionOverwrites.edit(targetMember.id, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
        }).catch(() => null);
        addedMentions.push(`<@${targetMember.id}>`);
      }

      await interaction.update({
        content: addedMentions.length > 0
          ? `✅ 追加しました: ${addedMentions.join(' ')}`
          : 'ℹ️ 追加できるユーザーが選択されていませんでした。',
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket_open_')) {
      const panelId = parseInt(interaction.customId.split('_')[2], 10);
      const panel = db.getTicketPanel(panelId);
      if (!panel) {
        await interaction.reply({ content: '❌ このパネルの設定が見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const roles = [panel.role1_id, panel.role2_id, panel.role3_id].filter(Boolean);
      const permissionOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
          ],
        },
      ];

      for (const roleId of roles) {
        permissionOverwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
          ],
        });
      }

      const ticketChannel = await interaction.guild.channels.create({
        name: 'ticket-temp',
        type: ChannelType.GuildText,
        parent: panel.category_id,
        permissionOverwrites,
      });

      const ticketId = db.createTicket(guildId, ticketChannel.id, interaction.user.id, panelId);
      const rawDisplayName = interaction.member?.displayName || interaction.user.username;
      const safeDisplayName = rawDisplayName
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 70) || 'user';
      await ticketChannel.setName(`ticket-${ticketId}-${safeDisplayName}様`);

      const mentionParts = roles.map((r) => `<@&${r}>`);
      mentionParts.push(`<@${interaction.user.id}>`);

      const autoEmbed = new EmbedBuilder()
        .setTitle('📩 ' + panel.title)
        .setDescription(parseNewlines(panel.auto_message))
        .setColor(0x5865f2)
        .setTimestamp();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_close_${ticketChannel.id}`)
          .setLabel('🔒 チケットを閉じる')
          .setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({
        content: mentionParts.join(' '),
        embeds: [autoEmbed],
        components: [closeRow],
      });

      await interaction.editReply({ content: `✅ チケットが作成されました: <#${ticketChannel.id}>` });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('inquiry_forum_close_')) {
      const channelId = interaction.customId.replace('inquiry_forum_close_', '');
      const ticket = db.getInquiryForumTicketByChannel(channelId);
      if (!ticket) {
        await interaction.reply({ content: '❌ このお問い合わせチャンネルの情報が見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`inquiry_forum_confirm_${channelId}`).setLabel('はい').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`inquiry_forum_cancel_${channelId}`).setLabel('いいえ').setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        content: 'このお問い合わせを閉じてログを保存しますか？',
        components: [confirmRow],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('inquiry_forum_confirm_')) {
      const channelId = interaction.customId.replace('inquiry_forum_confirm_', '');
      const ticket = db.getInquiryForumTicketByChannel(channelId);
      if (!ticket) {
        await interaction.reply({ content: '❌ お問い合わせチャンネルは既に削除されています。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticketChannel = interaction.guild.channels.cache.get(channelId);
      const item = db.getInquiryForumItem(guildId, ticket.item_key);
      const transcriptText = ticketChannel ? await buildTranscript(ticketChannel) : '(チャンネルが見つかりません)';
      const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), {
        name: `inquiry-${ticket.id}-transcript.txt`,
      });
      const logEmbed = new EmbedBuilder()
        .setTitle('🔒 お問い合わせクローズ')
        .setColor(0xed4245)
        .addFields(
          { name: 'お問い合わせID', value: `inquiry-${ticket.id}`, inline: true },
          { name: '受付', value: ticket.item_key, inline: true },
          { name: '作成者', value: `<@${ticket.creator_id}>`, inline: true },
          { name: '閉じたユーザー', value: `<@${interaction.user.id}>`, inline: true }
        )
        .setTimestamp();

      if (item?.log_channel_id) {
        const logChannel = interaction.guild.channels.cache.get(item.log_channel_id);
        if (logChannel) {
          await logChannel.send({
            content: `<@${ticket.creator_id}> <@${interaction.user.id}>`,
            embeds: [logEmbed],
            files: [attachment],
          });
        }
      }

      db.deleteInquiryForumTicket(channelId);
      if (ticketChannel) await ticketChannel.delete().catch(() => {});
      await interaction.editReply({ content: '✅ お問い合わせを閉じ、ログを保存しました。' });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('inquiry_forum_cancel_')) {
      await interaction.reply({ content: '✅ キャンセルしました。お問い合わせはそのまま続行されます。', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'inquiry_forum_open') {
      const itemKey = interaction.values[0];
      const item = db.getInquiryForumItem(guildId, itemKey);
      if (!item) {
        await interaction.reply({ content: '❌ この受付項目の設定が見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const category = interaction.guild.channels.cache.get(item.forum_channel_id);
      if (!category || category.type !== ChannelType.GuildCategory) {
        await interaction.reply({ content: '❌ 設定された作成先カテゴリが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const roles = [item.role1_id, item.role2_id, item.role3_id].filter(Boolean);
      const rawDisplayName = interaction.member?.displayName || interaction.user.username;
      const displayName = rawDisplayName
        .replace(/[^a-zA-Z0-9\u3040-\u30ff\u3400-\u9fff_-]/g, '')
        .slice(0, 58) || 'user';
      const permissionOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
          ],
        },
      ];
      for (const roleId of roles) {
        permissionOverwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.UseExternalEmojis,
          ],
        });
      }

      const ticketChannel = await interaction.guild.channels.create({
        name: `inquiry-${displayName}様`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites,
      });
      const ticketId = db.createInquiryForumTicket(guildId, ticketChannel.id, interaction.user.id, item.item_key);
      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`inquiry_forum_close_${ticketChannel.id}`)
          .setLabel('🔒 お問い合わせを閉じる')
          .setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({
        content: [...roles.map((roleId) => `<@&${roleId}>`), `<@${interaction.user.id}>`].join(' '),
        embeds: [new EmbedBuilder()
          .setTitle(`📩 ${item.name}`)
          .setDescription([
            parseNewlines(item.auto_message || item.description),
            '',
            'こちらのお問い合わせチャンネルで内容をお送りください。',
          ].join('\n'))
          .setColor(0x5865f2)
          .setFooter({ text: `受付ID: ${item.item_key} / お問い合わせID: ${ticketId}` })
          .setTimestamp()],
        components: [closeRow],
      });

      await interaction.editReply({ content: `✅ お問い合わせチャンネルを作成しました: <#${ticketChannel.id}>` });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket_close_')) {
      const channelId = interaction.customId.replace('ticket_close_', '');
      const ticket = db.getTicketByChannel(channelId);
      if (!ticket) {
        await interaction.reply({ content: '❌ このチケットの情報が見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_confirm_${channelId}`).setLabel('はい').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`ticket_cancel_${channelId}`).setLabel('いいえ').setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: '本当にこのチケットを閉じますか？',
        components: [confirmRow],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket_confirm_')) {
      const channelId = interaction.customId.replace('ticket_confirm_', '');
      const ticket = db.getTicketByChannel(channelId);
      if (!ticket) {
        await interaction.reply({ content: '❌ チケットが既に削除されています。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const ticketChannel = interaction.guild.channels.cache.get(channelId);
      const panel = db.getTicketPanel(ticket.panel_id);

      let transcriptText = '(チャンネルが見つかりません)';
      if (ticketChannel) transcriptText = await buildTranscript(ticketChannel);

      const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), {
        name: `ticket-${ticket.id}-transcript.txt`,
      });

      const logEmbed = new EmbedBuilder()
        .setTitle('🔒 チケットクローズ')
        .setColor(0xed4245)
        .addFields(
          { name: 'チケットID', value: `ticket-${ticket.id}`, inline: true },
          { name: '作成者', value: `<@${ticket.creator_id}>`, inline: true },
          { name: '閉じたユーザー', value: `<@${interaction.user.id}>`, inline: true }
        )
        .setTimestamp();

      if (panel?.log_channel_id) {
        const logChannel = interaction.guild.channels.cache.get(panel.log_channel_id);
        if (logChannel) {
          await logChannel.send({
            content: `<@${ticket.creator_id}> <@${interaction.user.id}>`,
            embeds: [logEmbed],
            files: [attachment],
          });
        }
      }

      db.deleteTicket(channelId);
      if (ticketChannel) await ticketChannel.delete().catch(() => {});

      await interaction.editReply({ content: '✅ チケットを閉じました。' });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket_cancel_')) {
      await interaction.reply({ content: '✅ キャンセルしました。チケットはそのまま続行されます。', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'rrset_step1') {
      const msgDbId = parseInt(interaction.values[0], 10);
      const msgData = db.getReactionRoleMessageById(msgDbId);
      if (!msgData) {
        await interaction.reply({ content: '❌ メッセージが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetChannel = interaction.guild.channels.cache.get(msgData.channel_id);
      if (!targetChannel) {
        await interaction.reply({ content: '❌ チャンネルが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetMessage = await targetChannel.messages.fetch(msgData.message_id).catch(() => null);
      if (!targetMessage) {
        await interaction.reply({ content: '❌ メッセージが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const reactions = [...targetMessage.reactions.cache.values()];
      if (reactions.length === 0) {
        await interaction.reply({ content: '❌ このメッセージにリアクションがありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const options = reactions.map((r) => {
        const key = emojiToKey(r.emoji);
        const existing = db.getReactionRoleMapping(msgData.message_id, key);
        const label = existing?.role_id ? `${key} (設定済み)` : key;
        return new StringSelectMenuOptionBuilder()
          .setLabel(label.length > 100 ? label.slice(0, 100) : label)
          .setValue(`${msgDbId}::${key}`);
      });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('rrset_step2')
        .setPlaceholder('設定するリアクションを選択してください')
        .addOptions(options);

      await interaction.reply({
        content: `📋 **${msgData.content.slice(0, 50)}** のリアクションを選択してください:`,
        components: [new ActionRowBuilder().addComponents(selectMenu)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'rrset_step2') {
      const [msgDbId, emoji] = interaction.values[0].split('::');
      const msgData = db.getReactionRoleMessageById(parseInt(msgDbId, 10));
      if (!msgData) {
        await interaction.reply({ content: '❌ メッセージが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const roles = interaction.guild.roles.cache
        .filter((r) => !r.managed && r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .first(25);

      if (roles.size === 0) {
        await interaction.reply({ content: '❌ 設定可能なロールが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const options = roles.map((r) =>
        new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(`${msgDbId}::${emoji}::${r.id}`)
      );

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('rrset_step3')
        .setPlaceholder('付与するロールを選択してください')
        .addOptions(options);

      await interaction.reply({
        content: `🎭 **${emoji}** に紐づけるロールを選択してください:`,
        components: [new ActionRowBuilder().addComponents(selectMenu)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'rrset_step3') {
      const [msgDbId, emoji, roleId] = interaction.values[0].split('::');
      const msgData = db.getReactionRoleMessageById(parseInt(msgDbId, 10));
      if (!msgData) {
        await interaction.reply({ content: '❌ メッセージが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      db.setReactionRoleMapping(guildId, msgData.message_id, emoji, roleId);

      await interaction.reply({
        content: `✅ **${emoji}** → <@&${roleId}> の設定が完了しました。\n他のリアクションを設定する場合は /リアクションロールセット を再度実行してください。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;

    if (SHARED_APP_MODE && COMMUNITY_BLOCKED_COMMANDS_IN_SHARED_MODE.has(commandName)) {
      return;
    }

    if (commandName === 'vc転送') {
      const parentVc = interaction.options.getChannel('親vc');
      const baseName = interaction.options.getString('vcベース名');
      const category = interaction.options.getChannel('作成先カテゴリ');
      const logChannel = interaction.options.getChannel('ログチャンネル');
      const visibleRoleIds = collectRoleOptionIds(interaction, '閲覧ロール', 5);
      const connectRoleIds = collectRoleOptionIds(interaction, '参加ロール', 5);
      const permissionRole = interaction.options.getRole('権限ロール');
      const lockRole = interaction.options.getRole('ロックロール');
      const unlockRole = interaction.options.getRole('解除ロール');
      const hideRole = interaction.options.getRole('非表示ロール');
      const showRole = interaction.options.getRole('表示ロール');
      const deleteRole = interaction.options.getRole('削除ロール');

      db.setVcTransfer(guild.id, parentVc.id, baseName, category.id, {
        logChannelId: logChannel?.id,
        visibleRoleIds,
        connectRoleIds,
        permissionRoleId: permissionRole?.id,
        lockRoleId: lockRole?.id,
        unlockRoleId: unlockRole?.id,
        hideRoleId: hideRole?.id,
        showRoleId: showRole?.id,
        deleteRoleId: deleteRole?.id,
      });
      await interaction.reply({
        content: [
          '✅ VC転送設定を保存しました。',
          `親VC: <#${parentVc.id}>`,
          `ベース名: **${baseName}**`,
          `作成先カテゴリ: **${category.name}**`,
          `転送ログ: ${logChannel ? `<#${logChannel.id}>` : '未設定（ログなし）'}`,
          `閲覧ロール: ${formatRoleMentions(visibleRoleIds)}`,
          `参加ロール: ${formatRoleMentions(connectRoleIds)}`,
          `権限ロール: ${permissionRole ? `<@&${permissionRole.id}>` : '未設定'}`,
          `ロックロール: ${lockRole ? `<@&${lockRole.id}>` : '未設定'}`,
          `解除ロール: ${unlockRole ? `<@&${unlockRole.id}>` : '未設定'}`,
          `非表示ロール: ${hideRole ? `<@&${hideRole.id}>` : '未設定'}`,
          `表示ロール: ${showRole ? `<@&${showRole.id}>` : '未設定'}`,
          `削除ロール: ${deleteRole ? `<@&${deleteRole.id}>` : '未設定'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'vcパネル') {
      await interaction.channel.send({
        embeds: [buildVcControlPanelEmbed()],
        components: buildVcControlPanelRows(),
      });

      await interaction.reply({
        content: '✅ VC設定パネルを公開しました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'チケットパネル') {
      const title = interaction.options.getString('タイトル');
      const description = interaction.options.getString('説明');
      const label = interaction.options.getString('ラベル');
      const emoji = resolveGuildEmoji(guild, interaction.options.getString('絵文字'));
      if (interaction.options.getString('絵文字') && !emoji) {
        await interaction.reply({ content: '❌ サーバーに登録された絵文字の名前、または絵文字コードを指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      const category = interaction.options.getChannel('作成先カテゴリ');
      const logChannel = interaction.options.getChannel('保存先チャンネル');
      const autoMsg = interaction.options.getString('自動送信メッセージ');
      const role1 = interaction.options.getRole('ロール1');
      const role2 = interaction.options.getRole('ロール2');
      const role3 = interaction.options.getRole('ロール3');

      const panelId = db.createTicketPanel(
        guild.id,
        title,
        description,
        label,
        category.id,
        logChannel.id,
        autoMsg,
        emoji,
        role1?.id,
        role2?.id,
        role3?.id
      );

      const panelEmbed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(parseNewlines(description))
        .setColor(0x5865f2)
        .setFooter({ text: 'ボタンを押してチケットを作成してください' });

      const openButton = new ButtonBuilder()
        .setCustomId(`ticket_open_${panelId}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(emoji || '🎫');

      await interaction.reply({ content: '✅ チケットパネルを設置しました。', flags: MessageFlags.Ephemeral });
      const panelMsg = await interaction.channel.send({
        embeds: [panelEmbed],
        components: [new ActionRowBuilder().addComponents(openButton)],
      });

      db.updateTicketPanelLocation(panelId, interaction.channel.id, panelMsg.id);
      return;
    }

    if (commandName === 'チケットパネル削除') {
      const panelId = interaction.options.getInteger('パネルid', true);
      const panel = db.getTicketPanel(panelId);
      if (!panel || panel.guild_id !== guild.id) {
        await interaction.reply({ content: `❌ チケットパネル ${panelId} は存在しません。`, flags: MessageFlags.Ephemeral });
        return;
      }

      let panelMessageDeleted = false;
      if (panel.channel_id && panel.message_id) {
        const panelChannel = guild.channels.cache.get(panel.channel_id);
        if (isTextBasedChannel(panelChannel)) {
          const panelMessage = await panelChannel.messages.fetch(panel.message_id).catch(() => null);
          if (panelMessage) {
            await panelMessage.delete().catch(() => null);
            panelMessageDeleted = true;
          }
        }
      }

      db.deleteTicketPanel(guild.id, panelId);
      await interaction.reply({
        content: [
          '✅ チケットパネルを削除しました。',
          `パネルID: ${panelId}`,
          `パネルメッセージ削除: ${panelMessageDeleted ? '成功' : '未削除（既に削除済み/取得不可）'}`,
          '既存のチケットチャンネルはそのままです。',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'お問い合わせ設定') {
      const itemKey = interaction.options.getString('受付id', true).trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,30}$/.test(itemKey)) {
        await interaction.reply({ content: '❌ 受付IDは英数字・`_`・`-` のみで1〜30文字にしてください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const itemName = interaction.options.getString('受付名', true).trim();
      const itemDescription = interaction.options.getString('説明', true).trim();
      const category = interaction.options.getChannel('作成先カテゴリ', true);
      const logChannel = interaction.options.getChannel('保存先チャンネル', true);
      const autoMessage = interaction.options.getString('自動送信メッセージ', true).trim();
      const rawEmoji = interaction.options.getString('絵文字');
      const emoji = resolveGuildEmoji(guild, rawEmoji);
      if (rawEmoji && !emoji) {
        await interaction.reply({ content: '❌ サーバーに登録された絵文字の名前、または絵文字コードを指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      const role1 = interaction.options.getRole('ロール1');
      const role2 = interaction.options.getRole('ロール2');
      const role3 = interaction.options.getRole('ロール3');

      db.upsertInquiryForumItem(
        guild.id,
        itemKey,
        category.id,
        itemName,
        itemDescription,
        emoji,
        logChannel.id,
        autoMessage,
        role1?.id,
        role2?.id,
        role3?.id
      );

      await interaction.reply({
        content: [
          `✅ お問い合わせ受付 **${itemKey}** を保存しました。`,
          `表示名: **${itemName}**`,
          `作成先カテゴリ: <#${category.id}>`,
          `保存先チャンネル: <#${logChannel.id}>`,
          `絵文字: ${emoji || '未設定'}`,
          `自動送信文: ${autoMessage.slice(0, 100)}`,
          `サポートロール: ${formatRoleMentions([role1?.id, role2?.id, role3?.id].filter(Boolean))}`,
          '設定後に /お問い合わせフォーラムパネル設置 を実行してください。',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'お問い合わせ設定削除') {
      const itemKey = interaction.options.getString('受付id', true).trim().toLowerCase();
      const deleted = db.deleteInquiryForumItem(guild.id, itemKey);
      await interaction.reply({
        content: deleted > 0
          ? `✅ お問い合わせ受付 **${itemKey}** の設定を削除しました。既存のチャンネルは削除されません。`
          : `❌ お問い合わせ受付 **${itemKey}** の設定が見つかりません。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'お問い合わせフォーラムパネル設置') {
      const items = db.getInquiryForumItems(guild.id);
      if (items.length === 0) {
        await interaction.reply({ content: '❌ 受付設定がありません。先に /お問い合わせ設定 を実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const panelChannel = interaction.options.getChannel('チャンネル') || interaction.channel;
      if (!panelChannel?.isTextBased?.()) {
        await interaction.reply({ content: '❌ パネルの設置先にはテキストチャンネルを指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const currentSettings = db.getInquiryForumSettings(guild.id);
      const title = interaction.options.getString('タイトル')?.trim() || currentSettings?.panel_title || 'お問い合わせ窓口';
      const description = interaction.options.getString('説明') || currentSettings?.panel_description || 'お問い合わせ内容に合う受付を選択してください。';
      const selectMenu = buildInquiryForumSelect(items);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelMessage = await panelChannel.send({
        embeds: [buildInquiryForumPanelEmbed(title, description, items)],
        components: [new ActionRowBuilder().addComponents(selectMenu)],
      });
      db.setInquiryForumPanel(guild.id, panelChannel.id, panelMessage.id, title, description);

      await interaction.editReply({ content: `✅ お問い合わせフォーラムパネルを <#${panelChannel.id}> に設置しました。` });
      return;
    }

    if (commandName === 'リアクションロールメッセージ') {
      const msgText = interaction.options.getString('メッセージ');
      const reactionsRaw = interaction.options.getString('リアクション');
      const emojis = reactionsRaw.split(',').map((e) => e.trim()).filter(Boolean);

      if (emojis.length === 0) {
        await interaction.reply({ content: '❌ リアクションを1つ以上指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const msgEmbed = new EmbedBuilder()
        .setDescription(parseNewlines(msgText))
        .setColor(0x5865f2);

      await interaction.reply({ content: '✅ リアクションロールメッセージを送信しました。', flags: MessageFlags.Ephemeral });
      const sentMsg = await interaction.channel.send({ embeds: [msgEmbed] });

      db.createReactionRoleMessage(guild.id, interaction.channel.id, sentMsg.id, msgText.slice(0, 100));

      for (const emoji of emojis) {
        await sentMsg.react(emoji).catch((err) => console.error(`リアクション追加エラー(${emoji}):`, err));
      }
      return;
    }

    if (commandName === 'リアクションロールセット') {
      const messages = db.getAllReactionRoleMessages(guild.id);
      if (messages.length === 0) {
        await interaction.reply({
          content: '❌ このサーバーにリアクションロールメッセージがありません。\n先に /リアクションロールメッセージ を実行してください。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const options = messages.slice(0, 25).map((m) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(m.content.slice(0, 100) || `メッセージ ID: ${m.id}`)
          .setValue(String(m.id))
      );

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('rrset_step1')
        .setPlaceholder('設定するメッセージを選択してください')
        .addOptions(options);

      await interaction.reply({
        content: '🎭 リアクションロールを設定するメッセージを選択してください:',
        components: [new ActionRowBuilder().addComponents(selectMenu)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '固定メッセージ') {
      const title = interaction.options.getString('タイトル');
      const descriptionRaw = interaction.options.getString('説明');
      const description = parseNewlines(descriptionRaw);

      const existing = db.getPinnedMessage(guildId, interaction.channelId);
      if (existing) {
        const oldMsg = await interaction.channel.messages.fetch(existing.message_id).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0x5865f2);

      repinningChannels.add(interaction.channelId);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const sent = await interaction.channel.send({ embeds: [embed] });
        db.setPinnedMessage(guildId, interaction.channelId, sent.id, title, descriptionRaw);
      } finally {
        repinningChannels.delete(interaction.channelId);
      }

      await interaction.editReply({ content: '✅ 固定メッセージを設置しました。' });
      return;
    }

    if (commandName === 'nuke') {
      const mode = interaction.options.getString('モード');
      const channel = interaction.channel;

      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      if (!perms.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ ボットに チャンネルの管理 権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      if (mode === 'recreate') {
        await interaction.reply({ content: '♻️ チャンネルを再作成しています...', flags: MessageFlags.Ephemeral });
        const position = channel.position;
        const clone = await channel.clone();
        await channel.delete();
        await clone.setPosition(position).catch(() => {});
        await clone.send({ content: '♻️ このチャンネルが再作成されました。' });
        return;
      }

      if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) {
        await interaction.reply({ content: '❌ ボットに メッセージ履歴を読む 権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let total = 0;
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.size === 0) break;

        const recent = messages.filter((m) => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
        const old = messages.filter((m) => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);

        if (recent.size >= 2) {
          const deleted = await channel.bulkDelete(recent);
          total += deleted.size;
        } else if (recent.size === 1) {
          await recent.first().delete().catch(() => {});
          total++;
        }

        for (const msg of old.values()) {
          await msg.delete().catch(() => {});
          total++;
        }

        if (messages.size < 100) break;
      }

      await interaction.editReply({ content: `✅ **${total}件**のメッセージを削除しました。` });
      return;
    }

    if (commandName === '入室ログ') {
      const logChannel = interaction.options.getChannel('チャンネル');
      db.setJoinLogChannel(guild.id, logChannel.id);
      await interaction.reply({ content: `✅ 入室ログチャンネルを <#${logChannel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '退出ログ') {
      const logChannel = interaction.options.getChannel('チャンネル');
      db.setLeaveLogChannel(guild.id, logChannel.id);
      await interaction.reply({ content: `✅ 退出ログチャンネルを <#${logChannel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'ログフォーラム') {
      const forum = interaction.options.getChannel('フォーラム', true);
      db.setAllLogChannel(guild.id, forum.id);
      await sendAuditLog(guild, 'システム', new EmbedBuilder()
        .setTitle('✅ ログフォーラムのテスト投稿')
        .setDescription('この投稿が表示されていれば、各種ログの保存先設定は正常です。')
        .setColor(0x57f287)
        .addFields(
          { name: '設定者', value: `<@${interaction.user.id}>`, inline: true },
          { name: '保存先', value: `<#${forum.id}>`, inline: true },
        )
        .setTimestamp());
      await interaction.reply({ content: `✅ 各種ログの保存先を <#${forum.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'status') {
      const me = interaction.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ ボットに チャンネルの管理 権限が必要です。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await renderStatusBoard(guild, { createIfMissing: true, syncMembers: true });
      await interaction.editReply({ content: '✅ status表示を作成/更新しました。' });
      return;
    }

    if (commandName === 'bot送信') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const rawLink = interaction.options.getString('メッセージリンク');
      const linkData = extractMessageLink(rawLink);
      if (!linkData) {
        await interaction.reply({ content: '❌ 有効なDiscordメッセージリンクを指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const resolved = await resolveLinkedMessage(linkData);
      if (!resolved) {
        await interaction.reply({ content: '❌ リンク先メッセージを取得できませんでした。閲覧権限やリンクを確認してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const text = buildLinkedMessageText(resolved.message);
      if (!text) {
        await interaction.reply({ content: '❌ リンク先メッセージに送信できる本文がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.channel.send({ content: text });
      await interaction.reply({ content: '✅ リンク先メッセージの本文を送信しました。', flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'メッセージリンク表示') {
      const state = interaction.options.getString('状態');
      const enabled = state === 'on';

      db.setMessageLinkPreviewEnabled(guild.id, enabled);

      await interaction.reply({
        content: `✅ メッセージリンク自動表示を **${enabled ? 'オン' : 'オフ'}** にしました。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'コマンド一覧') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは管理者または開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 コマンド一覧')
        .setColor(0x5865f2)
        .setDescription('現在有効なコマンド一覧です。')
        .addFields(
          { name: '🔊 VC転送', value: '/vc転送 親VC VCベース名 作成先カテゴリ [ログチャンネル・権限ロール]' },
          { name: '🎛 VC設定パネル', value: '/vcパネル — 公開パネルを現在のチャンネルに設置します' },
          { name: '🎫 チケット', value: '/チケットパネル タイトル 説明 ラベル 作成先カテゴリ 保存先チャンネル 自動送信メッセージ [絵文字・ロール1-3]\n/チケットパネル削除 パネルID' },
          { name: '📩 お問い合わせフォーラム', value: '/お問い合わせ設定 受付id 受付名 説明 作成先カテゴリ 保存先チャンネル 自動送信メッセージ [絵文字・ロール1-3]\n/お問い合わせ設定削除 受付id\n/お問い合わせフォーラムパネル設置 [チャンネル・タイトル・説明]' },
          { name: '🎭 リアクションロール', value: '/リアクションロールメッセージ メッセージ リアクション\n/リアクションロールセット' },
          { name: '📌 固定メッセージ', value: '/固定メッセージ タイトル 説明' },
          { name: '💣 チャンネルリセット', value: '/nuke モード(recreate|purge)' },
          { name: '📊 status表示', value: '/status — statusカテゴリの統計チャンネルを作成/更新します（以後は自動更新）' },
          { name: '🔁 メッセージ転送', value: '/bot送信 メッセージリンク — 指定リンク先の本文をBOTが送信します' },
          { name: '💬 メッセージリンク自動表示', value: '/メッセージリンク表示 状態(on|off)' },
          { name: '📥📤 参加退出ログ', value: '/入室ログ チャンネル\n/退出ログ チャンネル' },
          { name: '🧾 各種監査ログ', value: '/ログフォーラム フォーラム' },
          { name: '🛠 管理・開発者', value: '/コマンド一覧\n/community設定状況 表示\n/economy設定状況 表示\n/security設定状況 表示\n/bot情報 表示' }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (commandName === 'bot情報') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const visibility = interaction.options.getString('表示');
      const ephemeral = visibility === 'hidden';
      await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });

      const guilds = client.guilds.cache;
      const embeds = [];

      for (const [, g] of guilds) {
        const inviteUrl = await getGuildInvite(g);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .addFields(
            { name: 'サーバー名', value: g.name },
            { name: 'サーバーID', value: g.id },
            { name: '招待リンク', value: inviteUrl }
          );
        embeds.push(embed);

        if (embeds.length === 10) {
          await interaction.followUp({ embeds, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
          embeds.length = 0;
        }
      }

      const headerEmbed = new EmbedBuilder()
        .setTitle('🤖 BOT参加サーバー一覧')
        .setColor(0x5865f2)
        .setDescription(`合計 **${guilds.size}** サーバーに参加中`)
        .setTimestamp();

      if (embeds.length > 0) {
        await interaction.editReply({ embeds: [headerEmbed, ...embeds] });
      } else {
        await interaction.editReply({ embeds: [headerEmbed] });
      }
      return;
    }
  } catch (error) {
    console.error('インタラクションエラー:', error);
    const reply = { content: '❌ 処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral };

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChatInputCommand()) {
        await interaction.reply(reply);
      }
    } catch (_) {}
  }
});

process.stdout.write('[STARTUP] TOKEN=' + (TOKEN ? 'OK' : 'MISSING') + ' CLIENT_ID=' + (CLIENT_ID || 'MISSING') + ' DEV=' + (DEVELOPER_ID || 'MISSING') + '\n');

process.on('SIGTERM', async () => {
  process.stdout.write('[SHUTDOWN] Received SIGTERM - process is being terminated by host\n');
  if (typeof global.__UNIFIED_PRE_SHUTDOWN_SYNC__ === 'function') {
    await global.__UNIFIED_PRE_SHUTDOWN_SYNC__('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  process.stdout.write('[SHUTDOWN] Received SIGINT\n');
  if (typeof global.__UNIFIED_PRE_SHUTDOWN_SYNC__ === 'function') {
    await global.__UNIFIED_PRE_SHUTDOWN_SYNC__('SIGINT');
  }
  process.exit(0);
});

const loginTimeout = setTimeout(() => {
  process.stdout.write('[ERROR] Login timed out after 30 seconds - possible network issue with Discord gateway\n');
  process.exit(1);
}, 30000);

process.stdout.write('[STARTUP] Calling client.login()...\n');

client.login(TOKEN).then(() => {
  clearTimeout(loginTimeout);
  process.stdout.write('[STARTUP] Login OK - bot is online\n');
}).catch((err) => {
  clearTimeout(loginTimeout);
  process.stdout.write('[LOGIN ERROR] ' + err.message + '\n');
  process.exit(1);
});
