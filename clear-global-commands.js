const { REST, Routes } = require('discord.js');

const TOKEN = process.env.TOKEN;
const APP_ID = process.env.APP_ID;

if (!TOKEN || !APP_ID) {
  console.error('TOKEN または APP_ID が設定されていません');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('グローバルコマンドを削除中...');
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    console.log('グローバルコマンドを削除しました');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();