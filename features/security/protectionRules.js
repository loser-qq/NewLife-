function isSpamProtectionEnabled(config = {}) {
  return config.spamProtectionEnabled !== false;
}

function isRaidProtectionEnabled(config = {}) {
  return config.raidProtectionEnabled !== false;
}

function isImageSpamDetectionEnabled(config = {}) {
  return config.imageSpamDetectionEnabled !== false;
}

function hasMediaAttachment(message) {
  if (!message) return false;
  const attachmentCount = message.attachments?.size || 0;
  const embedCount = message.embeds?.length || 0;
  const stickerCount = message.stickers?.size || 0;
  return attachmentCount > 0 || embedCount > 0 || stickerCount > 0;
}

module.exports = {
  isSpamProtectionEnabled,
  isRaidProtectionEnabled,
  isImageSpamDetectionEnabled,
  hasMediaAttachment,
};
