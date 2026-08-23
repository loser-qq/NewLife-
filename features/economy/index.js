try {
  require('dotenv').config();
} catch (_) {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');

  if (fs.existsSync(envPath)) {
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
}

const fs = require('fs');
const path = require('path');

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
  ActionRowBuilder,
  ButtonBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require('discord.js');

const db = require('./database.js');

function requireCommunityDb() {
  try {
    return require('../community/database.js');
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    return require('./features/community/database.js');
  }
}

const communityDb = requireCommunityDb();

function requireGachaModule(moduleName) {
  const candidatePaths = [
    path.join(__dirname, 'data', moduleName),
    path.join(__dirname, 'features', 'economy', 'data', moduleName),
    path.join(process.cwd(), 'features', 'economy', 'data', moduleName),
    path.join(process.cwd(), 'data', moduleName),
    path.join(__dirname, moduleName),
    path.join(process.cwd(), moduleName),
  ];

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      return require(filePath);
    }
  }

  throw new Error(`gacha module not found: ${moduleName}`);
}

const { gachaCommandBuilders, isGachaCommandName, handleGachaCommand } = requireGachaModule('gacha.js');
const { handleGachaButtonInteraction } = requireGachaModule('gachaButtons.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN || process.env.UNIFIED_DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.UNIFIED_CLIENT_ID;
const DEVELOPER_ID = process.env.DEVELOPER_ID || process.env.UNIFIED_DEVELOPER_ID;

if (!TOKEN || !CLIENT_ID) {
  process.stdout.write('[STARTUP] DISCORD_TOKEN or CLIENT_ID is missing\n');
}

function getUnit(guildId) {
  const settings = db.getSettings(guildId);
  return settings.currency_unit || 'コイン';
}

function parseNewlines(text) {
  return String(text).replace(/\\/g, '\n');
}

function normalizeVendingPanelKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidVendingPanelKey(value) {
  return /^[a-z0-9_-]{1,20}$/.test(value);
}

function hasPermittedRole(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const permittedRoles = db.getPermittedRoles(guildId);
  return permittedRoles.some(roleId => member.roles.cache.has(roleId));
}

function hasCurrencySupportRole(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const supportRoles = db.getCurrencySupportRoles(guildId);
  return supportRoles.some(roleId => member.roles.cache.has(roleId));
}

function isTextBasedChannel(channel) {
  return channel && typeof channel.isTextBased === 'function' && channel.isTextBased();
}

async function sendToConfiguredChannel(guild, channelId, payload) {
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!isTextBasedChannel(channel)) return;
  await channel.send(payload);
}

async function ensureForumLogThread(guild, channel, threadName) {
  if (!channel || channel.type !== ChannelType.GuildForum) return;

  await channel.threads.fetch().catch(() => null);
  const safeThreadName = String(threadName || 'ログ').slice(0, 100);
  const dividerMessage = '------';

  const existingThread = channel.threads.cache.find(t => t.name === safeThreadName);
  if (existingThread) return existingThread;

  const createdThread = await channel.threads.create({
    name: safeThreadName,
    message: { content: dividerMessage },
  }).catch(() => null);

  if (createdThread) {
    await createdThread.send({ content: `以後の${safeThreadName}はこのチャンネルに送信します。` }).catch(() => null);
  }

  return createdThread;
}

async function sendLogToChannelOrForum(guild, channelId, payload, threadName) {
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  if (channel.type === ChannelType.GuildForum) {
    const thread = await ensureForumLogThread(guild, channel, threadName);
    if (!thread) return;
    await thread.send(payload).catch(() => null);
    return;
  }
  if (isTextBasedChannel(channel)) {
    await channel.send(payload).catch(() => null);
  }
}

async function getGuildInvite(guild) {
  try {
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me) return '招待リンクを作成できません';

    const channel = guild.channels.cache.find(ch => {
      if (!isTextBasedChannel(ch)) return false;
      const perms = ch.permissionsFor(me);
      return perms?.has(PermissionFlagsBits.CreateInstantInvite);
    });

    if (!channel) return '招待リンクを作成できません';

    const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: false });
    return `https://discord.gg/${invite.code}`;
  } catch (_) {
    return '招待リンクを作成できません';
  }
}

function buildCommandListEmbed() {
  return new EmbedBuilder()
    .setTitle('📋 コマンド一覧')
    .setColor(0x5865f2)
    .setDescription('このBOTで使えるコマンドの一覧です。`[管理者]` は管理者権限が必要、`[開発者]` は開発者専用です。')
    .addFields(
      {
        name: '🎙 コミュニティ — VC・チケット・ロール',
        value: [
          '`/vc転送 親vc vcベース名 作成先カテゴリ [ロール...]` [管理者] 親VC参加者を子VCに自動転送',
          '`/vcパネル` [管理者] 公開のVC設定パネルを設置',
          '`/チケットパネル タイトル 説明 ラベル 作成先カテゴリ 保存先チャンネル 自動送信メッセージ [ロール1-3]` [管理者] チケットパネルを設置',
          '`/チケットパネル削除 パネルID` [管理者] チケットパネルを削除',
          '`/お問い合わせ設定 受付id 受付名 説明 作成先カテゴリ 保存先チャンネル 自動送信メッセージ [ロール1-3]` [管理者] お問い合わせ受付を設定',
          '`/お問い合わせ設定削除 受付id` [管理者] お問い合わせ受付の設定を削除',
          '`/お問い合わせフォーラムパネル設置 [#チャンネル] [タイトル] [説明]` [管理者] お問い合わせ受付パネルを設置',
          '`/リアクションロールメッセージ メッセージ リアクション` [管理者] リアクションロール用メッセージを送信',
          '`/リアクションロールセット` [管理者] リアクションロールのロールを設定',
          '`/固定メッセージ タイトル 説明` [管理者] チャンネルに常時最新で表示されるEmbedを設置',
          '`/nuke モード(recreate|purge)` [管理者] チャンネルをリセット',
          '`/入室ログ #チャンネル` [管理者] 参加通知チャンネルを設定',
          '`/退出ログ #チャンネル` [管理者] 退出通知チャンネルを設定',
          '`/ログフォーラム #フォーラム` [管理者] 各種ログをまとめて記録するフォーラムを設定',
          '`/status` [管理者] statusカテゴリの統計チャンネルを作成/更新',
          '`/メッセージリンク表示 状態(on|off)` [管理者] メッセージリンク自動表示を切替',
          '`/bot送信 メッセージリンク` [開発者] メッセージリンク先の本文をBOTが送信',
        ].join('\n'),
      },
      {
        name: '💰 経済 — 通貨・送金',
        value: [
          '`/bankパネル設置 #チャンネル [タイトル] [説明]` [管理者] 送金・残高確認パネルを設置',
          '`/送金可能ロール設定 [ロール1-10]` [管理者] bankパネルの送金先ロールを設定（未指定で解除）',
          '`/付与 @ユーザー 金額` [管理者] 通貨を付与',
          '`/減額 @ユーザー 金額` [管理者] 通貨を減額',
          '`/通貨サポートロール設定 @ロール` [管理者] 付与・減額を許可するロールを設定',
          '`/通貨単位設定 単位` [管理者] 通貨単位を変更',
          '`/商品購入 金額 商品名` チケット内で商品を購入し、購入ログを送信',
          '`/商品購入設定 お問い合わせ 受付id ログチャンネル 使用可能` [管理者] 受付ごとの購入設定',
          '`/商品購入設定 チケット パネルid ログチャンネル 使用可能` [管理者] チケットごとの購入設定',
          '`/送金ログチャンネル #チャンネル` [管理者] bankパネルの送金ログ送信先を設定',
          '`/付与ログチャンネル #チャンネル` [管理者] 付与ログ送信先を設定',
          '`/減額ログチャンネル #チャンネル` [管理者] 減額ログ送信先を設定',
        ].join('\n'),
      },
      {
        name: '🛒 自販機',
        value: [
          '`/自販機パネル設置 パネルID #チャンネル タイトル 説明` [管理者] 購入ボタン付き自販機パネルを設置',
          '`/自販機パネル削除 パネルID` [管理者] 自販機パネルを削除',
          '`/自販機商品設定 設定 パネルID スロット 商品名 ロール 値段 時間(分)` [管理者] 商品を設定/更新',
          '`/自販機商品設定 削除 パネルID スロット` [管理者] 商品を削除',
          '`/自販機商品設定 一覧 パネルID [表示]` [管理者] 商品一覧を表示',
          '`/自販機ログチャンネル パネルID #チャンネル` [管理者] 購入ログ送信先を設定',
          '`/vc自販機パネル設置 パネルID #チャンネル タイトル 説明` [管理者] VC公開/非公開の購入パネルを設置',
          '`/vc自販機パネル削除 パネルID` [管理者] VC自販機パネルを削除',
          '`/vc自販機商品設定 設定 パネルID スロット 商品名 カテゴリ 公開ロール[2-5] 参加人数 公開設定 値段 延長料金 延長時間 時間(分)` [管理者] 商品を設定/更新',
          '`/vc自販機商品設定 削除 パネルID スロット` [管理者] 商品を削除',
          '`/vc自販機商品設定 一覧 パネルID [表示]` [管理者] 商品一覧を表示',
          '`/vc自販機ログチャンネル パネルID #チャンネル` [管理者] 購入ログ送信先を設定',
        ].join('\n'),
      },
      {
        name: '🎤 面接通過ワークフロー',
        value: [
          '`/面接通過許可ロール @ロール` [管理者] /面接通過 の実行権限ロールを設定',
          '`/面接設定 @外すロール @付与するロール 付与金額` [管理者] 面接処理内容を設定',
          '`/面接通過` VC参加者に一括処理を実行（許可ロール必要）',
          '`/面接通過ログチャンネル #チャンネル` [管理者] 面接通過ログ送信先を設定',
        ].join('\n'),
      },
      {
        name: '⭐ 評価関連',
        value: [
          '`/評価期限設定 日数 対象ロール` [管理者] 評価期限日数と対象ロールを設定',
          '`/評価フォーラム設定 #フォーラム` [管理者] モデレーター用の評価投稿先フォーラムを設定',
          '`/評価スレッド許可ロール設定 @ロール1 [@ロール2-5]` [管理者] 評価スレッドを作成できるロールを設定',
          '`/評価スレッド作成 @対象者` [設定済み許可ロール] 面接通過済みユーザーの評価スレッドを作成',
          '`/ロール表示除外設定 [表示ロール1-3]` [管理者] 対象外メンバーへの表示ロールを設定（未指定で解除）',
          '`/評価リセット [ユーザー]` [開発者] 評価情報をリセット（未指定で全員）',
          '`/評価一覧 [表示]` [開発者] 評価情報の一覧を表示',
        ].join('\n'),
      },
      {
        name: '📈 VCレベリング',
        value: [
          '`/レベリングログチャンネル #チャンネル` [管理者] レベルアップログ送信先を設定',
          '`/レベリング場所 場所1〜5` [管理者] レベリング対象のVCを最大5か所設定',
          '`/レベリング設定 時間設定 レベル 必要分` [管理者] レベルごとの必要VC参加時間を設定',
          '`/レベリング設定 時間一括設定 開始レベル 必要分` [管理者] 10レベル分まとめて設定',
          '`/レベリング設定 ロール設定 開始レベル 終了レベル ロール` [管理者] レベル範囲対応ロールを設定',
          '`/ロールvc時間設定 ロール 場所1〜5` [管理者] ロールごとのVC時間計測対象を設定',
          '`/ロールvc期間設定 ロール 日数` [管理者] 直近日数で集計（0で累計）',
          '`/ロールvc報酬設定 ロール 必要分 金額 [ログチャンネル]` [管理者] VC時間達成時の通貨報酬を設定',
          '`/ロールvc報酬削除 報酬ID` [管理者] ロール別VC時間の報酬設定を削除',
          '`/ロールvc時間 ユーザー ロール [表示]` ロール別のVC参加時間を確認',
          '`/ロールvc時間ランキング ロール [表示]` ロール別のVC参加時間TOP10を表示',
          '`/自分 [表示]` 自分の残高とVCレベルを確認',
          '`/vc接続時間ランキング [表示]` [管理者] VC接続時間TOP10を表示',
          '`/ユーザー情報 ユーザー [表示]` [開発者] 指定ユーザーの情報を確認',
        ].join('\n'),
      },
      {
        name: '🎰 ガチャ',
        value: [
          '`/ガチャ作成` [管理者] 箱ガチャを作成・価格設定',
          '`/商品追加` [管理者] 商品名・数量・レアリティを登録',
          '`/商品削除` [管理者] 商品を削除',
          '`/商品一覧` [管理者] 商品一覧を表示',
          '`/ガチャ設置` [管理者] 4ボタン付きガチャパネルを設置',
          '`/ガチャパネル削除 ガチャID` [管理者] ガチャパネルを削除',
          '`/ガチャ情報` [管理者] ガチャ設定を表示',
          '`/提供割合` [管理者] 残数から割合を表示',
          '`/ガチャログ #チャンネル` [管理者] 抽選ログ送信先を設定',
          '`/次の商品` [管理者] 次回抽選の商品を固定',
          '`/ガチャリセット` [管理者] 在庫を初期値に戻す',
        ].join('\n'),
      },
      {
        name: '💼 給与',
        value: [
          '`/給与設定 ロール 金額` [管理者] ロールごとの給与を設定',
          '`/給与設定解除 ロール` [管理者] ロール給与設定を解除',
          '`/給与設定一覧 [表示]` [管理者] ロール給与設定の一覧を表示',
          '`/給与一括付与 ロール` [管理者] 指定ロールのメンバーへ給与を一括付与',
          '`/給与全ロール一括付与` [管理者] 設定済みロールすべてに一括付与',
        ].join('\n'),
      },
      {
        name: '🛡 セキュリティ',
        value: [
          '`/モデレーションログ設定 #チャンネル` [管理者] モデレーションログチャンネルを設定',
          '`/招待ログ設定 #チャンネル` [管理者] 招待ログチャンネルを設定',
          '`/タイムアウト設定 分` [管理者] タイムアウト時間を設定',
          '`/スパム設定 回数 時間(ms)` [管理者] スパム検知のしきい値を設定',
          '`/レイド設定 回数 時間(ms)` [管理者] レイド検知のしきい値を設定',
          '`/外部アプリ制限 モード(on|off)` [管理者] 外部アプリの利用制限を切替',
          '`/対策切替 対象 モード(on|off)` [管理者] スパム・レイド・画像判定を個別に切替',
          '`/招待パネル設置 [#チャンネル]` [管理者] 招待リンク発行パネルを設置',
          '`/モデレーター役職設定 @ロール` [管理者] モデレーター役職を設定',
          '`/解除 @ユーザー` [管理者] ユーザーのタイムアウトを解除',
        ].join('\n'),
      },
      {
        name: '🔧 管理・開発者向け',
        value: [
          '`/community設定状況 表示` [管理者] community設定を表示',
          '`/economy設定状況 表示` [管理者] economy設定を表示',
          '`/security設定状況 表示` [管理者] security設定を表示',
          '`/コマンド一覧 表示` [管理者] 利用可能なコマンド一覧を表示',
          '`/bot情報 表示` [開発者] 参加サーバー一覧と招待リンクを表示',
          '`/ボット設定リセット` [開発者] 全機能のボット設定を初期化',
          '`/vc接続時間リセット ユーザー` [開発者] 指定ユーザーのVC接続時間をリセット',
          '`/vc接続時間全リセット` [開発者] 全ユーザーのVC接続時間をリセット',
          '`/残高全額リセット ユーザー` [開発者] 指定ユーザーの残高を0にリセット',
          '`/残高全額全リセット` [開発者] 全ユーザーの残高を0にリセット',
        ].join('\n'),
      },
    )
    .setTimestamp();
}

function buildStatusEmbed(guild) {
  const settings = db.getSettings(guild.id);
  const unit = settings.currency_unit || 'コイン';
  const permittedRoles = db.getPermittedRoles(guild.id);
  const transferLogChannelId = settings.transfer_log_channel_id || settings.log_channel_id;
  const bankPanels = db.getBankPanels(guild.id);
  const bankTransferRoles = db.getBankTransferRoles(guild.id);
  const vendingPanels = db.getVendingPanels(guild.id);
  const totalVendingProducts = vendingPanels.reduce((sum, p) => sum + db.getVendingProducts(guild.id, p.panel_key).length, 0);
  const vendingLogCount = vendingPanels.filter(p => !!p.log_channel_id).length;
  const vcVendingPanels = db.getVcVendingPanels(guild.id);
  const totalVcVendingProducts = vcVendingPanels.reduce((sum, p) => sum + db.getVcVendingProducts(guild.id, p.panel_key).length, 0);
  const vcVendingLogCount = vcVendingPanels.filter(p => !!p.log_channel_id).length;
  const roleVoiceTimeRewards = db.getRoleVoiceTimeRewards(guild.id);
  const roleVoiceTimeRewardSummary = roleVoiceTimeRewards.length > 0
    ? roleVoiceTimeRewards.map((reward) => {
      const periodDays = db.getRoleVoiceTimePeriodDays(guild.id, reward.role_id);
      const logChannel = reward.log_channel_id ? `<#${reward.log_channel_id}>` : '付与ログ';
      return `ID ${reward.id}: <@&${reward.role_id}> / ${formatDuration(reward.required_seconds)}で${Number(reward.reward_amount).toLocaleString()} ${unit} / ${periodDays > 0 ? `直近${periodDays}日` : '累計'} / ${logChannel}`;
    })
    .join('\n').slice(0, 1024)
    : '未設定';

  return new EmbedBuilder()
    .setTitle('⚙️ サーバー設定状況')
    .setColor(0x5865f2)
    .setDescription(`サーバー: **${guild.name}**`)
    .addFields(
      { name: '通貨単位', value: unit, inline: true },
      { name: '送金ログ', value: transferLogChannelId ? `<#${transferLogChannelId}>` : '未設定', inline: true },
      { name: 'bankパネル数', value: `${bankPanels.length}件`, inline: true },
      { name: 'bankパネル設置先', value: bankPanels.length > 0 ? bankPanels.map(p => `<#${p.channel_id}>`).join('\n') : '未設置', inline: false },
      { name: '送金可能ロール', value: bankTransferRoles.length > 0 ? bankTransferRoles.map(id => `<@&${id}>`).join('\n') : '未設定', inline: false },
      { name: '付与ログ', value: settings.grant_log_channel_id ? `<#${settings.grant_log_channel_id}>` : '未設定', inline: true },
      { name: '減額ログ', value: settings.deduction_log_channel_id ? `<#${settings.deduction_log_channel_id}>` : '未設定', inline: true },
      { name: '面接通過ログ', value: settings.interview_log_channel_id ? `<#${settings.interview_log_channel_id}>` : '未設定', inline: true },
      { name: 'レベリングログ', value: settings.leveling_log_channel_id ? `<#${settings.leveling_log_channel_id}>` : '未設定', inline: true },
      { name: 'レベリング時間', value: getLevelingRangeSummary(guild.id), inline: false },
      { name: 'レベリングロール', value: getLevelingRoleSummary(guild.id), inline: false },
      { name: '面接許可ロール', value: permittedRoles.length > 0 ? permittedRoles.map(id => `<@&${id}>`).join('\n') : '未設定', inline: false },
      { name: '通貨サポートロール', value: db.getCurrencySupportRoles(guild.id).length > 0 ? db.getCurrencySupportRoles(guild.id).map(id => `<@&${id}>`).join('\n') : '未設定', inline: false },
      { name: '外すロール', value: settings.remove_role_id ? `<@&${settings.remove_role_id}>` : '未設定', inline: true },
      { name: '付与するロール', value: settings.add_role_id ? `<@&${settings.add_role_id}>` : '未設定', inline: true },
      { name: '付与金額', value: settings.grant_amount != null ? `${Number(settings.grant_amount).toLocaleString()} ${unit}` : '未設定', inline: true },
      { name: '評価期限日数', value: settings.evaluation_days != null ? `${Math.max(0, Number(settings.evaluation_days))}日` : '未設定', inline: true },
      { name: '評価期限対象ロール', value: settings.evaluation_role_id ? `<@&${settings.evaluation_role_id}>` : '未設定', inline: true },
      {
        name: '対象外メンバー表示ロール',
        value: [settings.role_display_include1_id, settings.role_display_include2_id, settings.role_display_include3_id]
          .filter(Boolean)
          .map(id => `<@&${id}>`)
          .join('\n') || '未設定',
        inline: true,
      },
      { name: '自販機', value: `パネル: ${vendingPanels.length}件\n商品: ${totalVendingProducts}件\nログ設定: ${vendingLogCount}件`, inline: true },
      { name: 'VC自販機', value: `パネル: ${vcVendingPanels.length}件\n商品: ${totalVcVendingProducts}件\nログ設定: ${vcVendingLogCount}件`, inline: true },
      { name: 'ロール別VC時間報酬', value: roleVoiceTimeRewardSummary, inline: false },
    )
    .setTimestamp();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function buildBotInfoEmbeds() {
  const guilds = [...client.guilds.cache.values()];
  const embeds = [
    new EmbedBuilder()
      .setTitle('🤖 BOT参加サーバー一覧')
      .setColor(0x5865f2)
      .setDescription(`合計 **${guilds.length}** サーバーに参加中`)
      .setTimestamp(),
  ];

  for (const group of chunkArray(guilds, 20)) {
    const embed = new EmbedBuilder().setColor(0x5865f2);
    for (const guild of group) {
      const invite = await getGuildInvite(guild);
      embed.addFields({
        name: guild.name,
        value: [
          `ID: ${guild.id}`,
          `招待: ${invite}`,
        ].join('\n'),
      });
    }
    embeds.push(embed);
  }

  return embeds;
}

const DEFAULT_LEVEL_UP_SECONDS = 60 * 60;

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (hours === 0 && minutes === 0) parts.push(`${remainingSeconds}秒`);
  return parts.join('') || '0秒';
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function getNextDayStartAtJst(timestamp) {
  const dayMs = 24 * 60 * 60 * 1000;
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const jstTimestamp = timestamp + jstOffsetMs;
  const jstDayStart = Math.floor(jstTimestamp / dayMs) * dayMs;
  return (jstDayStart + dayMs) - jstOffsetMs;
}

function getLevelUpSeconds(guildId, level) {
  const row = db.getLevelingThreshold(guildId, level);
  return row ? row.required_seconds : DEFAULT_LEVEL_UP_SECONDS;
}

function calculateLevelingState(guildId, totalSeconds) {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalSeconds));

  while (true) {
    const requiredSeconds = getLevelUpSeconds(guildId, level);
    if (remaining < requiredSeconds) {
      return {
        level,
        progressSeconds: remaining,
        requiredSeconds,
        remainingToNext: requiredSeconds - remaining,
      };
    }

    remaining -= requiredSeconds;
    level += 1;

    if (level >= 9999) {
      return {
        level,
        progressSeconds: remaining,
        requiredSeconds: getLevelUpSeconds(guildId, level),
        remainingToNext: 0,
      };
    }
  }
}

