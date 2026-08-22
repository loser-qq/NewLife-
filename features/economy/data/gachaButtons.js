const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const {
  normalizePanelKey,
  buildGachaPanelEmbed,
  buildRarityRatesEmbed,
  buildRemainingEmbed,
  wait,
} = require('./gachaUtils.js');

const RARITY_RANK = {
  N: 1,
  R: 2,
  SR: 3,
  SSR: 4,
  UR: 5,
};

function buildScriptVariants(lines, count, stepCount, delayPattern, startOffset = 0) {
  const scripts = [];
  for (let i = 0; i < count; i += 1) {
    const steps = [];
    for (let s = 0; s < stepCount; s += 1) {
      const lineIndex = (startOffset + (i * 3) + (s * 2)) % lines.length;
      const delayIndex = (i + s) % delayPattern.length;
      steps.push({
        text: lines[lineIndex],
        delay: delayPattern[delayIndex],
      });
    }
    scripts.push(steps);
  }
  return scripts;
}

function pickRandomScript(scripts) {
  return scripts[Math.floor(Math.random() * scripts.length)];
}

const NORMAL_LINES = [
  '🎲 ガチャを回しています...',
  '⚙️ カプセルがシャッフル中...',
  '✨ 中身を確認しています...',
  '🔓 ロック解除、開封準備...',
  '🎵 カラン...コロン...',
  '📦 景品が落ちてきた！',
  '👀 結果を確認しています...',
  '🫧 エフェクト展開中...',
  '📮 抽選結果を整形中...',
  '🎯 ターゲット選定中...',
  '🧭 カプセルルート計算中...',
  '💫 もうすぐ結果です...',
  '🔔 期待値が高まっていく...',
  '📬 結果を受信中...',
  '🪄 開封シーケンス進行中...',
];

const HIGH_TIER_LINES = [
  '🌟 特別演出モードに切り替え...',
  '✨ 光のリングが展開中...',
  '🎼 高音チャイムを検知...',
  '💠 高レア反応を追跡中...',
  '🎁 期待値アップ演出継続...',
  '🌠 背景エフェクトが変化...',
  '🌀 スパークが集中している...',
  '💫 シグナル強度が上昇...',
  '🔮 特別ランク判定処理中...',
  '🎉 まもなく開封フィナーレ...',
  '🪩 エフェクトレイヤー追加...',
  '💎 レア判定ゲージ上昇中...',
  '🎷 テーマ音が変化した...',
  '🌈 光のベールが広がる...',
  '🚀 演出出力が一段階上昇...',
];

const ULTRA_TIER_LINES = [
  '🌈 虹のゲートが開く...',
  '✨ 光の粒子が一気に集束していく...',
  '🎊 会場がきらめきに包まれた！',
  '🏆 伝説級シグナル検出！',
  '⚡ エネルギー上限突破...',
  '🌌 超演出シーケンス突入...',
  '💥 カプセル外殻が発光崩壊...',
  '🪄 祝福エフェクト重複発動...',
  '🎆 フィナーレエフェクト展開！',
  '🔥 演出レベルMAXへ到達...',
  '🌠 星屑が一斉に降り注ぐ...',
  '💠 光の紋章が浮かび上がる...',
  '🎇 連続バースト演出発生！',
  '🔷 結晶エフェクト多重発光...',
  '🎯 ラスト判定プロトコル実行...',
  '🎁 プレミアカプセル開放！',
  '🌀 極光ライン収束開始...',
  '🎼 シグネチャーメロディー再生...',
  '🌈✨🎊🏆 クライマックス到達！',
  '🌈✨🎊🏆 伝説演出フィニッシュ！',
];

const NORMAL_EFFECT_SCRIPTS = buildScriptVariants(NORMAL_LINES, 34, 4, [900, 1000, 1100, 1000]);
const SSR_PROMOTION_EFFECT_SCRIPTS = buildScriptVariants(HIGH_TIER_LINES, 33, 4, [950, 1100, 1100, 1000], 1);
const UR_PROMOTION_EFFECT_SCRIPTS = buildScriptVariants(ULTRA_TIER_LINES, 33, 5, [1000, 1100, 1100, 1000, 900], 2);

