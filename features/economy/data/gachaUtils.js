const { EmbedBuilder } = require('discord.js');

const rarityOrder = ['N', 'R', 'SR', 'SSR', 'UR'];
const rarityChoices = rarityOrder.map(r => ({ name: r, value: r }));

function normalizePanelKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidPanelKey(value) {
  return /^[a-z0-9_-]{1,20}$/.test(value);
}

function rarityPercent(count, total) {
  if (total <= 0) return 0;
  return (count / total) * 100;
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function buildRarityLines(rates) {
  const total = Number(rates?.total || 0);
  return rarityOrder.map(rarity => {
    const count = Number(rates?.[rarity] || 0);
    return `${rarity} ${formatPercent(rarityPercent(count, total))} (${count})`;
  });
}

function buildGachaPanelEmbed(gacha, rates, unit) {
  const total = Number(rates?.total || 0);
  return new EmbedBuilder()
    .setTitle(gacha.title || gacha.name)
    .setColor(0xfee75c)
    .setDescription([
      gacha.description || '箱ガチャパネル',
      '',
      `1回: ${Number(gacha.single_price || 0).toLocaleString()} ${unit}`,
      `10連: ${Number(gacha.ten_price || 0).toLocaleString()} ${unit}`,
      `残り総数: ${total.toLocaleString()} 個`,
      '',
      'ボタンからガチャを実行できます。',
    ].join('\n'))
    .setTimestamp();
}

function buildGachaInfoEmbed(gacha, rates, panel, nextProduct, logChannelId, unit) {
  const total = Number(rates?.total || 0);
  return new EmbedBuilder()
    .setTitle(`🎲 ガチャ情報: ${gacha.name}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'ガチャID', value: gacha.gacha_key, inline: true },
      { name: '1回価格', value: `${Number(gacha.single_price).toLocaleString()} ${unit}`, inline: true },
      { name: '10連価格', value: `${Number(gacha.ten_price).toLocaleString()} ${unit}`, inline: true },
      { name: '残り総数', value: `${total.toLocaleString()} 個`, inline: true },
      { name: '次の商品', value: nextProduct ? nextProduct.product_name : '未設定', inline: true },
      { name: 'ログチャンネル', value: logChannelId ? `<#${logChannelId}>` : '未設定', inline: true },
      { name: 'パネル', value: panel ? `<#${panel.channel_id}> / ${panel.message_id}` : '未設置', inline: false },
      { name: '提供割合', value: buildRarityLines(rates).join('\n'), inline: false },
    )
    .setTimestamp();
}

function buildRarityRatesEmbed(gacha, rates) {
  return new EmbedBuilder()
    .setTitle(`📊 提供割合: ${gacha.name}`)
    .setColor(0x57f287)
    .setDescription(buildRarityLines(rates).join('\n'))
    .setTimestamp();
}

function buildProductsEmbed(gacha, products, unit) {
  const lines = products.length > 0
    ? products.map((product, index) => [
      `${index + 1}. ${product.product_name} [${product.rarity}]`,
      `初期数: ${Number(product.initial_quantity).toLocaleString()} / 残り: ${Number(product.remaining_quantity).toLocaleString()}`,
    ].join(' / ')).join('\n')
    : '商品は登録されていません。';

  return new EmbedBuilder()
    .setTitle(`📦 商品一覧: ${gacha.name}`)
    .setColor(0xfee75c)
    .addFields(
      { name: 'ガチャID', value: gacha.gacha_key, inline: true },
      { name: '1回価格', value: `${Number(gacha.single_price).toLocaleString()} ${unit}`, inline: true },
      { name: '10連価格', value: `${Number(gacha.ten_price).toLocaleString()} ${unit}`, inline: true },
      { name: '一覧', value: lines, inline: false },
    )
    .setTimestamp();
}

function buildRemainingEmbed(gacha, products, rates) {
  const total = Number(rates?.total || 0);
  const lines = products.length > 0
    ? products
      .filter(product => Number(product.remaining_quantity) > 0)
      .map(product => `${product.product_name} [${product.rarity}] x ${Number(product.remaining_quantity).toLocaleString()}`)
      .join('\n')
    : '残り商品はありません。';

  return new EmbedBuilder()
    .setTitle(`📦 残りを見る: ${gacha.name}`)
    .setColor(0x5865f2)
    .setDescription(`残り総数: ${total.toLocaleString()} 個`)
    .addFields({ name: '残り内容', value: lines || '残り商品はありません。', inline: false })
    .setTimestamp();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  rarityOrder,
  rarityChoices,
  normalizePanelKey,
  isValidPanelKey,
  buildRarityLines,
  buildGachaPanelEmbed,
  buildGachaInfoEmbed,
  buildRarityRatesEmbed,
  buildProductsEmbed,
  buildRemainingEmbed,
  wait,
};