function getEffectiveLevelingSeconds(userId, guildId, now = Date.now()) {
  const profile = db.getLevelingProfile(userId, guildId);
  const session = db.getActiveLevelingSession(userId, guildId);
  const sessionSeconds = session ? Math.max(0, Math.floor((now - session.joined_at) / 1000)) : 0;
  return profile.total_seconds + sessionSeconds;
}

function getLevelingVoiceChannelId(guildId) {
  return (db.getSettings(guildId).leveling_voice_channel_id || '')
    .split(',')
    .map(channelId => channelId.trim())
    .filter(Boolean);
}

function isLevelingTargetChannel(guildId, channelId) {
  const parentChannelIds = getLevelingVoiceChannelId(guildId);
  if (parentChannelIds.length === 0 || !channelId) return false;
  if (parentChannelIds.includes(channelId)) return true;

  const childVc = communityDb.getChildVc(guildId, channelId);
  return parentChannelIds.includes(childVc?.parent_vc_id);
}

function getLevelingRangeSummary(guildId) {
  const thresholds = db.getLevelingThresholds(guildId);
  if (thresholds.length === 0) {
    return `未設定（既定: ${formatDuration(DEFAULT_LEVEL_UP_SECONDS)}）`;
  }

  const lines = thresholds.slice(0, 10).map(row => `Lv${row.level} → Lv${row.level + 1}: ${formatDuration(row.required_seconds)}`);
  if (thresholds.length > 10) {
    lines.push(`...他 ${thresholds.length - 10} 件`);
  }
  return lines.join('\n');
}

function getLevelingRoleSummary(guildId) {
  const ranges = db.getLevelingRoleRanges(guildId);
  if (ranges.length === 0) {
    return '未設定';
  }

  const lines = ranges.slice(0, 10).map(row => `Lv${row.start_level} - Lv${row.end_level}: <@&${row.role_id}>`);
  if (ranges.length > 10) {
    lines.push(`...他 ${ranges.length - 10} 件`);
  }
  return lines.join('\n');
}

function buildLevelingSettingsEmbed(guild) {
  const levelingVoiceChannelIds = getLevelingVoiceChannelId(guild.id);
  return new EmbedBuilder()
    .setTitle('📈 VCレベリング設定')
    .setColor(0x57f287)
    .addFields(
      { name: 'レベリング対象VC', value: levelingVoiceChannelIds.length > 0 ? levelingVoiceChannelIds.map(channelId => `<#${channelId}>`).join('\n') : '未設定', inline: false },
      { name: 'レベルアップ時間', value: getLevelingRangeSummary(guild.id), inline: false },
      { name: '対応ロール', value: getLevelingRoleSummary(guild.id), inline: false },
      { name: '現在の基準', value: `未設定のレベルは **${formatDuration(DEFAULT_LEVEL_UP_SECONDS)}** で1つ上がります。`, inline: false },
    )
    .setTimestamp();
}

function buildVcConnectionRankingEmbed(guild) {
  const rows = db.getLevelingProfiles(guild.id);
  const unit = getUnit(guild.id);
  const topRows = rows.slice(0, 10);
  const description = topRows.length > 0
    ? topRows.map((row, index) => `${index + 1}. <@${row.user_id}>: ${formatDuration(row.total_seconds)} (${row.last_level}Lv)`).join('\n')
    : 'まだ記録がありません。';

  return new EmbedBuilder()
    .setTitle('🏆 VC接続時間ランキング')
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `表示単位: ${unit}` })
    .setTimestamp();
}

function getRoleVoiceTimePeriod(guildId, roleId, now = Date.now()) {
  const days = db.getRoleVoiceTimePeriodDays(guildId, roleId);
  return {
    days,
    since: days > 0 ? now - (days * 24 * 60 * 60 * 1000) : null,
  };
}

function getEffectiveRoleVoiceTimeSeconds(userId, guildId, roleId, now = Date.now()) {
  const period = getRoleVoiceTimePeriod(guildId, roleId, now);
  const profile = period.since == null
    ? db.getRoleVoiceTimeProfile(userId, guildId, roleId)
    : db.getRoleVoiceTimeProfilesSince(guildId, roleId, period.since).find((row) => row.user_id === userId) || { total_seconds: 0 };
  const session = db.getActiveRoleVoiceTimeSession(userId, guildId, roleId);
  const sessionStartedAt = period.since == null ? session?.joined_at : Math.max(session?.joined_at || 0, period.since);
  const sessionSeconds = session ? Math.max(0, Math.floor((now - sessionStartedAt) / 1000)) : 0;
  return profile.total_seconds + sessionSeconds;
}

function buildRoleVoiceTimeEmbed(guild, targetUser, roleId) {
  const period = getRoleVoiceTimePeriod(guild.id, roleId);
  const totalSeconds = getEffectiveRoleVoiceTimeSeconds(targetUser.id, guild.id, roleId);
  const channels = db.getRoleVoiceTimeChannels(guild.id, roleId);
  return new EmbedBuilder()
    .setTitle('ロール別VC参加時間')
    .setColor(0x5865f2)
    .addFields(
      { name: '対象ユーザー', value: `<@${targetUser.id}>`, inline: true },
      { name: '対象ロール', value: `<@&${roleId}>`, inline: true },
      { name: period.days > 0 ? `直近${period.days}日` : '累計時間', value: formatDuration(totalSeconds), inline: true },
      { name: '計測対象VC', value: channels.length > 0 ? channels.map((channelId) => `<#${channelId}>`).join('\n') : '未設定', inline: false },
    )
    .setTimestamp();
}

function buildRoleVoiceTimeRankingEmbed(guild, roleId) {
  const now = Date.now();
  const period = getRoleVoiceTimePeriod(guild.id, roleId, now);
  const rows = period.since == null
    ? db.getRoleVoiceTimeProfiles(guild.id, roleId)
    : db.getRoleVoiceTimeProfilesSince(guild.id, roleId, period.since);
  const activeSessions = new Map(
    db.getActiveRoleVoiceTimeSessions(guild.id)
      .filter((session) => session.role_id === roleId)
      .map((session) => [session.user_id, session]),
  );
  const userIds = new Set([...rows.map((row) => row.user_id), ...activeSessions.keys()]);
  const ranking = [...userIds]
    .map((userId) => ({ userId, totalSeconds: getEffectiveRoleVoiceTimeSeconds(userId, guild.id, roleId, now) }))
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 10);
  const description = ranking.length > 0
    ? ranking.map((row, index) => `${index + 1}. <@${row.userId}>: ${formatDuration(row.totalSeconds)}`).join('\n')
    : 'まだ記録がありません。';

  return new EmbedBuilder()
    .setTitle('ロール別VC参加時間ランキング')
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `対象ロール: ${guild.roles.cache.get(roleId)?.name || roleId} / 集計期間: ${period.days > 0 ? `直近${period.days}日` : '累計'}` })
    .setTimestamp();
}

function buildLevelingProfileEmbed(targetMember, guild) {
  const now = Date.now();
  const totalSeconds = getEffectiveLevelingSeconds(targetMember.id, guild.id, now);
  const state = calculateLevelingState(guild.id, totalSeconds);
  const range = db.getLevelingRoleRangeForLevel(guild.id, state.level);
  const session = db.getActiveLevelingSession(targetMember.id, guild.id);

  return new EmbedBuilder()
    .setTitle('📈 VCレベリング確認')
    .setColor(0x5865f2)
    .setDescription(`対象: <@${targetMember.id}>`)
    .addFields(
      { name: '現在レベル', value: `Lv${state.level}`, inline: true },
      { name: 'VC参加時間', value: formatDuration(totalSeconds), inline: true },
      { name: '次のレベルまで', value: state.remainingToNext > 0 ? formatDuration(state.remainingToNext) : '到達済み', inline: true },
      { name: '対応ロール', value: range ? `<@&${range.role_id}>` : '未設定', inline: true },
      { name: 'VC参加中', value: session ? 'はい' : 'いいえ', inline: true },
      { name: '次の目標', value: `Lv${state.level + 1}`, inline: true },
    )
    .setFooter({ text: 'レベルはVC参加時間の累積で計算されます。' })
    .setTimestamp();
}

function buildLevelingInfoEmbed(targetMember, guild, options = {}) {
  const now = Date.now();
  const totalSeconds = getEffectiveLevelingSeconds(targetMember.id, guild.id, now);
  const state = calculateLevelingState(guild.id, totalSeconds);
  const range = db.getLevelingRoleRangeForLevel(guild.id, state.level);
  const session = db.getActiveLevelingSession(targetMember.id, guild.id);
  const balance = db.getBalance(targetMember.id, guild.id);
  const unit = getUnit(guild.id);
  const settings = db.getSettings(guild.id);
  const evaluationDays = Math.max(0, Math.floor(Number(settings.evaluation_days || 0)));
  const evaluationRoleId = settings.evaluation_role_id || null;
  const displayIncludeRoleIds = [
    settings.role_display_include1_id,
    settings.role_display_include2_id,
    settings.role_display_include3_id,
  ].filter(Boolean);
  const roleDisplayExcludeId = settings.role_display_exclude_id || evaluationRoleId;
  const hasEvaluationRole = !!evaluationRoleId && targetMember.roles.cache.has(evaluationRoleId);

  const extraFields = [];
  if (hasEvaluationRole) {
    if (evaluationDays <= 0) {
      extraFields.push({ name: '評価期限', value: '未設定（管理者が `/評価期限設定` を実行してください）', inline: false });
    } else {
      const evaluation = db.getInterviewEvaluation(targetMember.id, guild.id);
      if (!evaluation) {
        extraFields.push({ name: '評価期限', value: '面接通過日時が未記録です。', inline: false });
      } else {
        const periodStartAt = getNextDayStartAtJst(evaluation.passed_at);
        const deadlineAt = periodStartAt + (evaluationDays * 24 * 60 * 60 * 1000);
        const remainingMs = deadlineAt - now;
        const remainingText = remainingMs > 0 ? `あと **${formatDuration(Math.floor(remainingMs / 1000))}**` : '期限切れ';
        extraFields.push({
          name: '評価期限',
          value: [
            remainingText,
            `評価開始: ${formatDateTime(periodStartAt)}`,
            `期限日時: ${formatDateTime(deadlineAt)}`,
            `通過日時: ${formatDateTime(evaluation.passed_at)}`,
          ].join('\n'),
          inline: false,
        });
      }
    }
  } else {
    const roleMentions = displayIncludeRoleIds.length > 0
      ? displayIncludeRoleIds.filter(roleId => targetMember.roles.cache.has(roleId)).map(roleId => `<@&${roleId}>`)
      : targetMember.roles.cache
        .filter(role => role.id !== guild.id && role.id !== roleDisplayExcludeId)
        .map(role => `<@&${role.id}>`);
    extraFields.push({ name: 'ロール', value: roleMentions.length > 0 ? roleMentions.join(' ') : 'なし', inline: false });
  }

  const fields = [
    { name: '現在レベル', value: `Lv${state.level}`, inline: true },
    { name: '次のレベルまで', value: state.remainingToNext > 0 ? formatDuration(state.remainingToNext) : '到達済み', inline: true },
    { name: 'VC参加時間', value: formatDuration(totalSeconds), inline: true },
    { name: '対応ロール', value: range ? `<@&${range.role_id}>` : '未設定', inline: true },
    { name: 'VC参加中', value: session ? 'はい' : 'いいえ', inline: true },
    ...extraFields,
  ];

  if (options.showBalance !== false) {
    fields.unshift({ name: '残高', value: `${balance.toLocaleString()} ${unit}`, inline: true });
  }

  return new EmbedBuilder()
    .setTitle('📌 ユーザー情報')
    .setColor(0x5865f2)
    .setDescription(`対象: <@${targetMember.id}>`)
    .addFields(fields)
    .setTimestamp();
}

function buildLevelUpLogEmbed({ targetMember, guild, previousLevel, currentLevel, totalSeconds }) {
  const range = db.getLevelingRoleRangeForLevel(guild.id, currentLevel);
  const state = calculateLevelingState(guild.id, totalSeconds);

  return new EmbedBuilder()
    .setTitle('📈 レベルアップログ')
    .setColor(0x57f287)
    .addFields(
      { name: '対象ユーザー', value: `<@${targetMember.id}>`, inline: true },
      { name: 'レベル', value: `Lv${previousLevel} → Lv${currentLevel}`, inline: true },
      { name: 'VC参加時間', value: formatDuration(totalSeconds), inline: true },
      { name: '対応ロール', value: range ? `<@&${range.role_id}>` : '未設定', inline: true },
      { name: '次のレベルまで', value: state.remainingToNext > 0 ? formatDuration(state.remainingToNext) : '到達済み', inline: true },
    )
    .setTimestamp();
}

function buildRoleSalarySettingsEmbed(guild) {
  const settings = db.getRoleSalarySettings(guild.id);
  const unit = getUnit(guild.id);
  const value = settings.length > 0
    ? settings.map(row => `<@&${row.role_id}>: ${row.amount.toLocaleString()} ${unit}`).join('\n')
    : '未設定';

  return new EmbedBuilder()
    .setTitle('💼 ロール給与設定一覧')
    .setColor(0xfee75c)
    .addFields({ name: '設定', value })
    .setTimestamp();
}

function buildEvaluationListEmbeds(guild, rows) {
  const settings = db.getSettings(guild.id);
  const evaluationDays = Math.max(0, Math.floor(Number(settings.evaluation_days || 0)));
  const now = Date.now();

  if (rows.length === 0) {
    return [
      new EmbedBuilder()
        .setTitle('📋 評価一覧')
        .setColor(0x5865f2)
        .setDescription('評価データはありません。')
        .setTimestamp(),
    ];
  }

  const lines = rows.map(row => {
    if (evaluationDays <= 0) {
      return `<@${row.user_id}> | 通過: ${formatDateTime(row.passed_at)} | 期限日数未設定`;
    }

    const periodStartAt = getNextDayStartAtJst(row.passed_at);
    const deadlineAt = periodStartAt + (evaluationDays * 24 * 60 * 60 * 1000);
    const remainingMs = deadlineAt - now;
    const status = remainingMs > 0 ? `評価中（残り ${formatDuration(Math.floor(remainingMs / 1000))}）` : '期限切れ';

    return [
      `<@${row.user_id}> | ${status}`,
      `通過: ${formatDateTime(row.passed_at)} / 評価開始: ${formatDateTime(periodStartAt)} / 期限: ${formatDateTime(deadlineAt)}`,
    ].join('\n');
  });

  const chunks = chunkArray(lines, 10);
  return chunks.map((chunk, index) => (
    new EmbedBuilder()
      .setTitle(`📋 評価一覧 (${index + 1}/${chunks.length})`)
      .setColor(0x5865f2)
      .setDescription(chunk.join('\n\n'))
      .setTimestamp()
  ));
}

function buildVendingProductsText(guildId, panelKey) {
  const products = db.getVendingProducts(guildId, panelKey);
  const unit = getUnit(guildId);
  if (products.length === 0) {
    return '商品は未設定です。';
  }

  return products.map(p => [
    `**${p.slot}. ${p.label}**`,
    `ロール: <@&${p.role_id}>`,
    `値段: ${p.price.toLocaleString()} ${unit}`,
    `時間: ${p.duration_minutes}分`,
  ].join(' / ')).join('\n');
}

function buildVendingPanelEmbed(guild, panel) {
  return new EmbedBuilder()
    .setTitle(panel.title)
    .setColor(0x2b2d31)
    .setDescription(`${panel.description}\n\n${buildVendingProductsText(guild.id, panel.panel_key)}`)
    .setFooter({ text: 'ボタンを押すと購入します。' })
    .setTimestamp();
}