function buildGachaPanelComponents(gachaKey) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`boxgacha:single:${gachaKey}`)
        .setLabel('🎲1回引く')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`boxgacha:ten:${gachaKey}`)
        .setLabel('🎰10連引く')
        .setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`boxgacha:remaining:${gachaKey}`)
        .setLabel('📦残りを見る')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`boxgacha:rate:${gachaKey}`)
        .setLabel('📊提供割合')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildDrawResultEmbed(gacha, drawResults, unit, price, remainingTotal) {
  const lines = drawResults.map((item, index) => `${index + 1}. ${item.product_name} [${item.rarity}]`);
  return new EmbedBuilder()
    .setTitle(`🎉 ${gacha.name} 抽選結果`)
    .setColor(0xfee75c)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: '消費', value: `${Number(price).toLocaleString()} ${unit}`, inline: true },
      { name: '残り総数', value: `${Number(remainingTotal).toLocaleString()} 個`, inline: true },
    )
    .setTimestamp();
}

function buildGachaLogEmbed(userId, gacha, drawType, drawResults, unit, price, remainingTotal) {
  const rarityText = drawResults.reduce((acc, item) => {
    acc[item.rarity] = (acc[item.rarity] || 0) + 1;
    return acc;
  }, {});

  const summary = ['N', 'R', 'SR', 'SSR', 'UR']
    .map(r => `${r}: ${Number(rarityText[r] || 0)}個`)
    .join(' / ');

  return new EmbedBuilder()
    .setTitle('🧾 ガチャログ')
    .setColor(0x57f287)
    .addFields(
      { name: '実行者', value: `<@${userId}>`, inline: true },
      { name: 'ガチャ', value: `${gacha.name} (${gacha.gacha_key})`, inline: true },
      { name: '実行種別', value: drawType, inline: true },
      { name: '消費', value: `${Number(price).toLocaleString()} ${unit}`, inline: true },
      { name: '残り総数', value: `${Number(remainingTotal).toLocaleString()} 個`, inline: true },
      { name: 'レア内訳', value: summary, inline: false },
      { name: '結果', value: drawResults.map(item => `${item.product_name} [${item.rarity}]`).join('\n'), inline: false },
    )
    .setTimestamp();
}

async function refreshBoxGachaPanelMessage(guild, gachaKey, context) {
  const { db, getUnit, isTextBasedChannel } = context;
  const panel = db.getBoxGachaPanel(guild.id, gachaKey);
  const gacha = db.getBoxGacha(guild.id, gachaKey);
  if (!panel || !gacha || !panel.channel_id || !panel.message_id) {
    return;
  }

  const channel = guild.channels.cache.get(panel.channel_id);
  if (!isTextBasedChannel(channel)) {
    return;
  }

  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) {
    return;
  }

  const rates = db.countBoxGachaRemainingByRarity(guild.id, gachaKey);
  const embed = buildGachaPanelEmbed({
    ...gacha,
    title: panel.title,
    description: panel.description,
  }, rates, getUnit(guild.id));

  await message.edit({
    embeds: [embed],
    components: buildGachaPanelComponents(gachaKey),
  });
}

async function playScript(interaction, script) {
  for (const step of script) {
    await interaction.editReply(step.text);
    await wait(step.delay);
  }
}

function getHighestRarityRank(drawResults) {
  let highest = 0;
  for (const item of drawResults) {
    const rank = RARITY_RANK[item.rarity] || 0;
    if (rank > highest) {
      highest = rank;
    }
  }
  return highest;
}

async function sendDrawResult(interaction, drawResults, embed) {
  const highestRank = getHighestRarityRank(drawResults);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // まずは通常演出で進め、終盤で昇格するかどうかを見せる。
  await playScript(interaction, pickRandomScript(NORMAL_EFFECT_SCRIPTS));

  if (highestRank >= RARITY_RANK.UR) {
    await interaction.editReply('🌌 ...!? 反応値が急上昇！ 昇格演出へ移行します...');
    await wait(1000);
    await playScript(interaction, pickRandomScript(UR_PROMOTION_EFFECT_SCRIPTS));
    await interaction.editReply({ content: '', embeds: [embed] });
    return;
  }

  if (highestRank >= RARITY_RANK.SSR) {
    await interaction.editReply('💫 ...!? 反応が変化。特別昇格演出に突入...');
    await wait(900);
    await playScript(interaction, pickRandomScript(SSR_PROMOTION_EFFECT_SCRIPTS));
    await interaction.editReply({ content: '', embeds: [embed] });
    return;
  }

  await interaction.editReply({ content: '', embeds: [embed] });
}

