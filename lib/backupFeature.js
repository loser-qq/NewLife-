const fs = require('fs');
const path = require('path');

function collectBackupFiles(rootDir, scope) {
  const requested = scope || 'all';
  const files = [
    { label: 'data/unified.db', fullPath: path.join(rootDir, 'data', 'unified.db') },
  ];

  const includeCommunity = requested === 'all' || requested === 'community';
  const includeEconomy = requested === 'all' || requested === 'economy';
  const includeSecurity = requested === 'all' || requested === 'security';

  if (includeCommunity) {
    files.push(
      { label: 'features/community/database.js', fullPath: path.join(rootDir, 'features', 'community', 'database.js') },
    );
  }

  if (includeEconomy) {
    files.push(
      { label: 'features/economy/database.js', fullPath: path.join(rootDir, 'features', 'economy', 'database.js') },
      { label: 'features/economy/data/gacha.js', fullPath: path.join(rootDir, 'features', 'economy', 'data', 'gacha.js') },
      { label: 'features/economy/data/gachaButtons.js', fullPath: path.join(rootDir, 'features', 'economy', 'data', 'gachaButtons.js') },
      { label: 'features/economy/data/gachaUtils.js', fullPath: path.join(rootDir, 'features', 'economy', 'data', 'gachaUtils.js') },
    );
  }

  if (includeSecurity) {
    files.push(
      { label: 'features/security/protectionRules.js', fullPath: path.join(rootDir, 'features', 'security', 'protectionRules.js') },
    );
  }

  const existing = [];
  const missing = [];

  for (const entry of files) {
    if (fs.existsSync(entry.fullPath)) {
      existing.push(entry);
    } else {
      missing.push(entry.label);
    }
  }

  return { existing, missing };
}

function registerBackupFeature({ discord, client, rootDir, unifiedToken, unifiedClientId, unifiedDeveloperId }) {
  const {
    AttachmentBuilder,
    ChannelType,
    Events,
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
  } = discord;

  const backupCommand = new SlashCommandBuilder()
    .setName('backup')
    .setDescription('設定/DBファイルを指定チャンネルへ出力します')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('バックアップファイルを出力するテキストチャンネル')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('scope')
        .setDescription('出力対象')
        .setRequired(false)
        .addChoices(
          { name: 'all', value: 'all' },
          { name: 'community', value: 'community' },
          { name: 'economy', value: 'economy' },
          { name: 'security', value: 'security' },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON();

  async function registerBackupCommand() {
    if (!unifiedToken || !unifiedClientId) {
      console.warn('[unified] UNIFIED_DISCORD_TOKEN or UNIFIED_CLIENT_ID is missing. /backup command will not be registered.');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(unifiedToken);

    try {
      await rest.post(Routes.applicationCommands(unifiedClientId), { body: backupCommand });
      console.log('[unified] backup command registered.');
    } catch (error) {
      console.warn('[unified] backup command registration failed:', error.message);
    }
  }

  function isUnifiedMod(member) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (unifiedDeveloperId && member.id === unifiedDeveloperId) return true;
    return false;
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'backup') return;

    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'このコマンドはサーバー内でのみ利用できます。', ephemeral: true });
      return;
    }

    if (!isUnifiedMod(interaction.member)) {
      await interaction.reply({ content: '管理者または開発者のみ実行できます。', ephemeral: true });
      return;
    }

    const targetChannel = interaction.options.getChannel('channel');
    const scope = interaction.options.getString('scope') || 'all';

    if (!targetChannel?.isTextBased?.()) {
      await interaction.reply({ content: 'テキストチャンネルを指定してください。', ephemeral: true });
      return;
    }

    const { existing, missing } = collectBackupFiles(rootDir, scope);

    if (existing.length === 0) {
      await interaction.reply({
        content: `バックアップ対象ファイルが見つかりませんでした。missing: ${missing.join(', ') || 'none'}`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ content: `バックアップ出力を開始します。対象: ${scope}`, ephemeral: true });

    const sent = [];
    const failed = [];

    for (const entry of existing) {
      try {
        const attachment = new AttachmentBuilder(entry.fullPath, { name: path.basename(entry.fullPath) });
        await targetChannel.send({
          content: `[backup] ${entry.label}`,
          files: [attachment],
        });
        sent.push(entry.label);
      } catch (error) {
        failed.push(`${entry.label} (${error.message})`);
      }
    }

    const summaryLines = [
      `バックアップ完了: 成功 ${sent.length}件 / 失敗 ${failed.length}件`,
      sent.length ? `成功: ${sent.join(', ')}` : '成功: なし',
      missing.length ? `未検出: ${missing.join(', ')}` : '未検出: なし',
      failed.length ? `失敗: ${failed.join(', ')}` : '失敗: なし',
    ];

    await interaction.followUp({ content: summaryLines.join('\n'), ephemeral: true });
  });

  registerBackupCommand().catch((error) => {
    console.warn('[unified] backup command bootstrap failed:', error.message);
  });
}

module.exports = {
  registerBackupFeature,
};