function buildVendingPanelComponents(guildId, panelKey) {
  const products = db.getVendingProducts(guildId, panelKey);
  if (products.length === 0) {
    return [];
  }

  const buttons = products
    .sort((a, b) => a.slot - b.slot)
    .map(product => (
      new ButtonBuilder()
        .setCustomId(`vending_buy:${panelKey}:${product.slot}`)
        .setLabel(`${product.slot}: ${product.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
    ));

  return [
    new ActionRowBuilder().addComponents(buttons.slice(0, 5)),
  ];
}

function buildVendingProductListEmbed(guild, panelKey) {
  const panel = db.getVendingPanel(guild.id, panelKey);
  return new EmbedBuilder()
    .setTitle(`🛒 自販機商品一覧 (${panelKey})`)
    .setColor(0x5865f2)
    .addFields(
      { name: '商品一覧', value: buildVendingProductsText(guild.id, panelKey), inline: false },
      { name: 'パネル', value: panel && panel.channel_id && panel.message_id ? `<#${panel.channel_id}> / ${panel.message_id}` : '未設置', inline: false },
      { name: '購入ログ', value: db.getVendingLogChannel(guild.id, panelKey) ? `<#${db.getVendingLogChannel(guild.id, panelKey)}>` : '未設定', inline: false },
    )
    .setTimestamp();
}

async function refreshVendingPanel(guild, panelKey) {
  const panel = db.getVendingPanel(guild.id, panelKey);
  if (!panel || !panel.channel_id || !panel.message_id) return;

  const channel = guild.channels.cache.get(panel.channel_id);
  if (!isTextBasedChannel(channel)) return;

  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [buildVendingPanelEmbed(guild, panel)],
    components: buildVendingPanelComponents(guild.id, panel.panel_key),
  });
}

function buildVendingPurchaseLogEmbed({ buyerId, roleId, label, price, durationMinutes, expiresAt, unit }) {
  return new EmbedBuilder()
    .setTitle('🧾 自販機購入ログ')
    .setColor(0x57f287)
    .addFields(
      { name: '購入者', value: `<@${buyerId}>`, inline: true },
      { name: '商品', value: label, inline: true },
      { name: 'ロール', value: `<@&${roleId}>`, inline: true },
      { name: '価格', value: `${price.toLocaleString()} ${unit}`, inline: true },
      { name: '有効時間', value: `${durationMinutes}分`, inline: true },
      { name: '期限', value: formatDateTime(expiresAt), inline: true },
    )
    .setTimestamp();
}

function getVcVisibilityLabel(mode) {
  return mode === 'public' ? '公開' : '非公開';
}

function parseVisibilityRoleIds(value) {
  return String(value || '').split(',').map(id => id.trim()).filter(Boolean);
}

function buildPrivateVcAccessPanelEmbed(ownerId, expiresAt, extensionPrice, extensionDuration, unit, visibilityMode) {
  const isPublic = visibilityMode === 'public';
  return new EmbedBuilder()
    .setTitle(isPublic ? '🎙️ 公開VC管理パネル' : '🔒 プライベートVC管理パネル')
    .setColor(0x3ba55d)
    .setDescription([
      `オーナー: <@${ownerId}>`,
      `VC削除時間: ${formatDateTime(expiresAt)}`,
      `延長料金: ${extensionPrice.toLocaleString()} ${unit}（+${extensionDuration}分）`,
      isPublic ? 'このVCは公開VCです。' : 'このVCはプライベートVCです。',
    ].join('\n'))
    .setTimestamp();
}

function buildPrivateVcAccessPanelComponents(voiceChannelId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`vc_room_extend:${voiceChannelId}:${ownerId}`)
        .setLabel('時間延長')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`vc_room_add:${voiceChannelId}:${ownerId}`)
        .setLabel('メンバー追加')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`vc_room_remove:${voiceChannelId}:${ownerId}`)
        .setLabel('メンバー削除')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`vc_room_rename:${voiceChannelId}:${ownerId}`)
        .setLabel('部屋名変更')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildPrivateVcUserSelectComponents(voiceChannelId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`vc_room_add_select:${voiceChannelId}:${ownerId}`)
        .setPlaceholder('VCに追加するユーザーを選択')
        .setMinValues(1)
        .setMaxValues(5),
    ),
  ];
}

function buildPrivateVcRemoveUserSelectComponents(voiceChannelId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`vc_room_remove_select:${voiceChannelId}:${ownerId}`)
        .setPlaceholder('VCから削除するユーザーを選択')
        .setMinValues(1)
        .setMaxValues(5),
    ),
  ];
}

async function applyVoiceChannelVisibility(channel, mode) {
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error('vc_channel_invalid');
  }

  const everyoneRole = channel.guild.roles.everyone;
  const isPublic = mode === 'public';
  await channel.permissionOverwrites.edit(everyoneRole, {
    ViewChannel: isPublic,
    Connect: isPublic,
  });
}

function buildPrivateRoomPermissionOverwrites(guild, ownerId, visibilityRoleIds) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages],
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  for (const roleId of parseVisibilityRoleIds(Array.isArray(visibilityRoleIds) ? visibilityRoleIds.join(',') : visibilityRoleIds)) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }
  return overwrites;
}

async function ensurePrivateRoomOwner(interaction, voiceChannelId, fallbackOwnerId) {
  const purchase = db.getVcVendingPurchase(interaction.guild.id, voiceChannelId);
  const ownerId = purchase?.buyer_id || fallbackOwnerId;
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: '❌ この操作は部屋を購入したユーザーのみ実行できます。', flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

async function sendPrivateRoomNotice(guild, voiceChannelId, content, embeds = [], components = []) {
  const purchase = db.getVcVendingPurchase(guild.id, voiceChannelId);
  if (!purchase || !purchase.text_channel_id) return null;
  const textChannel = guild.channels.cache.get(purchase.text_channel_id);
  if (!isTextBasedChannel(textChannel)) return null;
  return textChannel.send({ content, embeds, components }).catch(() => null);
}

async function deletePrivateRoomPanelMessage(guild, voiceChannelId, messageId) {
  if (!messageId) return;
  const purchase = db.getVcVendingPurchase(guild.id, voiceChannelId);
  const channelId = purchase?.text_channel_id || voiceChannelId;
  const channel = guild.channels.cache.get(channelId);
  if (!isTextBasedChannel(channel)) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.delete().catch(() => null);
}

async function createPrivateRoomFromTemplate(guild, ownerMember, category, label, expiresAt, visibilityRoleIds, userLimit, extensionPrice, extensionDuration, unit, visibilityMode) {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const vcName = `${ownerMember.displayName}様`.slice(0, 90);
  const overwrites = buildPrivateRoomPermissionOverwrites(guild, ownerMember.id, visibilityRoleIds);

  if (me) {
    overwrites.push({
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  const privateChannel = await guild.channels.create({
    name: vcName,
    type: ChannelType.GuildVoice,
    parent: category.id,
    userLimit,
    permissionOverwrites: overwrites,
    reason: `VC自販機購入: ${label} (${ownerMember.id})`,
  });

  // 管理パネルはVC内蔵のテキストチャットに送信する
  const panelMessage = await privateChannel.send({
    embeds: [buildPrivateVcAccessPanelEmbed(ownerMember.id, expiresAt, extensionPrice, extensionDuration, unit, visibilityMode)],
    components: buildPrivateVcAccessPanelComponents(privateChannel.id, ownerMember.id),
  }).catch(error => {
    console.error('VC自販機 管理パネル送信エラー:', error);
    return null;
  });

  return { voiceChannel: privateChannel, textChannel: privateChannel, panelMessage };
}

function buildVcVendingProductsText(guild, panelKey, { showVisibilityRoles = false } = {}) {
  const products = db.getVcVendingProducts(guild.id, panelKey);
  const unit = getUnit(guild.id);
  if (products.length === 0) {
    return '商品は未設定です。';
  }

  return products.map(p => [
    `**${p.slot}. ${p.label}**`,
    `作成先: <#${p.category_id || p.voice_channel_id}>`,
    ...(showVisibilityRoles
      ? [`公開ロール: ${parseVisibilityRoleIds(p.visibility_role_id).map(id => `<@&${id}>`).join(' ') || '未設定'}`]
      : []),
    `参加人数: ${p.user_limit > 0 ? `${p.user_limit}人` : '無制限'}`,
    `設定: ${getVcVisibilityLabel(p.visibility_mode)}`,
    `値段: ${p.price.toLocaleString()} ${unit}`,
    `延長: ${p.extension_price.toLocaleString()} ${unit} / ${p.extension_duration_minutes}分`,
    `時間: ${p.duration_minutes}分`,
  ].join(' / ')).join('\n');
}

function buildVcVendingPanelEmbed(guild, panel) {
  return new EmbedBuilder()
    .setTitle(panel.title)
    .setColor(0x3ba55d)
    .setDescription(`${panel.description}\n\n${buildVcVendingProductsText(guild, panel.panel_key)}`)
    .setFooter({ text: 'ボタンを押すと購入します。' })
    .setTimestamp();
}

function buildVcVendingPanelComponents(guildId, panelKey) {
  const products = db.getVcVendingProducts(guildId, panelKey);
  if (products.length === 0) {
    return [];
  }

  const buttons = products
    .sort((a, b) => a.slot - b.slot)
    .map(product => (
      new ButtonBuilder()
        .setCustomId(`vc_vending_buy:${panelKey}:${product.slot}`)
        .setLabel(`${product.slot}: ${product.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
    ));

  return [
    new ActionRowBuilder().addComponents(buttons.slice(0, 5)),
  ];
}

function buildVcVendingProductListEmbed(guild, panelKey) {
  const panel = db.getVcVendingPanel(guild.id, panelKey);
  return new EmbedBuilder()
    .setTitle(`🎛️ VC自販機商品一覧 (${panelKey})`)
    .setColor(0x3ba55d)
    .addFields(
      { name: '商品一覧', value: buildVcVendingProductsText(guild, panelKey, { showVisibilityRoles: true }), inline: false },
      { name: 'パネル', value: panel && panel.channel_id && panel.message_id ? `<#${panel.channel_id}> / ${panel.message_id}` : '未設置', inline: false },
      { name: '購入ログ', value: db.getVcVendingLogChannel(guild.id, panelKey) ? `<#${db.getVcVendingLogChannel(guild.id, panelKey)}>` : '未設定', inline: false },
    )
    .setTimestamp();
}

async function refreshVcVendingPanel(guild, panelKey) {
  const panel = db.getVcVendingPanel(guild.id, panelKey);
  if (!panel || !panel.channel_id || !panel.message_id) return;

  const channel = guild.channels.cache.get(panel.channel_id);
  if (!isTextBasedChannel(channel)) return;

  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [buildVcVendingPanelEmbed(guild, panel)],
    components: buildVcVendingPanelComponents(guild.id, panel.panel_key),
  });
}

function buildVcVendingPurchaseLogEmbed({ buyerId, label, voiceChannelId, visibilityMode, price, durationMinutes, expiresAt, unit }) {
  return new EmbedBuilder()
    .setTitle('🧾 VC自販機購入ログ')
    .setColor(0x3ba55d)
    .addFields(
      { name: '購入者', value: `<@${buyerId}>`, inline: true },
      { name: '商品', value: label, inline: true },
      { name: '対象VC', value: `<#${voiceChannelId}>`, inline: true },
      { name: '設定', value: getVcVisibilityLabel(visibilityMode), inline: true },
      { name: '価格', value: `${price.toLocaleString()} ${unit}`, inline: true },
      { name: '有効時間', value: `${durationMinutes}分`, inline: true },
      { name: '期限', value: formatDateTime(expiresAt), inline: true },
    )
    .setTimestamp();
}

async function processVendingExpirations() {
  const now = Date.now();
  const expired = db.getExpiredVendingPurchases(now);

  for (const row of expired) {
    try {
      const guild = client.guilds.cache.get(row.guild_id);
      if (guild) {
        const member = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(() => null);
        if (member && member.roles.cache.has(row.role_id)) {
          await member.roles.remove(row.role_id).catch(() => null);
        }
      }
    } finally {
      db.deleteVendingPurchase(row.guild_id, row.user_id, row.role_id);
    }
  }
}

async function processVcVendingExpirations() {
  const expired = db.getExpiredVcVendingPurchases(Date.now());

  for (const row of expired) {
    try {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) continue;

      const channel = guild.channels.cache.get(row.voice_channel_id);
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;

      if (row.is_temporary) {
        const textChannel = row.text_channel_id && row.text_channel_id !== row.voice_channel_id
          ? guild.channels.cache.get(row.text_channel_id)
          : null;
        await textChannel?.delete('VC自販機の期限切れにより自動削除').catch(() => null);
        await channel.delete('VC自販機の期限切れにより自動削除').catch(() => null);
      } else {
        const revertMode = row.mode === 'public' ? 'private' : 'public';
        await applyVoiceChannelVisibility(channel, revertMode).catch(() => null);
      }
    } finally {
      db.deleteVcVendingPurchase(row.guild_id, row.voice_channel_id);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_EVALUATION_CHECKIN_MESSAGE = [
  '{user} さん、こんにちは。',
  '**{guild}** の仮メンバー評価期間について中間確認のご連絡です。',
  '',
  '評価期限: {deadline}（残り約 {remaining_days} 日）',
  '',
  'このまま仮メンバーとして評価を継続するか、ここで評価を終了するかを下のボタンから選んでください。',
  '選択しなかった場合は、そのまま仮メンバーとして評価を継続します。',
].join('\n');

function renderEvaluationCheckinMessage(template, context) {
  return String(template)
    .replaceAll('{user}', `<@${context.userId}>`)
    .replaceAll('{name}', context.displayName)
    .replaceAll('{guild}', context.guildName)
    .replaceAll('{deadline}', formatDateTime(context.deadlineAt))
    .replaceAll('{remaining_days}', String(context.remainingDays))
    .replaceAll('{days}', String(context.evaluationDays))
    .replaceAll('{checkin_days}', String(context.checkinDays))
    .slice(0, 1900);
}

function buildEvaluationCheckinRow(guildId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`eval_checkin:continue:${guildId}`)
      .setLabel('仮メンバーを続ける')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`eval_checkin:stop:${guildId}`)
      .setLabel('評価を終了する')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

async function processEvaluationCheckins() {
  const now = Date.now();

  for (const row of db.getPendingEvaluationCheckins()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;

    const settings = db.getSettings(guild.id);
    const checkinDays = Math.max(0, Math.floor(Number(settings.evaluation_checkin_days || 0)));
    const evaluationDays = Math.max(0, Math.floor(Number(settings.evaluation_days || 0)));
    const evaluationRoleId = settings.evaluation_role_id || null;
    if (checkinDays <= 0 || evaluationDays <= 0 || !evaluationRoleId) continue;

    const periodStartAt = getNextDayStartAtJst(row.passed_at);
    if (now < periodStartAt + (checkinDays * DAY_MS)) continue;

    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member || !member.roles.cache.has(evaluationRoleId)) {
      db.markEvaluationCheckinNotified(row.user_id, guild.id, now);
      continue;
    }

    const deadlineAt = periodStartAt + (evaluationDays * DAY_MS);
    const content = renderEvaluationCheckinMessage(settings.evaluation_checkin_message || DEFAULT_EVALUATION_CHECKIN_MESSAGE, {
      userId: member.id,
      displayName: member.displayName,
      guildName: guild.name,
      deadlineAt,
      remainingDays: Math.max(0, Math.ceil((deadlineAt - now) / DAY_MS)),
      evaluationDays,
      checkinDays,
    });

    const sent = await member.send({ content, components: [buildEvaluationCheckinRow(guild.id)] }).catch(() => null);
    db.markEvaluationCheckinNotified(row.user_id, guild.id, now);

    if (!sent) {
      await sendToConfiguredChannel(guild, settings.interview_log_channel_id, {
        content: `⚠️ <@${member.id}> へ仮メンバー中間確認のDMを送信できませんでした（DM拒否の可能性）。`,
      }).catch(() => null);
    }
  }
}

async function handleEvaluationCheckinButton(interaction) {
  const [, choice, guildId] = interaction.customId.split(':');
  if (choice !== 'continue' && choice !== 'stop') return;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    await interaction.reply({ content: '❌ 対象サーバーが見つかりませんでした。' }).catch(() => null);
    return;
  }

  const evaluation = db.getInterviewEvaluation(interaction.user.id, guild.id);
  if (!evaluation) {
    await interaction.reply({ content: '❌ 評価情報が見つかりませんでした。サーバーの担当者にお問い合わせください。' }).catch(() => null);
    return;
  }

  if (evaluation.checkin_choice) {
    await interaction.update({ components: [buildEvaluationCheckinRow(guild.id, true)] }).catch(() => null);
    await interaction.followUp({ content: 'すでに選択済みです。変更が必要な場合はサーバーの担当者にお問い合わせください。' }).catch(() => null);
    return;
  }

  const settings = db.getSettings(guild.id);
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: '❌ サーバー内でメンバー情報を確認できませんでした。' }).catch(() => null);
    return;
  }

  let resultText;
  if (choice === 'continue') {
    resultText = '✅ 引き続き仮メンバーとして評価を継続します。';
  } else {
    const stopRoleId = settings.evaluation_stop_role_id || null;
    if (!stopRoleId) {
      await interaction.reply({ content: '❌ 評価終了時に付与するロールが未設定のため処理できません。サーバーの担当者にお問い合わせください。' }).catch(() => null);
      return;
    }
    await member.roles.add(stopRoleId);
    if (settings.evaluation_role_id && member.roles.cache.has(settings.evaluation_role_id)) {
      await member.roles.remove(settings.evaluation_role_id).catch(() => null);
    }
    resultText = '✅ 評価を終了しました。ロールを変更しています。';
  }

  db.setEvaluationCheckinChoice(interaction.user.id, guild.id, choice, Date.now());

  await interaction.update({ components: [buildEvaluationCheckinRow(guild.id, true)] }).catch(() => null);
  await interaction.followUp({ content: resultText }).catch(() => null);

  await sendToConfiguredChannel(guild, settings.interview_log_channel_id, {
    embeds: [new EmbedBuilder()
      .setTitle('📝 仮メンバー中間確認の回答')
      .setColor(choice === 'continue' ? 0x57f287 : 0x99aab5)
      .addFields(
        { name: 'ユーザー', value: `<@${member.id}>`, inline: true },
        { name: '選択', value: choice === 'continue' ? '仮メンバーを続ける' : '評価を終了する', inline: true },
      )
      .setTimestamp()],
  }).catch(() => null);
}

async function grantRoleSalary(guild, roleId, amount) {
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    return { success: false, reason: 'role_not_found', paidCount: 0, totalGranted: 0 };
  }

  const targets = role.members.filter(member => !member.user.bot);
  let paidCount = 0;
  let totalGranted = 0;

  for (const [, target] of targets) {
    db.addBalance(target.id, guild.id, amount);
    paidCount++;
    totalGranted += amount;
  }

  return {
    success: true,
    role,
    paidCount,
    totalGranted,
  };
}

async function sendLevelingLog(guild, payload) {
  const settings = db.getSettings(guild.id);
  if (!settings.leveling_log_channel_id) return;
  await sendToConfiguredChannel(guild, settings.leveling_log_channel_id, payload);
}

