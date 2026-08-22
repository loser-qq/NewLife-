const path = require('path');

let sharedClient = null;

function loadDiscord(rootDir) {
  try {
    return require('discord.js');
  } catch (_) {
    return require(path.join(rootDir, 'node_modules', 'discord.js'));
  }
}

function attachSharedClientProxy(discord) {
  const OriginalClient = discord.Client;

  discord.Client = new Proxy(OriginalClient, {
    construct(Target, args) {
      if (sharedClient) return sharedClient;

      sharedClient = new Target(...args);
      const originalLogin = sharedClient.login.bind(sharedClient);
      let loginPromise = null;

      sharedClient.login = (token) => {
        if (!loginPromise) {
          loginPromise = originalLogin(token);
        }
        return loginPromise;
      };

      return sharedClient;
    },
  });
}

function getSharedClient() {
  return sharedClient;
}

module.exports = {
  loadDiscord,
  attachSharedClientProxy,
  getSharedClient,
};