async function handleGachaButtonInteraction(interaction, context) {
  const { db, getUnit, sendToConfiguredChannel } = context;

  if (!interaction.isButton()) {
    return false;
  }

  if (!interaction.customId.startsWith('boxgacha:')) {
    return false;
  }

  const [, action, gachaKeyRaw] = interaction.customId.split(':');
  const gachaKey = normalizePanelKey(gachaKeyRaw);
  const gacha = db.getBoxGacha(interaction.guild.id, gachaKey);

  if (!gacha) {
    await interaction.reply({ content: '❌ このガチャは存在しません。', flags: MessageFlags.Ephemeral });
    return true;
  }

  const panel = db.getBoxGachaPanel(interaction.guild.id, gachaKey);
  if (!panel || panel.message_id !== interaction.message.id || panel.channel_id !== interaction.channelId) {
    await interaction.reply({ content: '❌ このガチャパネルは無効です。', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === 'remaining') {
    const products = db.getBoxGachaProducts(interaction.guild.id, gachaKey);
    const rates = db.countBoxGachaRemainingByRarity(interaction.guild.id, gachaKey);
    const embed = buildRemainingEmbed(gacha, products, rates);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === 'rate') {
    const rates = db.countBoxGachaRemainingByRarity(interaction.guild.id, gachaKey);
    const embed = buildRarityRatesEmbed(gacha, rates);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action !== 'single' && action !== 'ten') {
    await interaction.reply({ content: '❌ 不明なガチャ操作です。', flags: MessageFlags.Ephemeral });
    return true;
  }

  const drawCount = action === 'single' ? 1 : 10;
  const price = action === 'single' ? Number(gacha.single_price || 0) : Number(gacha.ten_price || 0);
  const unit = getUnit(interaction.guild.id);

  const balance = db.getBalance(interaction.user.id, interaction.guild.id);
  if (balance < price) {
    await interaction.reply({ content: `❌ 残高不足です。必要: ${price.toLocaleString()} ${unit}`, flags: MessageFlags.Ephemeral });
    return true;
  }

  const remainingTotal = db.getBoxGachaRemainingTotal(interaction.guild.id, gachaKey);
  if (remainingTotal < drawCount) {
    await interaction.reply({ content: `❌ 残り総数が不足しています。（必要: ${drawCount} / 残り: ${remainingTotal}）`, flags: MessageFlags.Ephemeral });
    return true;
  }

  db.subtractBalance(interaction.user.id, interaction.guild.id, price);
  const drawResult = db.drawBoxGacha(interaction.guild.id, gachaKey, drawCount);

  if (!drawResult.ok) {
    db.addBalance(interaction.user.id, interaction.guild.id, price);
    await interaction.reply({ content: '❌ 抽選できませんでした。', flags: MessageFlags.Ephemeral });
    return true;
  }

  const remainingTotalAfterDraw = db.getBoxGachaRemainingTotal(interaction.guild.id, gachaKey);
  const drawType = action === 'single' ? '1回' : '10連';
  const embed = buildDrawResultEmbed(gacha, drawResult.results, unit, price, remainingTotalAfterDraw);

  await sendDrawResult(interaction, drawResult.results, embed);
  await refreshBoxGachaPanelMessage(interaction.guild, gachaKey, context);

  const logChannelId = db.getBoxGachaLogChannel(interaction.guild.id, gachaKey);
  await sendToConfiguredChannel(interaction.guild, logChannelId, {
    embeds: [buildGachaLogEmbed(interaction.user.id, gacha, drawType, drawResult.results, unit, price, remainingTotalAfterDraw)],
  });

  return true;
}

module.exports = {
  buildGachaPanelComponents,
  refreshBoxGachaPanelMessage,
  handleGachaButtonInteraction,
};