async function syncMemberLevelingRoles(member, now = Date.now()) {
  if (!member || member.user.bot) return;

  const guildId = member.guild.id;
  const profile = db.getLevelingProfile(member.id, guildId);
  const totalSeconds = getEffectiveLevelingSeconds(member.id, guildId, now);
  const state = calculateLevelingState(guildId, totalSeconds);
  const targetRange = db.getLevelingRoleRangeForLevel(guildId, state.level);
  const levelingRoleIds = [...new Set(db.getLevelingRoleRanges(guildId).map(row => row.role_id))];

  const currentRoleIds = levelingRoleIds.filter(roleId => member.roles.cache.has(roleId));
  const targetRoleId = targetRange ? targetRange.role_id : null;
  const rolesToRemove = targetRange ? currentRoleIds.filter(roleId => roleId !== targetRoleId) : currentRoleIds;
  const needsAdd = !!targetRoleId && !member.roles.cache.has(targetRoleId);

  try {
    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove);
    }
    if (needsAdd) {
      await member.roles.add(targetRoleId);
    }

    if (state.level > profile.last_level) {
      await sendLevelingLog(member.guild, {
        embeds: [buildLevelUpLogEmbed({
          targetMember: member,
          guild: member.guild,
          previousLevel: profile.last_level,
          currentLevel: state.level,
          totalSeconds,
        })],
      });
    }

    if (state.level !== profile.last_level) {
      db.setLevelingLastLevel(member.id, guildId, state.level);
    }
  } catch (error) {
    console.error(`レベリングロール同期エラー (${member.id}):`, error);
  }
}

async function processActiveLevelingSessions() {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!isLevelingTargetChannel(guild.id, state.channelId) || state.member?.user?.bot) continue;
      const member = state.member || await guild.members.fetch(state.id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }
    }
  }
}

