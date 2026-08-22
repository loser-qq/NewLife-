const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const {
  normalizePanelKey,
  isValidPanelKey,
  rarityChoices,
  buildGachaPanelEmbed,
  buildGachaInfoEmbed,
  buildRarityRatesEmbed,
  buildProductsEmbed,
} = require('./gachaUtils.js');

const {
  buildGachaPanelComponents,
  refreshBoxGachaPanelMessage,
} = require('./gachaButtons.js');

const GACHA_COMMAND_NAMES = new Set([
  'ガチャ作成',
  '商品追加',
  '商品削除',
  '商品一覧',
  'ガチャ設置',
  'ガチャパネル削除',
  'ガチャ情報',
  '提供割合',
  'ガチャログ',
  '次の商品',
  'ガチャリセット',
]);

const gachaCommandBuilders = [
  new SlashCommandBuilder()
    .setName('ガチャ作成')
    .setDescription('[管理者] 箱ガチャを作成または更新します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('英数字/ _ / - のID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt.setName('ガチャ名').setDescription('表示名').setRequired(true).setMaxLength(80))
    .addIntegerOption(opt => opt.setName('1回価格').setDescription('1回引く価格').setRequired(true).setMinValue(0))
    .addIntegerOption(opt => opt.setName('10連価格').setDescription('10連引く価格').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName('商品追加')
    .setDescription('[管理者] 箱ガチャに商品を追加します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt.setName('商品名').setDescription('商品名').setRequired(true).setMaxLength(80))
    .addIntegerOption(opt => opt.setName('数量').setDescription('追加数量').setRequired(true).setMinValue(1).setMaxValue(100000))
    .addStringOption(opt => opt.setName('レアリティ').setDescription('レアリティ').setRequired(true).addChoices(...rarityChoices)),

  new SlashCommandBuilder()
    .setName('商品削除')
    .setDescription('[管理者] 箱ガチャから商品を削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt.setName('商品名').setDescription('削除する商品名').setRequired(true).setMaxLength(80)),

  new SlashCommandBuilder()
    .setName('商品一覧')
    .setDescription('箱ガチャの商品一覧を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('ガチャ設置')
    .setDescription('[管理者] 箱ガチャパネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('設置先テキストチャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(opt => opt.setName('タイトル').setDescription('パネルタイトル').setRequired(true).setMaxLength(100))
    .addStringOption(opt => opt.setName('説明').setDescription('パネル説明').setRequired(true).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('ガチャパネル削除')
    .setDescription('[管理者] 箱ガチャパネルを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('削除するガチャID').setRequired(true).setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('ガチャ情報')
    .setDescription('箱ガチャの情報を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('提供割合')
    .setDescription('箱ガチャの現在提供割合を表示します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt
      .setName('表示')
      .setDescription('表示方法')
      .addChoices(
        { name: '公開', value: 'public' },
        { name: '非公開', value: 'hidden' },
      )),

  new SlashCommandBuilder()
    .setName('ガチャログ')
    .setDescription('[管理者] 箱ガチャログ送信先を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addChannelOption(opt => opt.setName('チャンネル').setDescription('ログ送信先').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('次の商品')
    .setDescription('[管理者] 次回抽選で必ず出る商品を設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20))
    .addStringOption(opt => opt.setName('商品名').setDescription('次に出す商品名').setRequired(true).setMaxLength(80)),

  new SlashCommandBuilder()
    .setName('ガチャリセット')
    .setDescription('[管理者] 箱ガチャ在庫を初期状態に戻します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt.setName('ガチャid').setDescription('対象ガチャID').setRequired(true).setMaxLength(20)),
];

function isGachaCommandName(commandName) {
  return GACHA_COMMAND_NAMES.has(commandName);
}

function hiddenReply(interaction) {
  return interaction.options.getString('表示') !== 'public';
}

function notFoundMessage(gachaKey) {
  return `❌ ガチャ ${gachaKey} は存在しません。`;
}

async function refreshRelatedPanel(guild, gachaKey, context) {
  await refreshBoxGachaPanelMessage(guild, gachaKey, context).catch(() => null);
}

async function handleGachaCommand(interaction, context) {
  const { db, getUnit, parseNewlines } = context;
  const { commandName, guild } = interaction;

  if (!isGachaCommandName(commandName)) {
    return false;
  }

  if (['商品一覧', 'ガチャ情報', '提供割合'].includes(commandName)
    && !interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ このコマンドは管理者専用です。', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (commandName === 'ガチャ作成') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gachaName = interaction.options.getString('ガチャ名', true);
    const singlePrice = interaction.options.getInteger('1回価格', true);
    const tenPrice = interaction.options.getInteger('10連価格', true);
    db.upsertBoxGacha(guild.id, gachaKey, gachaName, singlePrice, tenPrice);
    await interaction.reply({
      content: [
        '✅ ガチャを保存しました。',
        `ガチャID: ${gachaKey}`,
        `ガチャ名: ${gachaName}`,
        `1回価格: ${singlePrice.toLocaleString()} ${getUnit(guild.id)}`,
        `10連価格: ${tenPrice.toLocaleString()} ${getUnit(guild.id)}`,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (commandName === '商品追加') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const productName = interaction.options.getString('商品名', true).trim();
    const quantity = interaction.options.getInteger('数量', true);
    const rarity = interaction.options.getString('レアリティ', true);

    db.addBoxGachaProduct(guild.id, gachaKey, productName, quantity, rarity);
    await refreshRelatedPanel(guild, gachaKey, context);

    await interaction.reply({
      content: [
        '✅ 商品を追加しました。',
        `ガチャID: ${gachaKey}`,
        `商品名: ${productName}`,
        `数量: ${quantity}`,
        `レアリティ: ${rarity}`,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (commandName === '商品削除') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const productName = interaction.options.getString('商品名', true).trim();
    const deleted = db.deleteBoxGachaProduct(guild.id, gachaKey, productName);
    await refreshRelatedPanel(guild, gachaKey, context);

    await interaction.reply({
      content: deleted > 0
        ? `✅ ${productName} を削除しました。`
        : `ℹ️ ${productName} は見つかりませんでした。`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (commandName === '商品一覧') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const products = db.getBoxGachaProducts(guild.id, gachaKey);
    const embed = buildProductsEmbed(gacha, products, getUnit(guild.id));
    await interaction.reply(hiddenReply(interaction) ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
    return true;
  }

  if (commandName === 'ガチャ設置') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const channel = interaction.options.getChannel('チャンネル', true);
    const title = interaction.options.getString('タイトル', true);
    const description = parseNewlines(interaction.options.getString('説明', true));

    const rates = db.countBoxGachaRemainingByRarity(guild.id, gachaKey);
    const panelEmbed = buildGachaPanelEmbed({
      ...gacha,
      title,
      description,
    }, rates, getUnit(guild.id));

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await channel.send({
      embeds: [panelEmbed],
      components: buildGachaPanelComponents(gachaKey),
    });

    db.upsertBoxGachaPanel(guild.id, gachaKey, channel.id, message.id, title, description);

    await interaction.editReply({
      content: [
        '✅ ガチャパネルを設置しました。',
        `ガチャID: ${gachaKey}`,
        `チャンネル: <#${channel.id}>`,
        `メッセージID: ${message.id}`,
      ].join('\n'),
    });
    return true;
  }

  if (commandName === 'ガチャパネル削除') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const panel = db.getBoxGachaPanel(guild.id, gachaKey);
    if (!panel) {
      await interaction.reply({ content: `❌ ガチャ ${gachaKey} のパネルは設置されていません。`, flags: MessageFlags.Ephemeral });
      return true;
    }

    let panelMessageDeleted = false;
    if (panel.channel_id && panel.message_id) {
      const panelChannel = guild.channels.cache.get(panel.channel_id);
      if (panelChannel?.messages?.fetch) {
        const panelMessage = await panelChannel.messages.fetch(panel.message_id).catch(() => null);
        if (panelMessage) {
          await panelMessage.delete().catch(() => null);
          panelMessageDeleted = true;
        }
      }
    }

    db.deleteBoxGachaPanel(guild.id, gachaKey);
    await interaction.reply({
      content: [
        '✅ ガチャパネルを削除しました。',
        `ガチャID: ${gachaKey}`,
        `パネルメッセージ削除: ${panelMessageDeleted ? '成功' : '未削除（既に削除済み/取得不可）'}`,
        'ガチャ本体と商品在庫は残っています。',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (commandName === 'ガチャ情報') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const rates = db.countBoxGachaRemainingByRarity(guild.id, gachaKey);
    const panel = db.getBoxGachaPanel(guild.id, gachaKey);
    const nextProduct = db.getBoxGachaNextProduct(guild.id, gachaKey);
    const logChannelId = db.getBoxGachaLogChannel(guild.id, gachaKey);

    const embed = buildGachaInfoEmbed(gacha, rates, panel, nextProduct, logChannelId, getUnit(guild.id));
    await interaction.reply(hiddenReply(interaction) ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
    return true;
  }

  if (commandName === '提供割合') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const rates = db.countBoxGachaRemainingByRarity(guild.id, gachaKey);
    const embed = buildRarityRatesEmbed(gacha, rates);
    await interaction.reply(hiddenReply(interaction) ? { embeds: [embed], flags: MessageFlags.Ephemeral } : { embeds: [embed] });
    return true;
  }

  if (commandName === 'ガチャログ') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const channel = interaction.options.getChannel('チャンネル', true);
    db.setBoxGachaLogChannel(guild.id, gachaKey, channel.id);
    await interaction.reply({ content: `✅ ガチャログ送信先を <#${channel.id}> に設定しました。`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (commandName === '次の商品') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const productName = interaction.options.getString('商品名', true).trim();
    const product = db.getBoxGachaProductByName(guild.id, gachaKey, productName);
    if (!product || product.remaining_quantity <= 0) {
      await interaction.reply({ content: '❌ 指定商品が見つからないか、在庫がありません。', flags: MessageFlags.Ephemeral });
      return true;
    }

    db.setBoxGachaNextProduct(guild.id, gachaKey, productName, interaction.user.id);
    await interaction.reply({ content: `✅ 次回抽選を ${productName} に固定しました。出現後は自動解除されます。`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (commandName === 'ガチャリセット') {
    const gachaKey = normalizePanelKey(interaction.options.getString('ガチャid', true));
    if (!isValidPanelKey(gachaKey)) {
      await interaction.reply({ content: '❌ ガチャIDは英数字・_・- のみ、1〜20文字で指定してください。', flags: MessageFlags.Ephemeral });
      return true;
    }

    const gacha = db.getBoxGacha(guild.id, gachaKey);
    if (!gacha) {
      await interaction.reply({ content: notFoundMessage(gachaKey), flags: MessageFlags.Ephemeral });
      return true;
    }

    const changed = db.resetBoxGacha(guild.id, gachaKey);
    await refreshRelatedPanel(guild, gachaKey, context);
    await interaction.reply({
      content: `✅ ガチャをリセットしました。復元対象商品数: ${changed}件`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.reply({ content: '❌ 未対応のガチャコマンドです。', flags: MessageFlags.Ephemeral });
  return true;
}

module.exports = {
  gachaCommandBuilders,
  isGachaCommandName,
  handleGachaCommand,
};