async function reconcileLevelingSessions() {
  const now = Date.now();

  for (const guild of client.guilds.cache.values()) {
    const activeSessions = db.getActiveLevelingSessions(guild.id);
    const sessionMap = new Map(activeSessions.map(session => [session.user_id, session]));

    for (const state of guild.voiceStates.cache.values()) {
      if (state.member?.user?.bot) continue;

      const isTargetChannel = isLevelingTargetChannel(guild.id, state.channelId);
      if (!isTargetChannel) {
        const existingSession = sessionMap.get(state.id);
        if (existingSession) {
          db.addLevelingSeconds(state.id, guild.id, Math.max(0, Math.floor((now - existingSession.joined_at) / 1000)));
          db.deleteLevelingSession(state.id, guild.id);
          sessionMap.delete(state.id);
        }
        continue;
      }

      const existingSession = sessionMap.get(state.id);
      if (existingSession) {
        if (existingSession.channel_id !== state.channelId) {
          db.updateLevelingSessionChannel(state.id, guild.id, state.channelId);
        }
      } else {
        db.upsertLevelingSession(state.id, guild.id, state.channelId, now);
      }

      const member = state.member || await guild.members.fetch(state.id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }

      sessionMap.delete(state.id);
    }

    for (const session of sessionMap.values()) {
      db.addLevelingSeconds(session.user_id, guild.id, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
      db.deleteLevelingSession(session.user_id, guild.id);

      const member = guild.members.cache.get(session.user_id) || await guild.members.fetch(session.user_id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }
    }
  }
}

function isRoleVoiceTimeTargetChannel(guildId, roleId, channelId) {
  return !!channelId && db.getRoleVoiceTimeChannels(guildId, roleId).includes(channelId);
}

function syncRoleVoiceTimeSession(member, channelId, now = Date.now()) {
  if (!member || member.user.bot) return;

  const roleIds = db.getRoleVoiceTimeRoles(member.guild.id);
  for (const roleId of roleIds) {
    const session = db.getActiveRoleVoiceTimeSession(member.id, member.guild.id, roleId);
    const shouldTrack = member.roles.cache.has(roleId) && isRoleVoiceTimeTargetChannel(member.guild.id, roleId, channelId);

    if (shouldTrack) {
      if (!session) {
        db.upsertRoleVoiceTimeSession(member.id, member.guild.id, roleId, channelId, now);
      } else if (session.channel_id !== channelId) {
        db.addRoleVoiceTimeSeconds(member.id, member.guild.id, roleId, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
        db.upsertRoleVoiceTimeSession(member.id, member.guild.id, roleId, channelId, now);
      }
    } else if (session) {
      db.addRoleVoiceTimeSeconds(member.id, member.guild.id, roleId, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
      db.deleteRoleVoiceTimeSession(member.id, member.guild.id, roleId);
    }
  }
}

async function reconcileRoleVoiceTimeSessions() {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const activeUserIds = new Set();
    for (const state of guild.voiceStates.cache.values()) {
      if (state.member?.user?.bot) continue;
      const member = state.member || await guild.members.fetch(state.id).catch(() => null);
      if (!member) continue;
      activeUserIds.add(member.id);
      syncRoleVoiceTimeSession(member, state.channelId, now);
    }

    for (const session of db.getActiveRoleVoiceTimeSessions(guild.id)) {
      if (activeUserIds.has(session.user_id)) continue;
      db.addRoleVoiceTimeSeconds(session.user_id, guild.id, session.role_id, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
      db.deleteRoleVoiceTimeSession(session.user_id, guild.id, session.role_id);
    }
  }
}

async function processRoleVoiceTimeRewards() {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const unit = getUnit(guild.id);
    const defaultLogChannelId = db.getSettings(guild.id).grant_log_channel_id;

    for (const reward of db.getRoleVoiceTimeRewards(guild.id)) {
      const period = getRoleVoiceTimePeriod(guild.id, reward.role_id, now);
      const profiles = period.since == null
        ? db.getRoleVoiceTimeProfiles(guild.id, reward.role_id)
        : db.getRoleVoiceTimeProfilesSince(guild.id, reward.role_id, period.since);
      const activeUserIds = db.getActiveRoleVoiceTimeSessions(guild.id)
        .filter((session) => session.role_id === reward.role_id)
        .map((session) => session.user_id);
      const userIds = new Set([...profiles.map((profile) => profile.user_id), ...activeUserIds]);
      const minimumRewardedAt = period.days > 0 ? now - (period.days * 24 * 60 * 60 * 1000) : 0;

      for (const userId of userIds) {
        const totalSeconds = getEffectiveRoleVoiceTimeSeconds(userId, guild.id, reward.role_id, now);
        if (totalSeconds < reward.required_seconds) continue;
        if (!db.claimRoleVoiceTimeReward(userId, reward.id, minimumRewardedAt, now)) continue;

        db.addBalance(userId, guild.id, reward.reward_amount);
        const balance = db.getBalance(userId, guild.id);
        await sendLogToChannelOrForum(
          guild,
          reward.log_channel_id || defaultLogChannelId,
          {
            embeds: [buildRoleVoiceTimeRewardLogEmbed({
              userId,
              roleId: reward.role_id,
              totalSeconds,
              requiredSeconds: reward.required_seconds,
              periodDays: period.days,
              amount: reward.reward_amount,
              balance,
              unit,
            })],
          },
          'ロールVC時間報酬ログ',
        );
      }
    }
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('bankパネル設置')
    .setDescription('[管理者] 送金・残高確認ができるbankパネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('設置先チャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('タイトル').setDescription('パネルのタイトル').setMaxLength(100))
    .addStringOption(opt => opt.setName('説明').setDescription('パネルの説明').setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('送金可能ロール設定')
    .setDescription('[管理者] bankパネルの送金先として選択できるロールを設定します（最大10つ）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール1').setDescription('送金先として選択可能にするロール（未指定で全解除）'))
    .addRoleOption(opt => opt.setName('ロール2').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール3').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール4').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール5').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール6').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール7').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール8').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール9').setDescription('送金先として選択可能にするロール'))
    .addRoleOption(opt => opt.setName('ロール10').setDescription('送金先として選択可能にするロール')),

  new SlashCommandBuilder()
    .setName('送金ログチャンネル')
    .setDescription('[管理者] bankパネルの送金ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)),

  new SlashCommandBuilder()
    .setName('付与ログチャンネル')
    .setDescription('[管理者] 通貨付与ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)),

  new SlashCommandBuilder()
    .setName('減額ログチャンネル')
    .setDescription('[管理者] 通貨減額ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)),

  new SlashCommandBuilder()
    .setName('通貨サポートロール設定')
    .setDescription('[管理者] 通貨の付与・減額を実行できるロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('付与・減額を許可するロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('通貨単位設定')
    .setDescription('[管理者] 通貨の単位を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('単位').setDescription('通貨の単位').setRequired(true).setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('商品購入')
    .setDescription('チケット内で商品を購入します')
    .addIntegerOption(opt => opt.setName('金額').setDescription('商品価格').setRequired(true).setMinValue(1))
    .addStringOption(opt => opt.setName('商品名').setDescription('購入する商品名').setRequired(true).setMaxLength(100)),

  new SlashCommandBuilder()
    .setName('商品購入設定')
    .setDescription('[管理者] チケットごとの商品購入可否とログ先を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('お問い合わせ')
      .setDescription('お問い合わせ受付の設定を変更します')
      .addStringOption(opt => opt.setName('受付id').setDescription('対象の受付ID').setRequired(true).setMaxLength(30))
      .addChannelOption(opt => opt.setName('ログチャンネル').setDescription('商品購入ログの送信先').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum))
      .addBooleanOption(opt => opt.setName('使用可能').setDescription('この受付で商品購入を許可するか').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('チケット')
      .setDescription('通常チケットパネルの設定を変更します')
      .addIntegerOption(opt => opt.setName('パネルid').setDescription('対象のチケットパネルID').setRequired(true).setMinValue(1))
      .addChannelOption(opt => opt.setName('ログチャンネル').setDescription('商品購入ログの送信先').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum))
      .addBooleanOption(opt => opt.setName('使用可能').setDescription('このチケットで商品購入を許可するか').setRequired(true))),

  new SlashCommandBuilder()
    .setName('自販機パネル設置')
    .setDescription('[管理者] 自販機パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('パネル識別子(英数字/ _ / -)').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('設置先チャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('タイトル').setDescription('パネルタイトル').setRequired(true).setMaxLength(100))
    .addStringOption(opt => opt.setName('説明').setDescription('パネル説明').setRequired(true).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('自販機パネル削除')
    .setDescription('[管理者] 自販機パネルを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('削除するパネルID').setRequired(true).setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('自販機商品設定')
    .setDescription('[管理者] 自販機の商品を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('設定')
      .setDescription('商品を設定または更新します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('ボタンスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
      .addStringOption(opt => opt.setName('商品名').setDescription('表示する商品名').setRequired(true).setMaxLength(80))
      .addRoleOption(opt => opt.setName('ロール').setDescription('付与するロール').setRequired(true))
      .addIntegerOption(opt => opt.setName('値段').setDescription('購入価格').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('時間').setDescription('有効時間（分）').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('削除')
      .setDescription('商品を削除します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('削除するスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
    )
    .addSubcommand(sub => sub
      .setName('一覧')
      .setDescription('商品一覧を表示します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addStringOption(opt => opt
        .setName('表示')
        .setDescription('表示方法')
        .addChoices(
          { name: '公開', value: 'public' },
          { name: '非公開', value: 'hidden' },
        ))
    ),

  new SlashCommandBuilder()
    .setName('自販機ログチャンネル')
    .setDescription('[管理者] 自販機購入ログの送信先を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('vc自販機パネル設置')
    .setDescription('[管理者] VC自販機パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('パネル識別子(英数字/ _ / -)').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('設置先チャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('タイトル').setDescription('パネルタイトル').setRequired(true).setMaxLength(100))
    .addStringOption(opt => opt.setName('説明').setDescription('パネル説明').setRequired(true).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('vc自販機パネル削除')
    .setDescription('[管理者] VC自販機パネルを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('削除するパネルID').setRequired(true).setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('vc自販機商品設定')
    .setDescription('[管理者] VC自販機の商品を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('設定')
      .setDescription('商品を設定または更新します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('ボタンスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
      .addStringOption(opt => opt.setName('商品名').setDescription('表示する商品名').setRequired(true).setMaxLength(80))
      .addChannelOption(opt => opt.setName('カテゴリ').setDescription('一時VCを作成するカテゴリ').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
      .addRoleOption(opt => opt.setName('公開ロール').setDescription('作成されたVCを見えるようにするロール').setRequired(true))
      .addIntegerOption(opt => opt.setName('参加人数').setDescription('VCの参加人数上限（0は無制限）').setRequired(true).setMinValue(0).setMaxValue(99))
      .addStringOption(opt => opt
        .setName('公開設定')
        .setDescription('適用する公開設定')
        .setRequired(true)
        .addChoices(
          { name: '公開', value: 'public' },
          { name: '非公開', value: 'private' },
        ))
      .addIntegerOption(opt => opt.setName('値段').setDescription('購入価格').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('延長料金').setDescription('チャットの延長ボタンで使う料金').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('延長時間').setDescription('チャットの延長ボタンで追加する時間（分）').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('時間').setDescription('有効時間（分）').setRequired(true).setMinValue(1))
      .addRoleOption(opt => opt.setName('公開ロール2').setDescription('追加でVCを見えるようにするロール'))
      .addRoleOption(opt => opt.setName('公開ロール3').setDescription('追加でVCを見えるようにするロール'))
      .addRoleOption(opt => opt.setName('公開ロール4').setDescription('追加でVCを見えるようにするロール'))
      .addRoleOption(opt => opt.setName('公開ロール5').setDescription('追加でVCを見えるようにするロール'))
    )
    .addSubcommand(sub => sub
      .setName('削除')
      .setDescription('商品を削除します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addIntegerOption(opt => opt.setName('スロット').setDescription('削除するスロット(1-5)').setRequired(true).setMinValue(1).setMaxValue(5))
    )
    .addSubcommand(sub => sub
      .setName('一覧')
      .setDescription('商品一覧を表示します')
      .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
      .addStringOption(opt => opt
        .setName('表示')
        .setDescription('表示方法')
        .addChoices(
          { name: '公開', value: 'public' },
          { name: '非公開', value: 'hidden' },
        ))
    ),

  new SlashCommandBuilder()
    .setName('vc自販機ログチャンネル')
    .setDescription('[管理者] VC自販機購入ログの送信先を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('パネルid').setDescription('対象パネルID').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('面接通過許可ロール')
    .setDescription('[管理者] /面接通過 を実行できる許可ロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('許可するロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('面接設定')
    .setDescription('[管理者] /面接通過 実行時のアクションを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('外すロール').setDescription('外すロール').setRequired(true))
    .addRoleOption(opt => opt.setName('付与するロール').setDescription('付与するロール').setRequired(true))
    .addIntegerOption(opt => opt.setName('付与金額').setDescription('一人当たりの付与金額').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName('評価期限設定')
    .setDescription('[管理者] 評価期限日数と評価期限表示対象ロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt => opt.setName('日数').setDescription('面接通過日からの評価期限日数').setRequired(true).setMinValue(0))
    .addRoleOption(opt => opt.setName('対象ロール').setDescription('評価期限を表示する対象ロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('仮メンバー確認設定')
    .setDescription('[管理者] 仮メンバーへ中間確認DMを送る日数と評価終了時ロールを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt => opt.setName('日数').setDescription('評価開始からDMを送るまでの日数（0で無効）').setRequired(true).setMinValue(0))
    .addRoleOption(opt => opt.setName('評価終了ロール').setDescription('「評価を終了する」を選んだ場合に付与するロール').setRequired(false)),

  new SlashCommandBuilder()
    .setName('仮メンバー確認文設定')
    .setDescription('[管理者] 仮メンバーへ送る中間確認DMの本文を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('ロール表示除外設定')
    .setDescription('[管理者] /自分 で対象外メンバーに表示するロールを最大3つ設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('表示ロール1').setDescription('表示するロール1').setRequired(false))
    .addRoleOption(opt => opt.setName('表示ロール2').setDescription('表示するロール2').setRequired(false))
    .addRoleOption(opt => opt.setName('表示ロール3').setDescription('表示するロール3').setRequired(false)),

  new SlashCommandBuilder()
    .setName('面接通過ログチャンネル')
    .setDescription('[管理者] 面接通過ログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('レベリングログチャンネル')
    .setDescription('[管理者] レベルアップログを通知するチャンネルを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('レベリング場所')
    .setDescription('[管理者] レベリング対象のVCを最大5か所設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('場所1').setDescription('レベリング対象にするVC').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所2').setDescription('レベリング対象にするVC').setRequired(false).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所3').setDescription('レベリング対象にするVC').setRequired(false).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所4').setDescription('レベリング対象にするVC').setRequired(false).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所5').setDescription('レベリング対象にするVC').setRequired(false).addChannelTypes(ChannelType.GuildVoice)),

  new SlashCommandBuilder()
    .setName('ロールvc時間設定')
    .setDescription('[管理者] ロールごとのVC参加時間計測対象を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('計測するロール').setRequired(true))
    .addChannelOption(opt => opt.setName('場所1').setDescription('計測対象にするVC').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所2').setDescription('追加の計測対象VC').setRequired(false).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所3').setDescription('追加の計測対象VC').setRequired(false).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所4').setDescription('追加の計測対象VC').setRequired(false).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(opt => opt.setName('場所5').setDescription('追加の計測対象VC').setRequired(false).addChannelTypes(ChannelType.GuildVoice)),

  new SlashCommandBuilder()
    .setName('ロールvc期間設定')
    .setDescription('[管理者] ロール別VC時間の集計期間を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('設定するロール').setRequired(true))
    .addIntegerOption(opt => opt.setName('日数').setDescription('直近日数。0で期間なしの累計表示').setRequired(true).setMinValue(0).setMaxValue(3650)),

  new SlashCommandBuilder()
    .setName('ロールvc報酬設定')
    .setDescription('[管理者] ロール別VC時間の達成報酬を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('報酬を設定するロール').setRequired(true))
    .addIntegerOption(opt => opt.setName('必要分').setDescription('報酬に必要なVC参加時間（分）').setRequired(true).setMinValue(1).setMaxValue(5256000))
    .addIntegerOption(opt => opt.setName('金額').setDescription('達成時に付与する通貨').setRequired(true).setMinValue(1))
    .addChannelOption(opt => opt.setName('ログチャンネル').setDescription('報酬ログ先。未指定なら付与ログ先').setRequired(false).addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)),

  new SlashCommandBuilder()
    .setName('ロールvc報酬削除')
    .setDescription('[管理者] ロール別VC時間の報酬設定を削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt => opt.setName('報酬id').setDescription('economy設定状況に表示される報酬ID').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('ロールvc時間')
    .setDescription('指定ロールでのVC参加時間を確認します')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('確認するユーザー').setRequired(true))
    .addRoleOption(opt => opt.setName('ロール').setDescription('確認するロール').setRequired(true))
    .addStringOption(opt => opt.setName('表示').setDescription('表示方法').addChoices(
      { name: '公開', value: 'public' },
      { name: '非公開', value: 'hidden' },
    )),

  new SlashCommandBuilder()
    .setName('ロールvc時間ランキング')
    .setDescription('指定ロールでのVC参加時間ランキングを表示します')
    .addRoleOption(opt => opt.setName('ロール').setDescription('集計するロール').setRequired(true))
    .addStringOption(opt => opt.setName('表示').setDescription('表示方法').addChoices(
      { name: '公開', value: 'public' },
      { name: '非公開', value: 'hidden' },
    )),

  new SlashCommandBuilder()
    .setName('面接通過')
    .setDescription('VCにいるメンバーに面接通過処理を一括実行します'),

  new SlashCommandBuilder()
    .setName('自分')
    .setDescription('自分の残高とVCレベルを確認します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('レベリング設定')
    .setDescription('[管理者] VC参加時間レベリングを設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('時間設定')
      .setDescription('レベルごとの必要VC参加時間を設定します')
      .addIntegerOption(opt => opt.setName('レベル').setDescription('設定対象の現在レベル').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('必要分').setDescription('次のレベルに必要な分数').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('時間一括設定')
      .setDescription('開始レベルから10レベル分の必要VC参加時間をまとめて設定します')
      .addIntegerOption(opt => opt.setName('開始レベル').setDescription('設定開始レベル').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('必要分').setDescription('10レベル分の次のレベルに必要な分数').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub => sub
      .setName('ロール設定')
      .setDescription('レベル範囲に対応するロールを設定します')
      .addIntegerOption(opt => opt.setName('開始レベル').setDescription('適用開始レベル').setRequired(true).setMinValue(1))
      .addIntegerOption(opt => opt.setName('終了レベル').setDescription('適用終了レベル').setRequired(true).setMinValue(1))
      .addRoleOption(opt => opt.setName('ロール').setDescription('付与するロール').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('表示')
      .setDescription('現在のレベリング設定を表示します')
    ),

  new SlashCommandBuilder()
    .setName('ユーザー情報')
    .setDescription('[開発者専用] 指定ユーザーの残高とVCレベルを確認します')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('確認対象のユーザー').setRequired(true))
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('vc接続時間ランキング')
    .setDescription('VC接続時間のTOP10を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('vc接続時間リセット')
    .setDescription('[開発者専用] 指定ユーザーのVC接続時間をリセットします')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('リセット対象のユーザー').setRequired(true)),

  new SlashCommandBuilder()
    .setName('残高全額リセット')
    .setDescription('[開発者専用] 指定ユーザーの残高を0にします')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('リセット対象のユーザー').setRequired(true)),

  new SlashCommandBuilder()
    .setName('vc接続時間全リセット')
    .setDescription('[開発者専用] 全ユーザーのVC接続時間をリセットします'),

  new SlashCommandBuilder()
    .setName('残高全額全リセット')
    .setDescription('[開発者専用] 全ユーザーの残高を0にします'),

  new SlashCommandBuilder()
    .setName('評価リセット')
    .setDescription('[開発者専用] 評価情報をリセットします（ユーザー未指定で全員）')
    .addUserOption(opt => opt.setName('ユーザー').setDescription('リセット対象ユーザー').setRequired(false)),

  new SlashCommandBuilder()
    .setName('評価一覧')
    .setDescription('[開発者専用] 評価情報の一覧を表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('給与設定')
    .setDescription('[管理者] ロールごとの給与設定を保存します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('対象ロール').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('1回あたりの付与金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('給与設定解除')
    .setDescription('[管理者] ロールごとの給与設定を解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('対象ロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('給与設定一覧')
    .setDescription('[管理者] ロールごとの給与設定一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('給与一括付与')
    .setDescription('[管理者] 指定ロールのメンバーへ給与を一括付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(opt => opt.setName('ロール').setDescription('対象ロール').setRequired(true)),

  new SlashCommandBuilder()
    .setName('給与全ロール一括付与')
    .setDescription('[管理者] 設定済みロールすべてに給与を一括付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('付与')
    .setDescription('[管理者] 指定ユーザーに通貨を付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(opt => opt.setName('ユーザー').setDescription('付与するユーザー').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('付与する金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('減額')
    .setDescription('[管理者] 指定ユーザーから通貨を減額します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(opt => opt.setName('ユーザー').setDescription('減額するユーザー').setRequired(true))
    .addIntegerOption(opt => opt.setName('金額').setDescription('減額する金額').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('コマンド一覧')
    .setDescription('[管理者] 全モジュールのコマンド一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .setRequired(true)
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  ...['community', 'economy', 'security'].map((section) => new SlashCommandBuilder()
    .setName(`${section}設定状況`)
    .setDescription(`[管理者] ${section}のサーバー設定状況を表示します`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .setRequired(true)
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      ))),

  new SlashCommandBuilder()
    .setName('bot情報')
    .setDescription('[開発者専用] Bot参加サーバー一覧と招待リンクを表示します')
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .setRequired(true)
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  ...gachaCommandBuilders,
].map(cmd => cmd.toJSON());

const REMOVED_COMMAND_NAMES = ['送金', '設定状況'];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('スラッシュコマンドを登録中...');
    for (const command of commands) {
      await rest.post(Routes.applicationCommands(CLIENT_ID), { body: command });
    }

    const existing = await rest.get(Routes.applicationCommands(CLIENT_ID)).catch(() => []);
    for (const command of existing) {
      if (REMOVED_COMMAND_NAMES.includes(command.name)) {
        await rest.delete(Routes.applicationCommand(CLIENT_ID, command.id)).catch(() => null);
        console.log(`廃止コマンドを削除しました: /${command.name}`);
      }
    }
    console.log('スラッシュコマンドの登録が完了しました');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
}

function buildTransferLogEmbed({ userId, targetId, amount, senderBalance, receiverBalance, unit, note }) {
  const embed = new EmbedBuilder()
    .setTitle('💸 送金ログ')
    .setColor(0x5865f2)
    .addFields(
      { name: '送金者', value: `<@${userId}>`, inline: true },
      { name: '受取者', value: `<@${targetId}>`, inline: true },
      { name: '金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '送金者残高', value: `${senderBalance.toLocaleString()} ${unit}`, inline: true },
      { name: '受取者残高', value: `${receiverBalance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();

  if (note) {
    embed.addFields({ name: 'ひとこと', value: note.slice(0, 1024), inline: false });
  }
  return embed;
}

const BANK_TARGETS_PER_PAGE = 25;
const bankTransferDrafts = new Map();

function getBankDraftKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getBankDraft(guildId, userId) {
  const key = getBankDraftKey(guildId, userId);
  let draft = bankTransferDrafts.get(key);
  if (!draft) {
    draft = { targetId: null, amount: null, note: null, page: 0, search: '' };
    bankTransferDrafts.set(key, draft);
  }
  return draft;
}

function buildBankPanelEmbed(guild, title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x57f287)
    .setFooter({ text: guild.name })
    .setTimestamp();
}

function buildBankPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bank_transfer_start').setLabel('送金').setEmoji('💸').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('bank_balance').setLabel('残高確認').setEmoji('💰').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function getBankTransferTargets(guild, excludeUserId, search = '') {
  const roleIds = db.getBankTransferRoles(guild.id);
  if (roleIds.length === 0) return [];

  const keyword = String(search || '').trim().toLowerCase();
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  return [...members.values()]
    .filter(member => !member.user.bot && member.id !== excludeUserId && roleIds.some(roleId => member.roles.cache.has(roleId)))
    .filter(member => !keyword
      || member.displayName.toLowerCase().includes(keyword)
      || member.user.username.toLowerCase().includes(keyword))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
}

function isBankDraftComplete(draft) {
  return !!draft.targetId && Number.isInteger(draft.amount) && draft.amount > 0 && !!draft.note;
}

function buildBankTransferEmbed(guild, draft) {
  const unit = getUnit(guild.id);
  return new EmbedBuilder()
    .setTitle('💸 送金フォーム')
    .setColor(0x5865f2)
    .setDescription('「宛先」「金額」「ひとこと」をすべて入力すると送信ボタンが表示されます。対象が多い場合は「宛先を検索」で絞り込めます。')
    .addFields(
      { name: '宛先', value: draft.targetId ? `<@${draft.targetId}>` : '未選択', inline: true },
      { name: '金額', value: Number.isInteger(draft.amount) ? `${draft.amount.toLocaleString()} ${unit}` : '未入力', inline: true },
      { name: '検索条件', value: draft.search ? `\`${draft.search}\`` : 'なし', inline: true },
      { name: 'ひとこと', value: draft.note ? draft.note.slice(0, 1024) : '未入力', inline: false },
    );
}

function buildBankTransferComponents(draft, targets) {
  const totalPages = Math.max(1, Math.ceil(targets.length / BANK_TARGETS_PER_PAGE));
  const page = Math.min(Math.max(0, draft.page), totalPages - 1);
  draft.page = page;
  const pageTargets = targets.slice(page * BANK_TARGETS_PER_PAGE, page * BANK_TARGETS_PER_PAGE + BANK_TARGETS_PER_PAGE);

  const select = new StringSelectMenuBuilder()
    .setCustomId('bank_transfer_target')
    .setMinValues(1)
    .setMaxValues(1);

  if (pageTargets.length === 0) {
    select
      .setPlaceholder(draft.search ? '検索に一致するユーザーがいません' : '送金可能なユーザーがいません')
      .setDisabled(true)
      .addOptions({ label: '対象ユーザーなし', value: 'none' });
  } else {
    select
      .setPlaceholder(totalPages > 1 ? `宛先を選択してください（${page + 1}/${totalPages}）` : '宛先を選択してください')
      .addOptions(pageTargets.map(member => ({
        label: member.displayName.slice(0, 100),
        value: member.id,
        description: `@${member.user.username}`.slice(0, 100),
        default: member.id === draft.targetId,
      })));
  }

  const rows = [new ActionRowBuilder().addComponents(select)];

  const inputButtons = [
    new ButtonBuilder().setCustomId('bank_transfer_amount').setLabel('金額を入力').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bank_transfer_note').setLabel('ひとことを入力').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bank_transfer_search').setLabel(draft.search ? '検索を変更' : '宛先を検索').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
  ];
  if (totalPages > 1) {
    inputButtons.push(
      new ButtonBuilder().setCustomId('bank_transfer_prev').setLabel('◀ 前の25人').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('bank_transfer_next').setLabel('次の25人 ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    );
  }
  rows.push(new ActionRowBuilder().addComponents(inputButtons));

  const finalButtons = [];
  if (isBankDraftComplete(draft)) {
    finalButtons.push(new ButtonBuilder().setCustomId('bank_transfer_submit').setLabel('送信').setEmoji('📨').setStyle(ButtonStyle.Success));
  }
  finalButtons.push(new ButtonBuilder().setCustomId('bank_transfer_cancel').setLabel('キャンセル').setStyle(ButtonStyle.Danger));
  rows.push(new ActionRowBuilder().addComponents(finalButtons));

  return rows;
}

async function renderBankTransferForm(interaction, draft, { isUpdate }) {
  const targets = await getBankTransferTargets(interaction.guild, interaction.user.id, draft.search);
  const payload = {
    embeds: [buildBankTransferEmbed(interaction.guild, draft)],
    components: buildBankTransferComponents(draft, targets),
  };

  if (isUpdate) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

function buildGrantLogEmbed({ executorId, targetId, amount, balance, unit }) {
  return new EmbedBuilder()
    .setTitle('💎 通貨付与ログ')
    .setColor(0xfee75c)
    .addFields(
      { name: '実行者', value: `<@${executorId}>`, inline: true },
      { name: '対象ユーザー', value: `<@${targetId}>`, inline: true },
      { name: '付与金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '付与後残高', value: `${balance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();
}

function buildRoleVoiceTimeRewardLogEmbed({ userId, roleId, totalSeconds, requiredSeconds, periodDays, amount, balance, unit }) {
  return new EmbedBuilder()
    .setTitle('ロールVC時間 報酬ログ')
    .setColor(0x57f287)
    .addFields(
      { name: '対象ユーザー', value: `<@${userId}>`, inline: true },
      { name: '対象ロール', value: `<@&${roleId}>`, inline: true },
      { name: '集計期間', value: periodDays > 0 ? `直近${periodDays}日` : '累計（一回のみ）', inline: true },
      { name: '達成時間', value: formatDuration(totalSeconds), inline: true },
      { name: '必要時間', value: formatDuration(requiredSeconds), inline: true },
      { name: '報酬', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '付与後残高', value: `${balance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();
}

function buildDeductionLogEmbed({ executorId, targetId, amount, balance, unit }) {
  return new EmbedBuilder()
    .setTitle('📉 通貨減額ログ')
    .setColor(0xed4245)
    .addFields(
      { name: '実行者', value: `<@${executorId}>`, inline: true },
      { name: '対象ユーザー', value: `<@${targetId}>`, inline: true },
      { name: '減額金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
      { name: '減額後残高', value: `${balance.toLocaleString()} ${unit}`, inline: true },
    )
    .setTimestamp();
}

function buildInterviewLogEmbed({ executorId, successCount, grantAmount, removeRoleId, addRoleId, users, unit }) {
  return new EmbedBuilder()
    .setTitle('🎉 面接通過ログ')
    .setColor(0x57f287)
    .addFields(
      { name: '実行者', value: `<@${executorId}>`, inline: true },
      { name: '処理人数', value: `${successCount}人`, inline: true },
      { name: '付与金額（一人当たり）', value: `${grantAmount.toLocaleString()} ${unit}`, inline: true },
      { name: '外したロール', value: `<@&${removeRoleId}>`, inline: true },
      { name: '付与したロール', value: `<@&${addRoleId}>`, inline: true },
      { name: '対象ユーザー', value: users.length > 0 ? users.map(id => `<@${id}>`).join('\n') : 'なし', inline: false },
    )
    .setTimestamp();
}

async function sendPagedEmbeds(interaction, embeds, hidden) {
  const flags = hidden ? MessageFlags.Ephemeral : undefined;
  const first = embeds.slice(0, 10);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: first });
  } else {
    await interaction.reply({ embeds: first, flags });
  }

  for (let i = 10; i < embeds.length; i += 10) {
    await interaction.followUp({ embeds: embeds.slice(i, i + 10), flags });
  }
}

client.once('ready', async (c) => {
  console.log(`ログイン成功: ${c.user.tag}`);
  await registerCommands();
  await reconcileLevelingSessions().catch(error => console.error('レベリング再同期エラー:', error));
  await reconcileRoleVoiceTimeSessions().catch(error => console.error('ロール別VC時間再同期エラー:', error));
  await processRoleVoiceTimeRewards().catch(error => console.error('ロール別VC時間報酬エラー:', error));
  await processVendingExpirations().catch(error => console.error('自販機期限処理エラー:', error));
  await processVcVendingExpirations().catch(error => console.error('VC自販機期限処理エラー:', error));
  await processEvaluationCheckins().catch(error => console.error('仮メンバー中間確認エラー:', error));
  const interval = setInterval(() => {
    processActiveLevelingSessions().catch(error => console.error('レベリング定期同期エラー:', error));
    processRoleVoiceTimeRewards().catch(error => console.error('ロール別VC時間報酬エラー:', error));
    processEvaluationCheckins().catch(error => console.error('仮メンバー中間確認エラー:', error));
  }, 5 * 60 * 1000);
  interval.unref();

  const vendingInterval = setInterval(() => {
    processVendingExpirations().catch(error => console.error('自販機期限処理エラー:', error));
    processVcVendingExpirations().catch(error => console.error('VC自販機期限処理エラー:', error));
  }, 60 * 1000);
  vendingInterval.unref();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id;
  const now = Date.now();

  if (newState.member?.user?.bot) return;

  try {
    const joined = !oldState.channelId && !!newState.channelId;
    const left = !!oldState.channelId && !newState.channelId;
    const moved = !!oldState.channelId && !!newState.channelId && oldState.channelId !== newState.channelId;

    if (!joined && !left && !moved) return;

    const voiceMember = newState.member || oldState.member || await newState.guild.members.fetch(newState.id).catch(() => null);
    if (voiceMember) {
      syncRoleVoiceTimeSession(voiceMember, newState.channelId, now);
    }

    if (joined) {
      if (!isLevelingTargetChannel(guildId, newState.channelId)) return;
      db.upsertLevelingSession(newState.id, guildId, newState.channelId, now);
      if (newState.member) {
        await syncMemberLevelingRoles(newState.member, now);
      }
      return;
    }

    if (moved) {
      const session = db.getActiveLevelingSession(newState.id, guildId);
      if (isLevelingTargetChannel(guildId, newState.channelId)) {
        if (session) {
          db.updateLevelingSessionChannel(newState.id, guildId, newState.channelId);
        } else {
          db.upsertLevelingSession(newState.id, guildId, newState.channelId, now);
        }
      } else if (session) {
        db.addLevelingSeconds(newState.id, guildId, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
        db.deleteLevelingSession(newState.id, guildId);
      }

      if (newState.member && isLevelingTargetChannel(guildId, newState.channelId)) {
        await syncMemberLevelingRoles(newState.member, now);
      } else if (oldState.member) {
        await syncMemberLevelingRoles(oldState.member, now);
      }
      return;
    }

    if (left) {
      const session = db.getActiveLevelingSession(oldState.id, guildId);
      if (session) {
        db.addLevelingSeconds(oldState.id, guildId, Math.max(0, Math.floor((now - session.joined_at) / 1000)));
        db.deleteLevelingSession(oldState.id, guildId);
      }

      const member = oldState.member || await oldState.guild.members.fetch(oldState.id).catch(() => null);
      if (member) {
        await syncMemberLevelingRoles(member, now);
      }
    }
  } catch (error) {
    console.error('voiceStateUpdate レベリングエラー:', error);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.user.bot) return;
  try {
    syncRoleVoiceTimeSession(newMember, newMember.voice.channelId, Date.now());
  } catch (error) {
    console.error('ロール別VC時間ロール更新エラー:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (interaction.isButton() && interaction.customId.startsWith('eval_checkin:')) {
    try {
      await handleEvaluationCheckinButton(interaction);
    } catch (error) {
      console.error('仮メンバー中間確認ボタンエラー:', error);
      const payload = { content: '❌ 処理中にエラーが発生しました。サーバーの担当者にお問い合わせください。' };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => null);
      } else {
        await interaction.reply(payload).catch(() => null);
      }
    }
    return;
  }

  if (!interaction.guild) return;

  try {
    if (interaction.isButton() && interaction.customId.startsWith('boxgacha:')) {
      await handleGachaButtonInteraction(interaction, {
        db,
        getUnit,
        isTextBasedChannel,
        sendToConfiguredChannel,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vending_buy:')) {
      const [prefix, panelKeyRaw, slotRaw] = interaction.customId.split(':');
      if (prefix !== 'vending_buy') return;

      const panelKey = normalizeVendingPanelKey(panelKeyRaw);
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ 無効なパネルIDです。', flags: MessageFlags.Ephemeral });
        return;
      }
      const slot = Number(slotRaw);
      const panel = db.getVendingPanel(interaction.guild.id, panelKey);
      if (!panel || panel.message_id !== interaction.message.id || panel.channel_id !== interaction.channelId) {
        await interaction.reply({ content: '❌ この自販機パネルは無効です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const product = db.getVendingProduct(interaction.guild.id, panelKey, slot);
      if (!product) {
        await interaction.reply({ content: '❌ この商品は現在購入できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const member = interaction.member;
      if (!member || member.user.bot) {
        await interaction.reply({ content: '❌ 購入できませんでした。', flags: MessageFlags.Ephemeral });
        return;
      }

      const beforeBalance = db.getBalance(member.id, interaction.guild.id);
      if (beforeBalance < product.price) {
        await interaction.reply({ content: `❌ 残高不足です。必要: ${product.price.toLocaleString()} ${getUnit(interaction.guild.id)}`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      db.subtractBalance(member.id, interaction.guild.id, product.price);
      try {
        await member.roles.add(product.role_id);
      } catch (_) {
        db.addBalance(member.id, interaction.guild.id, product.price);
        await interaction.editReply({ content: '❌ ロール付与に失敗したため購入をキャンセルしました。' });
        return;
      }

      const currentPurchase = db.getVendingPurchase(interaction.guild.id, member.id, product.role_id);
      const baseTime = currentPurchase ? Math.max(Date.now(), currentPurchase.expires_at) : Date.now();
      const expiresAt = baseTime + (product.duration_minutes * 60 * 1000);
      db.upsertVendingPurchase(interaction.guild.id, member.id, product.role_id, expiresAt);

      const unit = getUnit(interaction.guild.id);
      const afterBalance = db.getBalance(member.id, interaction.guild.id);
      await interaction.editReply({
        content: [
          `✅ **${product.label}** を購入しました。（パネル: ${panelKey}）`,
          `付与ロール: <@&${product.role_id}>`,
          `期限: ${formatDateTime(expiresAt)}（${product.duration_minutes}分）`,
          `残高: ${afterBalance.toLocaleString()} ${unit}`,
        ].join('\n'),
      });

      const logChannelId = db.getVendingLogChannel(interaction.guild.id, panelKey);
      await sendToConfiguredChannel(interaction.guild, logChannelId, {
        embeds: [buildVendingPurchaseLogEmbed({
          buyerId: member.id,
          roleId: product.role_id,
          label: product.label,
          price: product.price,
          durationMinutes: product.duration_minutes,
          expiresAt,
          unit,
        })],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_vending_buy:')) {
      const [prefix, panelKeyRaw, slotRaw] = interaction.customId.split(':');
      if (prefix !== 'vc_vending_buy') return;

      const panelKey = normalizeVendingPanelKey(panelKeyRaw);
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ 無効なパネルIDです。', flags: MessageFlags.Ephemeral });
        return;
      }
      const slot = Number(slotRaw);
      const panel = db.getVcVendingPanel(interaction.guild.id, panelKey);
      if (!panel || panel.message_id !== interaction.message.id || panel.channel_id !== interaction.channelId) {
        await interaction.reply({ content: '❌ このVC自販機パネルは無効です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const product = db.getVcVendingProduct(interaction.guild.id, panelKey, slot);
      if (!product) {
        await interaction.reply({ content: '❌ この商品は現在購入できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const member = interaction.member;
      if (!member || member.user.bot) {
        await interaction.reply({ content: '❌ 購入できませんでした。', flags: MessageFlags.Ephemeral });
        return;
      }

      const category = interaction.guild.channels.cache.get(product.category_id || product.voice_channel_id);
      const visibilityRoleIds = parseVisibilityRoleIds(product.visibility_role_id).filter(id => interaction.guild.roles.cache.has(id));
      if (!category || category.type !== ChannelType.GuildCategory || visibilityRoleIds.length === 0) {
        await interaction.reply({ content: '❌ 商品のカテゴリまたは公開ロールが存在しないため購入できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const beforeBalance = db.getBalance(member.id, interaction.guild.id);
      if (beforeBalance < product.price) {
        await interaction.reply({ content: `❌ 残高不足です。必要: ${product.price.toLocaleString()} ${getUnit(interaction.guild.id)}`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      db.subtractBalance(member.id, interaction.guild.id, product.price);

      let effectiveVoiceChannelId = product.voice_channel_id;
      let effectiveTextChannelId = null;
      let isTemporaryRoom = 0;
      let privateRoom = null;
      try {
        const existingPurchase = db.getVcVendingPurchaseByBuyerAndTemplate(interaction.guild.id, member.id, product.category_id || product.voice_channel_id);
        const isInExistingRoom = existingPurchase && existingPurchase.is_temporary && member.voice.channelId === existingPurchase.voice_channel_id;

        if (isInExistingRoom) {
          effectiveVoiceChannelId = existingPurchase.voice_channel_id;
          effectiveTextChannelId = existingPurchase.text_channel_id || null;
          isTemporaryRoom = 1;
        } else {
          const expiresAtForRoom = Date.now() + (product.duration_minutes * 60 * 1000);
          privateRoom = await createPrivateRoomFromTemplate(
            interaction.guild,
            member,
            category,
            product.label,
            expiresAtForRoom,
            product.visibility_mode === 'public' ? visibilityRoleIds : [],
            product.user_limit,
            product.extension_price,
            product.extension_duration_minutes,
            getUnit(interaction.guild.id),
            product.visibility_mode,
          );
          effectiveVoiceChannelId = privateRoom.voiceChannel.id;
          effectiveTextChannelId = privateRoom.textChannel.id;
          isTemporaryRoom = 1;
        }
      } catch (error) {
        console.error('VC自販機 一時VC作成エラー:', error);
        db.addBalance(member.id, interaction.guild.id, product.price);
        await interaction.editReply({ content: '❌ VC設定の変更に失敗したため購入をキャンセルしました。BOTの権限を確認してください。' });
        return;
      }

      const currentPurchase = db.getVcVendingPurchase(interaction.guild.id, effectiveVoiceChannelId);
      const sameMode = currentPurchase && currentPurchase.mode === product.visibility_mode && Number(currentPurchase.is_temporary) === isTemporaryRoom;
      const baseTime = sameMode ? Math.max(Date.now(), currentPurchase.expires_at) : Date.now();
      const expiresAt = baseTime + (product.duration_minutes * 60 * 1000);
      db.upsertVcVendingPurchase(interaction.guild.id, effectiveVoiceChannelId, product.visibility_mode, member.id, expiresAt, isTemporaryRoom, product.category_id || product.voice_channel_id, effectiveTextChannelId, product.extension_price, product.duration_minutes, product.extension_duration_minutes);

      if (privateRoom?.panelMessage) {
        db.setVcVendingPurchasePanelMessage(interaction.guild.id, effectiveVoiceChannelId, privateRoom.panelMessage.id);
      }

      if (isTemporaryRoom && currentPurchase && sameMode && member.voice.channelId === currentPurchase.voice_channel_id) {
        const extendMessage = `✅ 部屋の利用時間を延長しました。\n延長後の終了時刻: ${formatDateTime(expiresAt)}`;
        await sendPrivateRoomNotice(interaction.guild, effectiveVoiceChannelId, extendMessage).catch(() => null);
      }

      const unit = getUnit(interaction.guild.id);
      const afterBalance = db.getBalance(member.id, interaction.guild.id);
      await interaction.editReply({
        content: [
          `✅ **${product.label}** を購入しました。（パネル: ${panelKey}）`,
          `対象VC: <#${effectiveVoiceChannelId}>`,
          `設定: ${getVcVisibilityLabel(product.visibility_mode)}`,
          `期限: ${formatDateTime(expiresAt)}（${product.duration_minutes}分）`,
          `残高: ${afterBalance.toLocaleString()} ${unit}`,
        ].join('\n'),
      });

      const logChannelId = db.getVcVendingLogChannel(interaction.guild.id, panelKey);
      await sendToConfiguredChannel(interaction.guild, logChannelId, {
        embeds: [buildVcVendingPurchaseLogEmbed({
          buyerId: member.id,
          label: product.label,
          voiceChannelId: effectiveVoiceChannelId,
          visibilityMode: product.visibility_mode,
          price: product.price,
          durationMinutes: product.duration_minutes,
          expiresAt,
          unit,
        })],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_extend:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_extend') return;

      if (!(await ensurePrivateRoomOwner(interaction, voiceChannelId, ownerId))) return;

      const purchase = db.getVcVendingPurchase(interaction.guild.id, voiceChannelId);
      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!purchase || !purchase.is_temporary || !voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ この一時VCはすでに削除されています。', flags: MessageFlags.Ephemeral });
        return;
      }

      const extensionPrice = Math.max(1, Number(purchase.extension_price) || 1);
      const durationMinutes = Math.max(1, Number(purchase.extension_duration_minutes) || 1);
      const balance = db.getBalance(interaction.user.id, interaction.guild.id);
      if (balance < extensionPrice) {
        await interaction.reply({ content: `❌ 残高不足です。延長料金: ${extensionPrice.toLocaleString()} ${getUnit(interaction.guild.id)}`, flags: MessageFlags.Ephemeral });
        return;
      }

      db.subtractBalance(interaction.user.id, interaction.guild.id, extensionPrice);
      const expiresAt = Math.max(Date.now(), Number(purchase.expires_at)) + (durationMinutes * 60 * 1000);
      if (db.extendVcVendingPurchase(interaction.guild.id, voiceChannelId, expiresAt) === 0) {
        db.addBalance(interaction.user.id, interaction.guild.id, extensionPrice);
        await interaction.reply({ content: '❌ VCの期限更新に失敗しました。', flags: MessageFlags.Ephemeral });
        return;
      }

      const unit = getUnit(interaction.guild.id);
      await interaction.reply({
        content: `✅ VCを${durationMinutes}分延長しました。期限: ${formatDateTime(expiresAt)}`,
        flags: MessageFlags.Ephemeral,
      });
      await sendPrivateRoomNotice(
        interaction.guild,
        voiceChannelId,
        '✅ VCの期限を更新しました。',
        [buildPrivateVcAccessPanelEmbed(ownerId, expiresAt, extensionPrice, durationMinutes, unit, purchase.mode)],
        buildPrivateVcAccessPanelComponents(voiceChannelId, ownerId),
      ).then(async (message) => {
        await deletePrivateRoomPanelMessage(interaction.guild, voiceChannelId, purchase.panel_message_id);
        if (message) {
          db.setVcVendingPurchasePanelMessage(interaction.guild.id, voiceChannelId, message.id);
        }
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_add:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_add') return;

      if (!(await ensurePrivateRoomOwner(interaction, voiceChannelId, ownerId))) return;

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: '追加するユーザーを選択してください。',
        components: buildPrivateVcUserSelectComponents(voiceChannelId, ownerId),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_room_add_select:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_add_select') return;

      if (interaction.user.id !== (db.getVcVendingPurchase(interaction.guild.id, voiceChannelId)?.buyer_id || ownerId)) {
        await interaction.update({ content: '❌ この操作は部屋を購入したユーザーのみ実行できます。', components: [] });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.update({ content: '❌ 対象VCが見つかりません。', components: [] });
        return;
      }

      const addedMentions = [];
      for (const userId of interaction.values) {
        if (userId === ownerId) continue;
        const memberToAdd = interaction.guild.members.cache.get(userId) || await interaction.guild.members.fetch(userId).catch(() => null);
        if (!memberToAdd || memberToAdd.user.bot) continue;

        await channel.permissionOverwrites.edit(userId, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
          Stream: true,
          SendMessages: true,
          ReadMessageHistory: true,
        }).catch(() => null);
        addedMentions.push(`<@${userId}>`);
      }

      await interaction.update({
        content: addedMentions.length > 0
          ? `✅ 追加しました: ${addedMentions.join(' ')}`
          : 'ℹ️ 追加できるユーザーが選択されていませんでした。',
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_remove:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_remove') return;

      if (!(await ensurePrivateRoomOwner(interaction, voiceChannelId, ownerId))) return;

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: '削除するユーザーを選択してください。',
        components: buildPrivateVcRemoveUserSelectComponents(voiceChannelId, ownerId),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_room_remove_select:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_remove_select') return;

      if (interaction.user.id !== (db.getVcVendingPurchase(interaction.guild.id, voiceChannelId)?.buyer_id || ownerId)) {
        await interaction.update({ content: '❌ この操作は部屋を購入したユーザーのみ実行できます。', components: [] });
        return;
      }

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.update({ content: '❌ 対象VCが見つかりません。', components: [] });
        return;
      }

      const removedMentions = [];
      for (const userId of interaction.values) {
        if (userId === ownerId) continue;
        await channel.permissionOverwrites.delete(userId).catch(() => null);
        removedMentions.push(`<@${userId}>`);
      }

      await interaction.update({
        content: removedMentions.length > 0
          ? `✅ 削除しました: ${removedMentions.join(' ')}`
          : 'ℹ️ 削除できるユーザーが選択されていませんでした。',
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vc_room_rename:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_rename') return;

      if (!(await ensurePrivateRoomOwner(interaction, voiceChannelId, ownerId))) return;

      const channel = interaction.guild.channels.cache.get(voiceChannelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`vc_room_rename_modal:${voiceChannelId}:${ownerId}`)
        .setTitle('部屋名変更');

      const input = new TextInputBuilder()
        .setCustomId('room_name')
        .setLabel('新しい部屋名')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setValue(channel.name.replace(/-chat$/i, ''));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('vc_room_rename_modal:')) {
      const [prefix, voiceChannelId, ownerId] = interaction.customId.split(':');
      if (prefix !== 'vc_room_rename_modal') return;

      if (!(await ensurePrivateRoomOwner(interaction, voiceChannelId, ownerId))) return;

      const newNameRaw = interaction.fields.getTextInputValue('room_name').trim();
      if (!newNameRaw) {
        await interaction.reply({ content: '❌ 部屋名を入力してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const purchase = db.getVcVendingPurchase(interaction.guild.id, voiceChannelId);
      if (!purchase || !purchase.is_temporary) {
        await interaction.reply({ content: '❌ 秘密VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
      const textChannel = purchase.text_channel_id ? interaction.guild.channels.cache.get(purchase.text_channel_id) : null;
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ 対象VCが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const safeVoiceName = newNameRaw.slice(0, 90);
      const safeTextName = `${safeVoiceName}-chat`.slice(0, 100);

      await voiceChannel.setName(safeVoiceName, 'VC自販機の部屋名変更').catch(() => null);
      if (textChannel && textChannel.id !== voiceChannel.id && textChannel.type === ChannelType.GuildText) {
        await textChannel.setName(safeTextName, 'VC自販機の部屋名変更').catch(() => null);
      }

      await interaction.reply({ content: `✅ 部屋名を **${safeVoiceName}** に変更しました。`, flags: MessageFlags.Ephemeral });
      if (textChannel && isTextBasedChannel(textChannel)) {
        await textChannel.send(`✅ 部屋名を **${safeVoiceName}** に変更しました。`).catch(() => null);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_balance') {
      const unit = getUnit(interaction.guild.id);
      const balance = db.getBalance(interaction.user.id, interaction.guild.id);
      await interaction.reply({
        content: `💰 現在の残高: **${balance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_transfer_start') {
      bankTransferDrafts.delete(getBankDraftKey(interaction.guild.id, interaction.user.id));
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      await renderBankTransferForm(interaction, draft, { isUpdate: false });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'bank_transfer_target') {
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      draft.targetId = interaction.values[0];
      await renderBankTransferForm(interaction, draft, { isUpdate: true });
      return;
    }

    if (interaction.isButton() && (interaction.customId === 'bank_transfer_prev' || interaction.customId === 'bank_transfer_next')) {
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      draft.page += interaction.customId === 'bank_transfer_next' ? 1 : -1;
      await renderBankTransferForm(interaction, draft, { isUpdate: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_transfer_amount') {
      const modal = new ModalBuilder()
        .setCustomId('bank_transfer_amount_modal')
        .setTitle('送金額の入力')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('金額（半角数字のみ）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(15),
        ));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_transfer_note') {
      const modal = new ModalBuilder()
        .setCustomId('bank_transfer_note_modal')
        .setTitle('ひとことの入力')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('ひとこと（1文字以上）')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500),
        ));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'bank_transfer_amount_modal') {
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      const raw = interaction.fields.getTextInputValue('amount').trim();

      if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
        await interaction.reply({ content: '❌ 金額は0〜9の半角数字のみで、1以上を入力してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      draft.amount = Number(raw);
      await renderBankTransferForm(interaction, draft, { isUpdate: interaction.isFromMessage() });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'bank_transfer_note_modal') {
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      const note = interaction.fields.getTextInputValue('note').trim();

      if (note.length < 1) {
        await interaction.reply({ content: '❌ ひとことは1文字以上で入力してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      draft.note = note;
      await renderBankTransferForm(interaction, draft, { isUpdate: interaction.isFromMessage() });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_transfer_search') {
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      const modal = new ModalBuilder()
        .setCustomId('bank_transfer_search_modal')
        .setTitle('宛先の検索')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('keyword')
            .setLabel('名前の一部（空欄で検索解除）')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(draft.search || '')
            .setMaxLength(50),
        ));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'bank_transfer_search_modal') {
      const draft = getBankDraft(interaction.guild.id, interaction.user.id);
      draft.search = interaction.fields.getTextInputValue('keyword').trim();
      draft.page = 0;
      await renderBankTransferForm(interaction, draft, { isUpdate: interaction.isFromMessage() });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_transfer_cancel') {
      bankTransferDrafts.delete(getBankDraftKey(interaction.guild.id, interaction.user.id));
      await interaction.update({ content: '送金をキャンセルしました。', embeds: [], components: [] });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'bank_transfer_submit') {
      const guild = interaction.guild;
      const draft = getBankDraft(guild.id, interaction.user.id);

      if (!isBankDraftComplete(draft)) {
        await interaction.reply({ content: '❌ 「宛先」「金額」「ひとこと」をすべて入力してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      if (draft.targetId === interaction.user.id) {
        await interaction.reply({ content: '❌ 自分自身への送金はできません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetMember = guild.members.cache.get(draft.targetId) || await guild.members.fetch(draft.targetId).catch(() => null);
      if (!targetMember || targetMember.user.bot) {
        await interaction.reply({ content: '❌ 宛先のユーザーが見つかりません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const amount = draft.amount;
      const note = draft.note;
      const result = db.transfer(interaction.user.id, targetMember.id, guild.id, amount);
      if (!result.success) {
        await interaction.reply({ content: '❌ 残高が不足しています。', flags: MessageFlags.Ephemeral });
        return;
      }

      const senderBalance = db.getBalance(interaction.user.id, guild.id);
      const receiverBalance = db.getBalance(targetMember.id, guild.id);
      const unit = getUnit(guild.id);

      bankTransferDrafts.delete(getBankDraftKey(guild.id, interaction.user.id));

      await interaction.update({
        content: `✅ ${targetMember.displayName}に${amount.toLocaleString()}${unit}送金しました。\n残高: **${senderBalance.toLocaleString()} ${unit}**`,
        embeds: [],
        components: [],
      });

      const settings = db.getSettings(guild.id);
      await sendLogToChannelOrForum(
        guild,
        settings.transfer_log_channel_id || settings.log_channel_id,
        {
          content: `${interaction.member?.displayName || interaction.user.username}が${targetMember.displayName}に${amount.toLocaleString()}${unit}送金しました。`,
          embeds: [buildTransferLogEmbed({
            userId: interaction.user.id,
            targetId: targetMember.id,
            amount,
            senderBalance,
            receiverBalance,
            unit,
            note,
          })],
        },
        '送金ログ',
      );
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'eval_checkin_message_modal') {
      const message = interaction.fields.getTextInputValue('message').trim();
      db.setEvaluationCheckinMessage(interaction.guild.id, message);
      await interaction.reply({ content: '✅ 仮メンバー中間確認DMの本文を更新しました。', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;

    if (commandName === '商品購入設定') {
      const subcommand = interaction.options.getSubcommand(true);
      const logChannel = interaction.options.getChannel('ログチャンネル', true);
      const enabled = interaction.options.getBoolean('使用可能', true);

      if (subcommand === 'お問い合わせ') {
        const itemKey = interaction.options.getString('受付id', true).trim().toLowerCase();
        const item = communityDb.getInquiryForumItem(guild.id, itemKey);
        if (!item) {
          await interaction.reply({ content: `❌ お問い合わせ受付 **${itemKey}** が見つかりません。`, flags: MessageFlags.Ephemeral });
          return;
        }

        communityDb.setInquiryPurchaseSettings(guild.id, itemKey, logChannel.id, enabled);
        await interaction.reply({
          content: `✅ 受付 **${itemKey}** の商品購入を **${enabled ? '使用可能' : '使用不可'}** に設定しました。\n購入ログ: <#${logChannel.id}>`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const panelId = interaction.options.getInteger('パネルid', true);
      const panel = communityDb.getTicketPanel(panelId);
      if (!panel || panel.guild_id !== guild.id) {
        await interaction.reply({ content: `❌ チケットパネル **${panelId}** が見つかりません。`, flags: MessageFlags.Ephemeral });
        return;
      }

      communityDb.setTicketPurchaseSettings(guild.id, panelId, logChannel.id, enabled);
      await interaction.reply({
        content: `✅ チケットパネル **${panelId}** の商品購入を **${enabled ? '使用可能' : '使用不可'}** に設定しました。\n購入ログ: <#${logChannel.id}>`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '商品購入') {
      const ticket = communityDb.getTicketByChannel(interaction.channelId);
      const inquiryTicket = communityDb.getInquiryForumTicketByChannel(interaction.channelId);
      if (!ticket && !inquiryTicket) {
        await interaction.reply({ content: '❌ このコマンドはお問い合わせチケット内でのみ使用できます。', flags: MessageFlags.Ephemeral });
        return;
      }

      const amount = interaction.options.getInteger('金額', true);
      const productName = interaction.options.getString('商品名', true).trim();
      const ticketId = ticket ? `ticket-${ticket.id}` : `inquiry-${inquiryTicket.id}`;
      const purchaseConfig = ticket
        ? communityDb.getTicketPanel(ticket.panel_id)
        : communityDb.getInquiryForumItem(guild.id, inquiryTicket.item_key);
      if (!purchaseConfig?.purchase_enabled) {
        await interaction.reply({ content: '❌ このチケットでは商品購入を使用できません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const logChannelId = purchaseConfig.purchase_log_channel_id;
      if (!logChannelId) {
        await interaction.reply({ content: '❌ このお問い合わせには購入ログの保存先が設定されていません。管理者に設定を依頼してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const balance = db.getBalance(interaction.user.id, guild.id);
      const unit = getUnit(guild.id);
      if (balance < amount) {
        await interaction.reply({
          content: `❌ 残高が不足しています。\n必要額: **${amount.toLocaleString()} ${unit}**\n現在の残高: **${balance.toLocaleString()} ${unit}**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      db.subtractBalance(interaction.user.id, guild.id, amount);
      const remainingBalance = db.getBalance(interaction.user.id, guild.id);
      const purchaseEmbed = new EmbedBuilder()
        .setTitle('🛒 商品購入ログ')
        .setColor(0x57f287)
        .addFields(
          { name: '商品名', value: productName, inline: false },
          { name: '金額', value: `${amount.toLocaleString()} ${unit}`, inline: true },
          { name: '購入者', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'チケット', value: `<#${interaction.channelId}>`, inline: true },
          { name: '購入後残高', value: `${remainingBalance.toLocaleString()} ${unit}`, inline: true },
          { name: 'チケットID', value: ticketId, inline: true },
        )
        .setTimestamp();

      await sendLogToChannelOrForum(
        guild,
        logChannelId,
        {
          content: `🛒 <@${interaction.user.id}> が商品を購入しました。`,
          embeds: [purchaseEmbed],
        },
        '商品購入ログ',
      );

      await interaction.reply({
        content: `✅ **${productName}** を購入しました。\n支払額: **${amount.toLocaleString()} ${unit}**\n購入後残高: **${remainingBalance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (isGachaCommandName(commandName)) {
      const handled = await handleGachaCommand(interaction, {
        db,
        getUnit,
        parseNewlines,
        isTextBasedChannel,
        sendToConfiguredChannel,
      });
      if (handled) {
        return;
      }
    }

    if (commandName === 'bankパネル設置') {
      const channel = interaction.options.getChannel('チャンネル', true);
      const title = interaction.options.getString('タイトル') || '🏦 BANK';
      const description = parseNewlines(interaction.options.getString('説明') || '送金・残高確認ができます。\n下のボタンから操作してください。');

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const message = await channel.send({
        embeds: [buildBankPanelEmbed(guild, title, description)],
        components: buildBankPanelComponents(),
      });
      db.upsertBankPanel(guild.id, channel.id, message.id, title, description);

      await interaction.editReply({ content: `✅ bankパネルを <#${channel.id}> に設置しました。` });
      return;
    }

    if (commandName === '送金可能ロール設定') {
      const selected = [];
      for (let i = 1; i <= 10; i += 1) {
        const role = interaction.options.getRole(`ロール${i}`);
        if (role) selected.push(role.id);
      }

      const roleIds = db.setBankTransferRoles(guild.id, selected);
      await interaction.reply({
        content: roleIds.length > 0
          ? `✅ 送金可能ロールを設定しました。\n${roleIds.map(id => `<@&${id}>`).join(' ')}`
          : '✅ 送金可能ロールの設定をすべて解除しました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '送金ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setTransferLogChannel(guild.id, channel.id);
      if (channel.type === ChannelType.GuildForum) {
        await ensureForumLogThread(guild, channel, '送金ログ');
      }
      await interaction.reply({ content: `✅ bankパネルの送金ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '付与ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setGrantLogChannel(guild.id, channel.id);
      if (channel.type === ChannelType.GuildForum) {
        await ensureForumLogThread(guild, channel, '付与ログ');
      }
      await interaction.reply({ content: `✅ 付与ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '減額ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setDeductionLogChannel(guild.id, channel.id);
      if (channel.type === ChannelType.GuildForum) {
        await ensureForumLogThread(guild, channel, '減額ログ');
      }
      await interaction.reply({ content: `✅ 減額ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '通貨サポートロール設定') {
      const role = interaction.options.getRole('ロール', true);
      db.addCurrencySupportRole(guild.id, role.id);
      await interaction.reply({ content: `✅ <@&${role.id}> を通貨サポートロールとして設定しました。\n以後、このロールを持つメンバーは /付与 /減額 を実行できます。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '通貨単位設定') {
      const unit = interaction.options.getString('単位', true);
      db.setCurrencyUnit(guild.id, unit);
      await interaction.reply({ content: `✅ 通貨単位を **${unit}** に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '自販機パネル設置') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel('チャンネル', true);
      const title = interaction.options.getString('タイトル', true);
      const description = parseNewlines(interaction.options.getString('説明', true));

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const panel = {
        panel_key: panelKey,
        title,
        description,
      };
      const message = await channel.send({
        embeds: [buildVendingPanelEmbed(guild, panel)],
        components: buildVendingPanelComponents(guild.id, panelKey),
      });

      db.upsertVendingPanel(guild.id, panelKey, channel.id, message.id, title, description);
      await interaction.editReply({ content: `✅ 自販機パネルを設置しました。\nパネルID: ${panelKey}\nチャンネル: <#${channel.id}>\nメッセージID: ${message.id}` });
      return;
    }

    if (commandName === '自販機パネル削除') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const panel = db.getVendingPanel(guild.id, panelKey);
      if (!panel) {
        await interaction.reply({ content: `❌ パネル ${panelKey} は存在しません。`, flags: MessageFlags.Ephemeral });
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

      const result = db.deleteVendingPanel(guild.id, panelKey);
      await interaction.reply({
        content: [
          '✅ 自販機パネルを削除しました。',
          `パネルID: ${panelKey}`,
          `商品削除数: ${result.productsDeleted}件`,
          `パネルメッセージ削除: ${panelMessageDeleted ? '成功' : '未削除（既に削除済み/取得不可）'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '自販機商品設定') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === '設定') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const label = interaction.options.getString('商品名', true);
        const role = interaction.options.getRole('ロール', true);
        const price = interaction.options.getInteger('値段', true);
        const duration = interaction.options.getInteger('時間', true);

        db.setVendingProduct(guild.id, panelKey, slot, label, role.id, price, duration);
        await refreshVendingPanel(guild, panelKey);
        await interaction.reply({
          content: `✅ 自販機商品を設定しました。\nパネルID: ${panelKey}\nスロット: ${slot}\n商品名: ${label}\nロール: <@&${role.id}>\n値段: ${price.toLocaleString()} ${getUnit(guild.id)}\n時間: ${duration}分`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '削除') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const changed = db.deleteVendingProduct(guild.id, panelKey, slot);
        await refreshVendingPanel(guild, panelKey);
        await interaction.reply({
          content: changed > 0 ? `✅ パネル ${panelKey} のスロット ${slot} 商品を削除しました。` : `ℹ️ パネル ${panelKey} のスロット ${slot} に商品は設定されていません。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '一覧') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
          return;
        }

        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const hidden = interaction.options.getString('表示') !== 'public';
        const embed = buildVendingProductListEmbed(guild, panelKey);
        await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
        return;
      }
    }

    if (commandName === '自販機ログチャンネル') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setVendingLogChannel(guild.id, panelKey, channel.id);
      await interaction.reply({ content: `✅ パネル ${panelKey} の自販機ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'vc自販機パネル設置') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel('チャンネル', true);
      const title = interaction.options.getString('タイトル', true);
      const description = parseNewlines(interaction.options.getString('説明', true));

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const panel = {
        panel_key: panelKey,
        title,
        description,
      };
      const message = await channel.send({
        embeds: [buildVcVendingPanelEmbed(guild, panel)],
        components: buildVcVendingPanelComponents(guild.id, panelKey),
      });

      db.upsertVcVendingPanel(guild.id, panelKey, channel.id, message.id, title, description);
      await interaction.editReply({ content: `✅ VC自販機パネルを設置しました。\nパネルID: ${panelKey}\nチャンネル: <#${channel.id}>\nメッセージID: ${message.id}` });
      return;
    }

    if (commandName === 'vc自販機パネル削除') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const panel = db.getVcVendingPanel(guild.id, panelKey);
      if (!panel) {
        await interaction.reply({ content: `❌ パネル ${panelKey} は存在しません。`, flags: MessageFlags.Ephemeral });
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

      const result = db.deleteVcVendingPanel(guild.id, panelKey);
      await interaction.reply({
        content: [
          `✅ VC自販機パネルを削除しました。`,
          `パネルID: ${panelKey}`,
          `商品削除数: ${result.productsDeleted}件`,
          `パネルメッセージ削除: ${panelMessageDeleted ? '成功' : '未削除（既に削除済み/取得不可）'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'vc自販機商品設定') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === '設定') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const label = interaction.options.getString('商品名', true);
        const category = interaction.options.getChannel('カテゴリ', true);
        const visibilityRoleIds = [
          interaction.options.getRole('公開ロール', true),
          interaction.options.getRole('公開ロール2'),
          interaction.options.getRole('公開ロール3'),
          interaction.options.getRole('公開ロール4'),
          interaction.options.getRole('公開ロール5'),
        ].filter(Boolean).map(role => role.id);
        const userLimit = interaction.options.getInteger('参加人数', true);
        const visibilityMode = interaction.options.getString('公開設定', true);
        const price = interaction.options.getInteger('値段', true);
        const extensionPrice = interaction.options.getInteger('延長料金', true);
        const extensionDuration = interaction.options.getInteger('延長時間', true);
        const duration = interaction.options.getInteger('時間', true);

        if (category.type !== ChannelType.GuildCategory) {
          await interaction.reply({ content: '❌ カテゴリにはボイスチャンネルカテゴリを指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }

        db.setVcVendingProduct(guild.id, panelKey, slot, label, category.id, visibilityRoleIds, userLimit, visibilityMode, price, extensionPrice, duration, extensionDuration);
        await refreshVcVendingPanel(guild, panelKey);
        await interaction.reply({
          content: `✅ VC自販機商品を設定しました。\nパネルID: ${panelKey}\nスロット: ${slot}\n商品名: ${label}\n作成先: <#${category.id}>\n公開ロール: ${[...new Set(visibilityRoleIds)].map(id => `<@&${id}>`).join(' ')}\n参加人数: ${userLimit > 0 ? `${userLimit}人` : '無制限'}\n設定: ${getVcVisibilityLabel(visibilityMode)}\n値段: ${price.toLocaleString()} ${getUnit(guild.id)}\n延長料金: ${extensionPrice.toLocaleString()} ${getUnit(guild.id)}\n延長時間: ${extensionDuration}分\n時間: ${duration}分`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '削除') {
        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const slot = interaction.options.getInteger('スロット', true);
        const changed = db.deleteVcVendingProduct(guild.id, panelKey, slot);
        await refreshVcVendingPanel(guild, panelKey);
        await interaction.reply({
          content: changed > 0 ? `✅ パネル ${panelKey} のスロット ${slot} 商品を削除しました。` : `ℹ️ パネル ${panelKey} のスロット ${slot} に商品は設定されていません。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '一覧') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
          return;
        }

        const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
        if (!isValidVendingPanelKey(panelKey)) {
          await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
          return;
        }
        const hidden = interaction.options.getString('表示') !== 'public';
        const embed = buildVcVendingProductListEmbed(guild, panelKey);
        await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
        return;
      }
    }

    if (commandName === 'vc自販機ログチャンネル') {
      const panelKey = normalizeVendingPanelKey(interaction.options.getString('パネルid', true));
      if (!isValidVendingPanelKey(panelKey)) {
        await interaction.reply({ content: '❌ パネルIDは英数字・`_`・`-` のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setVcVendingLogChannel(guild.id, panelKey, channel.id);
      await interaction.reply({ content: `✅ パネル ${panelKey} のVC自販機ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '面接通過許可ロール') {
      const role = interaction.options.getRole('ロール', true);
      db.addPermittedRole(guild.id, role.id);
      await interaction.reply({ content: `✅ <@&${role.id}> を /面接通過 の許可ロールとして設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '面接設定') {
      const removeRole = interaction.options.getRole('外すロール', true);
      const addRole = interaction.options.getRole('付与するロール', true);
      const grantAmount = interaction.options.getInteger('付与金額', true);
      db.setInterviewSettings(guild.id, removeRole.id, addRole.id, grantAmount);
      await interaction.reply({
        content: `✅ 面接設定を更新しました。\n外すロール: <@&${removeRole.id}>\n付与するロール: <@&${addRole.id}>\n一人当たり付与金額: **${grantAmount.toLocaleString()} ${getUnit(guild.id)}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '評価期限設定') {
      const days = interaction.options.getInteger('日数', true);
      const role = interaction.options.getRole('対象ロール', true);
      db.setEvaluationSettings(guild.id, days, role.id);
      await interaction.reply({
        content: `✅ 評価期限設定を更新しました。\n評価期限: **${days}日**\n対象ロール: <@&${role.id}>`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '仮メンバー確認設定') {
      const days = interaction.options.getInteger('日数', true);
      const stopRole = interaction.options.getRole('評価終了ロール', false);
      db.setEvaluationCheckinSettings(guild.id, days, stopRole ? stopRole.id : null);
      await interaction.reply({
        content: days > 0
          ? `✅ 仮メンバー中間確認を設定しました。\n送信タイミング: 評価開始から **${days}日後**\n評価終了ロール: ${stopRole ? `<@&${stopRole.id}>` : '未設定'}`
          : '✅ 仮メンバー中間確認DMを無効にしました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '仮メンバー確認文設定') {
      const current = db.getSettings(guild.id).evaluation_checkin_message || DEFAULT_EVALUATION_CHECKIN_MESSAGE;
      const modal = new ModalBuilder()
        .setCustomId('eval_checkin_message_modal')
        .setTitle('仮メンバー中間確認DM本文')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('message')
              .setLabel('本文')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(1800)
              .setPlaceholder('{user} {name} {guild} {deadline} {remaining_days} {days} {checkin_days} が使えます')
              .setValue(current),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (commandName === 'ロール表示除外設定') {
      const role1 = interaction.options.getRole('表示ロール1', false);
      const role2 = interaction.options.getRole('表示ロール2', false);
      const role3 = interaction.options.getRole('表示ロール3', false);
      db.setRoleDisplayIncludeRoles(guild.id, role1 ? role1.id : null, role2 ? role2.id : null, role3 ? role3.id : null);

      const list = [role1, role2, role3].filter(Boolean).map(role => `<@&${role.id}>`);
      await interaction.reply({
        content: list.length > 0
          ? `✅ 対象外メンバーに表示するロールを設定しました。\n${list.join('\n')}`
          : '✅ 対象外メンバーに表示するロール設定を解除しました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '面接通過ログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setInterviewLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ 面接通過ログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'レベリングログチャンネル') {
      const channel = interaction.options.getChannel('チャンネル', true);
      db.setLevelingLogChannel(guild.id, channel.id);
      await interaction.reply({ content: `✅ レベリングログチャンネルを <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'レベリング場所') {
      const channels = [1, 2, 3, 4, 5]
        .map(index => interaction.options.getChannel(`場所${index}`))
        .filter(Boolean);
      db.setLevelingVoiceChannel(guild.id, channels.map(channel => channel.id));
      await reconcileLevelingSessions();
      await interaction.reply({ content: `✅ レベリング対象VCを設定しました。\n${channels.map(channel => `<#${channel.id}>`).join('\n')}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === 'ロールvc時間設定') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const role = interaction.options.getRole('ロール', true);
      const channels = [1, 2, 3, 4, 5]
        .map(index => interaction.options.getChannel(`場所${index}`))
        .filter(Boolean);
      db.setRoleVoiceTimeChannels(guild.id, role.id, channels.map(channel => channel.id));
      await reconcileRoleVoiceTimeSessions();
      await interaction.reply({
        content: `✅ <@&${role.id}> のVC参加時間を、次のVCで計測します。\n${channels.map(channel => `<#${channel.id}>`).join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'ロールvc期間設定') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const role = interaction.options.getRole('ロール', true);
      const days = db.setRoleVoiceTimePeriodDays(guild.id, role.id, interaction.options.getInteger('日数', true));
      await interaction.reply({
        content: days > 0
          ? `✅ <@&${role.id}> のVC参加時間を直近${days}日で集計します。`
          : `✅ <@&${role.id}> のVC参加時間を期間なしの累計で表示します。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'ロールvc報酬設定') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const role = interaction.options.getRole('ロール', true);
      const requiredMinutes = interaction.options.getInteger('必要分', true);
      const amount = interaction.options.getInteger('金額', true);
      const logChannel = interaction.options.getChannel('ログチャンネル');
      const rewardId = db.setRoleVoiceTimeReward(guild.id, role.id, requiredMinutes * 60, amount, logChannel?.id);
      await processRoleVoiceTimeRewards();
      await interaction.reply({
        content: [
          `✅ <@&${role.id}> のロール別VC時間報酬を設定しました。`,
          `報酬ID: ${rewardId}`,
          `必要時間: ${requiredMinutes}分`,
          `報酬: ${amount.toLocaleString()} ${getUnit(guild.id)}`,
          `ログ先: ${logChannel ? `${logChannel}` : '付与ログチャンネル'}`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'ロールvc報酬削除') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const rewardId = interaction.options.getInteger('報酬id', true);
      const deleted = db.deleteRoleVoiceTimeReward(guild.id, rewardId);
      await interaction.reply({
        content: deleted
          ? `✅ 報酬ID ${rewardId} のロール別VC時間報酬を削除しました。`
          : `❌ 報酬ID ${rewardId} は見つかりません。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'ロールvc時間') {
      const targetUser = interaction.options.getUser('ユーザー', true);
      const role = interaction.options.getRole('ロール', true);
      const channels = db.getRoleVoiceTimeChannels(guild.id, role.id);
      if (channels.length === 0) {
        await interaction.reply({ content: `${role} のロール別VC時間は未設定です。`, flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildRoleVoiceTimeEmbed(guild, targetUser, role.id);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === 'ロールvc時間ランキング') {
      const role = interaction.options.getRole('ロール', true);
      const channels = db.getRoleVoiceTimeChannels(guild.id, role.id);
      if (channels.length === 0) {
        await interaction.reply({ content: `${role} のロール別VC時間は未設定です。`, flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildRoleVoiceTimeRankingEmbed(guild, role.id);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === '面接通過') {
      if (!hasPermittedRole(member, guild.id)) {
        await interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const voiceChannel = member.voice.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: '❌ VCに接続してからコマンドを実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      const settings = db.getSettings(guild.id);
      if (!settings.remove_role_id || !settings.add_role_id) {
        await interaction.reply({ content: '❌ 面接設定が行われていません。先に `/面接設定` を実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const vcMembers = voiceChannel.members.filter(m => !m.user.bot);
      const targets = vcMembers.filter(m => m.roles.cache.has(settings.remove_role_id));
      const processedUsers = [];
      let successCount = 0;

      for (const [, vcMember] of targets) {
        try {
          await vcMember.roles.remove(settings.remove_role_id);
          await vcMember.roles.add(settings.add_role_id);
          db.setInterviewEvaluationPassedAt(vcMember.id, guild.id, Date.now());
          if ((settings.grant_amount || 0) > 0) {
            db.addBalance(vcMember.id, guild.id, settings.grant_amount);
          }
          processedUsers.push(vcMember.id);
          successCount++;
        } catch (error) {
          console.error(`メンバー処理エラー (${vcMember.id}):`, error);
        }
      }

      await interaction.editReply({ content: `✅ 面接通過処理が完了しました。\n**${successCount}人** に処理を行いました。` });

      if (processedUsers.length > 0) {
        const settingsAfter = db.getSettings(guild.id);
        await sendToConfiguredChannel(guild, settingsAfter.interview_log_channel_id, {
          embeds: [buildInterviewLogEmbed({
            executorId: interaction.user.id,
            successCount,
            grantAmount: settingsAfter.grant_amount || 0,
            removeRoleId: settingsAfter.remove_role_id,
            addRoleId: settingsAfter.add_role_id,
            users: processedUsers,
            unit: getUnit(guild.id),
          })],
        });
      }
      return;
    }

    if (commandName === '自分') {
      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildLevelingInfoEmbed(member, guild, { showBalance: false });
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === '付与') {
      if (!hasCurrencySupportRole(member, guild.id)) {
        await interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const target = interaction.options.getUser('ユーザー', true);
      const amount = interaction.options.getInteger('金額', true);
      db.addBalance(target.id, guild.id, amount);
      const newBalance = db.getBalance(target.id, guild.id);
      const unit = getUnit(guild.id);

      await interaction.reply({
        content: `✅ <@${target.id}> に **${amount.toLocaleString()} ${unit}** を付与しました。\n<@${target.id}> の残高: **${newBalance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });

      const settings = db.getSettings(guild.id);
      await sendLogToChannelOrForum(
        guild,
        settings.grant_log_channel_id,
        {
          embeds: [buildGrantLogEmbed({
            executorId: interaction.user.id,
            targetId: target.id,
            amount,
            balance: newBalance,
            unit,
          })],
        },
        '付与ログ',
      );
      return;
    }

    if (commandName === '減額') {
      if (!hasCurrencySupportRole(member, guild.id)) {
        await interaction.reply({ content: '❌ このコマンドを実行する権限がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const target = interaction.options.getUser('ユーザー', true);
      const amount = interaction.options.getInteger('金額', true);
      const beforeBalance = db.getBalance(target.id, guild.id);
      const newBalance = db.subtractBalance(target.id, guild.id, amount);
      const deducted = Math.min(amount, beforeBalance);
      const unit = getUnit(guild.id);

      await interaction.reply({
        content: `✅ <@${target.id}> から **${deducted.toLocaleString()} ${unit}** を減額しました。\n<@${target.id}> の残高: **${newBalance.toLocaleString()} ${unit}**`,
        flags: MessageFlags.Ephemeral,
      });

      const settings = db.getSettings(guild.id);
      await sendLogToChannelOrForum(
        guild,
        settings.deduction_log_channel_id,
        {
          embeds: [buildDeductionLogEmbed({
            executorId: interaction.user.id,
            targetId: target.id,
            amount: deducted,
            balance: newBalance,
            unit,
          })],
        },
        '減額ログ',
      );
      return;
    }

    if (commandName === 'レベリング設定') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === '時間設定') {
        const level = interaction.options.getInteger('レベル', true);
        const minutes = interaction.options.getInteger('必要分', true);
        db.setLevelingThreshold(guild.id, level, minutes * 60);
        await interaction.reply({
          content: `✅ レベル **${level} → ${level + 1}** に必要なVC参加時間を **${minutes}分** に設定しました。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '時間一括設定') {
        const startLevel = interaction.options.getInteger('開始レベル', true);
        const minutes = interaction.options.getInteger('必要分', true);
        const endLevel = startLevel + 9;
        db.setLevelingThresholdRange(guild.id, startLevel, endLevel, minutes * 60);
        await interaction.reply({
          content: `✅ レベル **${startLevel}〜${endLevel}** の必要VC参加時間を **${minutes}分** にまとめて設定しました。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'ロール設定') {
        const startLevel = interaction.options.getInteger('開始レベル', true);
        const endLevel = interaction.options.getInteger('終了レベル', true);
        const role = interaction.options.getRole('ロール', true);

        if (startLevel > endLevel) {
          await interaction.reply({ content: '❌ 開始レベルは終了レベル以下にしてください。', flags: MessageFlags.Ephemeral });
          return;
        }

        db.setLevelingRoleRange(guild.id, startLevel, endLevel, role.id);
        await interaction.reply({
          content: `✅ レベル **${startLevel}〜${endLevel}** に <@&${role.id}> を設定しました。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === '表示') {
        await interaction.reply({ embeds: [buildLevelingSettingsEmbed(guild)] });
        return;
      }
    }

    if (commandName === 'ユーザー情報') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', true);
      const hidden = interaction.options.getString('表示') !== 'public';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }

      const targetMember = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);

      if (!targetMember) {
        await interaction.editReply({ content: '❌ 対象ユーザーを取得できませんでした。' });
        return;
      }

      const embed = buildLevelingInfoEmbed(targetMember, guild);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === 'vc接続時間ランキング') {
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildVcConnectionRankingEmbed(guild);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === 'vc接続時間リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', true);
      const beforeSeconds = getEffectiveLevelingSeconds(targetUser.id, guild.id);
      db.setLevelingProfile(targetUser.id, guild.id, 0, 1);
      db.deleteLevelingSession(targetUser.id, guild.id);

      const targetMember = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);
      if (targetMember) {
        await syncMemberLevelingRoles(targetMember, Date.now());
      }

      await interaction.reply({
        content: `✅ <@${targetUser.id}> のVC接続時間をリセットしました。（以前: ${formatDuration(beforeSeconds)}）`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '残高全額リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', true);
      const unit = getUnit(guild.id);
      const beforeBalance = db.getBalance(targetUser.id, guild.id);
      db.setBalance(targetUser.id, guild.id, 0);

      await interaction.reply({
        content: `✅ <@${targetUser.id}> の残高を全額リセットしました。（以前: ${beforeBalance.toLocaleString()} ${unit}）`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === 'vc接続時間全リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      db.resetAllLevelingData(guild.id);

      const now = Date.now();
      let synced = 0;
      for (const [, guildMember] of guild.members.cache) {
        if (guildMember.user.bot) continue;
        await syncMemberLevelingRoles(guildMember, now);
        synced++;
      }

      await interaction.editReply({ content: `✅ 全ユーザーのVC接続時間をリセットしました。対象: ${synced}人` });
      return;
    }

    if (commandName === '残高全額全リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const unit = getUnit(guild.id);
      const changedRows = db.resetAllBalances(guild.id);
      await interaction.reply({
        content: `✅ 全ユーザーの残高を0にリセットしました。更新件数: ${changedRows}件（単位: ${unit}）`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (commandName === '評価リセット') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('ユーザー', false);
      if (targetUser) {
        const changed = db.deleteInterviewEvaluation(targetUser.id, guild.id);
        await interaction.reply({
          content: changed > 0
            ? `✅ <@${targetUser.id}> の評価情報をリセットしました。`
            : `ℹ️ <@${targetUser.id}> の評価情報は登録されていませんでした。`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const changed = db.resetAllInterviewEvaluations(guild.id);
        await interaction.reply({
          content: `✅ 全ユーザーの評価情報をリセットしました。削除件数: ${changed}件`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (commandName === '評価一覧') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示') !== 'public';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }

      const rows = db.getInterviewEvaluations(guild.id);
      const embeds = buildEvaluationListEmbeds(guild, rows);
      await sendPagedEmbeds(interaction, embeds, hidden);
      return;
    }

    if (commandName === '給与設定') {
      const role = interaction.options.getRole('ロール', true);
      const amount = interaction.options.getInteger('金額', true);
      const unit = getUnit(guild.id);
      db.setRoleSalarySetting(guild.id, role.id, amount);
      await interaction.reply({ content: `✅ <@&${role.id}> の給与を **${amount.toLocaleString()} ${unit}** に設定しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '給与設定解除') {
      const role = interaction.options.getRole('ロール', true);
      db.deleteRoleSalarySetting(guild.id, role.id);
      await interaction.reply({ content: `✅ <@&${role.id}> の給与設定を解除しました。`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === '給与設定一覧') {
      const hidden = interaction.options.getString('表示') !== 'public';
      const embed = buildRoleSalarySettingsEmbed(guild);
      await interaction.reply(hidden ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
      return;
    }

    if (commandName === '給与一括付与') {
      const role = interaction.options.getRole('ロール', true);
      const salary = db.getRoleSalarySetting(guild.id, role.id);
      const unit = getUnit(guild.id);

      if (!salary) {
        await interaction.reply({ content: `❌ <@&${role.id}> の給与設定がありません。先に /給与設定 を実行してください。`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await grantRoleSalary(guild, role.id, salary.amount);
      if (!result.success) {
        await interaction.editReply({ content: '❌ 対象ロールが見つかりませんでした。' });
        return;
      }

      await interaction.editReply({ content: `✅ ${result.role} に給与を一括付与しました。対象: ${result.paidCount}人 / 合計: ${result.totalGranted.toLocaleString()} ${unit}` });
      return;
    }

    if (commandName === '給与全ロール一括付与') {
      const roleSalaries = db.getRoleSalarySettings(guild.id);
      const unit = getUnit(guild.id);
      if (roleSalaries.length === 0) {
        await interaction.reply({ content: '❌ 給与設定がありません。先に /給与設定 を実行してください。', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let totalPaidUsers = 0;
      let totalGranted = 0;
      const lines = [];

      for (const row of roleSalaries) {
        const result = await grantRoleSalary(guild, row.role_id, row.amount);
        if (!result.success) {
          lines.push(`<@&${row.role_id}>: ロール未検出`);
          continue;
        }
        totalPaidUsers += result.paidCount;
        totalGranted += result.totalGranted;
        lines.push(`${result.role}: ${result.paidCount}人 / ${result.totalGranted.toLocaleString()} ${unit}`);
      }

      await interaction.editReply({
        content: [
          '✅ 設定済みロールすべてに給与を一括付与しました。',
          `合計対象: ${totalPaidUsers}人`,
          `合計付与: ${totalGranted.toLocaleString()} ${unit}`,
          '---',
          ...lines,
        ].join('\n'),
      });
      return;
    }

    if (commandName === 'コマンド一覧') {
      if (interaction.user.id !== DEVELOPER_ID && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示', true) === 'hidden';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }
      const embed = buildCommandListEmbed();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (['community設定状況', 'economy設定状況', 'security設定状況'].includes(commandName)) {
      if (interaction.user.id !== DEVELOPER_ID && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示', true) === 'hidden';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }

      const none = '未設定';
      const ch = (id) => (id ? `<#${id}>` : none);
      const settings = db.getSettings(guild.id);
      const unit = settings.currency_unit || 'コイン';
      const section = commandName.replace('設定状況', '');

      // 経済設定 embed
      let economyEmbed;
      if (section === 'economy') {
        economyEmbed = buildStatusEmbed(guild);
        economyEmbed.setTitle('💰 経済設定状況');
      }

      // コミュニティ設定 embed
      let communityEmbed;
      if (section === 'community') {
        const vcTransferCount = communityDb.getAllVcTransfers(guild.id).length;
        const ticketPanelCount = communityDb.getAllTicketPanels(guild.id).length;
        const rrMessageCount = communityDb.getAllReactionRoleMessages(guild.id).length;
        const inquiryForumCount = communityDb.getInquiryForumItems(guild.id).length;
        const messageLinkPreview = settings.message_link_preview_enabled !== 0 ? 'オン' : 'オフ';
        communityEmbed = new EmbedBuilder()
          .setTitle('🎙 コミュニティ設定状況')
          .setColor(0x57f287)
          .setDescription(`サーバー: **${guild.name}**`)
          .addFields(
            { name: '📥 入室ログ', value: ch(settings.join_log_channel_id), inline: true },
            { name: '📤 退出ログ', value: ch(settings.leave_log_channel_id), inline: true },
            { name: '💬 メッセージリンク自動表示', value: messageLinkPreview, inline: true },
            { name: '🔊 VC転送設定数', value: `${vcTransferCount}件`, inline: true },
            { name: '🎫 チケットパネル数', value: `${ticketPanelCount}件`, inline: true },
            { name: '📩 お問い合わせ受付数', value: `${inquiryForumCount}件`, inline: true },
            { name: '🎭 RRメッセージ数', value: `${rrMessageCount}件`, inline: true },
          )
          .setTimestamp();
      }

      // セキュリティ設定 embed
      let secEmbed;
      if (section === 'security') {
        const secConfig = db.getAppStateJson('security', 'config') || {};
        secEmbed = new EmbedBuilder()
          .setTitle('🛡 セキュリティ設定状況')
          .setColor(0xed4245)
          .setDescription(`サーバー: **${guild.name}**`)
          .addFields(
            { name: 'スパム判定', value: secConfig.spamProtectionEnabled !== false ? '有効' : '無効', inline: true },
            { name: 'レイド判定', value: secConfig.raidProtectionEnabled !== false ? '有効' : '無効', inline: true },
            { name: '画像スパム判定', value: secConfig.imageSpamDetectionEnabled !== false ? '有効' : '無効', inline: true },
            { name: 'スパムしきい値', value: String(secConfig.spamThreshold ?? 6), inline: true },
            { name: 'スパム窓', value: `${secConfig.spamWindowMs ?? 8000}ms`, inline: true },
            { name: 'レイドしきい値', value: String(secConfig.raidJoinThreshold ?? 8), inline: true },
            { name: 'レイド窓', value: `${secConfig.raidWindowMs ?? 20000}ms`, inline: true },
            { name: 'タイムアウト時間', value: `${secConfig.timeoutDurationMinutes ?? 10}分`, inline: true },
            { name: '外部アプリ制限', value: secConfig.blockExternalApps ? '有効' : '無効', inline: true },
            { name: 'モデレーションログ', value: secConfig.moderationLogChannelId ? `<#${secConfig.moderationLogChannelId}>` : none, inline: true },
            { name: '招待ログ', value: secConfig.inviteLogChannelId ? `<#${secConfig.inviteLogChannelId}>` : none, inline: true },
            { name: '招待パネル設置先', value: secConfig.invitePanelChannelId ? `<#${secConfig.invitePanelChannelId}>` : none, inline: true },
            { name: 'モデレーター役職', value: secConfig.modRoleId ? `<@&${secConfig.modRoleId}>` : none, inline: true },
          )
          .setTimestamp();
      }

      const communityDetailEmbeds = [];
      const economyDetailEmbeds = [];
      const addDetailEmbeds = (title, color, fields) => {
        const target = title.includes('チケット') || title.includes('リアクション')
          ? communityDetailEmbeds
          : economyDetailEmbeds;
        for (let index = 0; index < fields.length; index += 25) {
          target.push(new EmbedBuilder().setTitle(title).setColor(color).addFields(fields.slice(index, index + 25)));
        }
      };
      if (section === 'community') {
        const ticketPanels = communityDb.getAllTicketPanels(guild.id);
        const ticketFields = ticketPanels.map((panel) => ({
          name: `チケット: ${panel.title}`,
          value: [
            `カテゴリ: ${ch(panel.category_id)}`,
            `ログ先: ${ch(panel.log_channel_id)}`,
            `サポートロール: ${[panel.role1_id, panel.role2_id, panel.role3_id].filter(Boolean).map((id) => `<@&${id}>`).join(', ') || none}`,
          ].join('\n'),
          inline: true,
        }));
        if (ticketFields.length > 0) {
          addDetailEmbeds('🎫 チケットパネル設定', 0xfee75c, ticketFields);
        }
      }

      const panelFields = (panels, label) => panels.map((panel) => ({
        name: `${label}: ${panel.panel_key}`,
        value: [
          `設置先: ${ch(panel.channel_id)}`,
          `メッセージID: ${panel.message_id || none}`,
          `ログ先: ${ch(panel.log_channel_id)}`,
          `タイトル: ${panel.title || none}`,
        ].join('\n'),
        inline: true,
      }));
      if (section === 'economy') {
        const vendingPanels = db.getVendingPanels(guild.id);
        const vcVendingPanels = db.getVcVendingPanels(guild.id);
        if (vendingPanels.length > 0) {
          addDetailEmbeds('🛒 自販機パネル設定', 0xf1c40f, panelFields(vendingPanels, '自販機'));
        }
        if (vcVendingPanels.length > 0) {
          addDetailEmbeds('🛒 VC自販機パネル設定', 0xf1c40f, panelFields(vcVendingPanels, 'VC自販機'));
        }

        const bankPanelFields = db.getBankPanels(guild.id).map((panel) => ({
          name: `bankパネル: ${panel.title || none}`,
          value: `設置先: ${ch(panel.channel_id)}\nメッセージID: ${panel.message_id || none}`,
          inline: true,
        }));
        if (bankPanelFields.length > 0) {
          addDetailEmbeds('🏦 bankパネル設定', 0x2ecc71, bankPanelFields);
        }

        const gachaFields = [
          ...db.getGachaPanels(guild.id).map((panel) => ({
            name: `旧ガチャ: ${panel.panel_key}`,
            value: `設置先: ${ch(panel.channel_id)}\nメッセージID: ${panel.message_id || none}\nタイトル: ${panel.title || none}`,
            inline: true,
          })),
          ...db.getBoxGachaSettings(guild.id).map((gacha) => ({
            name: `ガチャ: ${gacha.gacha_key}`,
            value: [
              `ガチャ名: ${gacha.name || none}`,
              `設置先: ${ch(gacha.channel_id)}`,
              `メッセージID: ${gacha.message_id || none}`,
              `ログ先: ${ch(gacha.log_channel_id)}`,
              `価格: 1回 ${gacha.single_price ?? 0} / 10連 ${gacha.ten_price ?? 0}`,
            ].join('\n'),
            inline: true,
          })),
        ];
        if (gachaFields.length > 0) {
          addDetailEmbeds('🎰 ガチャパネル設定', 0x9b59b6, gachaFields);
        }
      }

      const embedsBySection = {
        community: [communityEmbed, ...communityDetailEmbeds],
        economy: [economyEmbed, ...economyDetailEmbeds],
        security: [secEmbed],
      };
      await interaction.editReply({ embeds: embedsBySection[section] });
      return;
    }

    if (commandName === 'bot情報') {
      if (interaction.user.id !== DEVELOPER_ID) {
        await interaction.reply({ content: '❌ このコマンドは開発者専用です。', flags: MessageFlags.Ephemeral });
        return;
      }

      const hidden = interaction.options.getString('表示', true) === 'hidden';
      if (hidden) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferReply();
      }
      const embeds = await buildBotInfoEmbeds();
      await sendPagedEmbeds(interaction, embeds, hidden);
      return;
    }
  } catch (error) {
    console.error('インタラクションエラー:', error);
    const reply = { content: '❌ 処理中にエラーが発生しました。', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
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