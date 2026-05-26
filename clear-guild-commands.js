const { REST, Routes } = require('discord.js');

const TOKEN = process.env.TOKEN;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !APP_ID || !GUILD_ID) {
    console.error('TOKEN / APP_ID / GUILD_ID のどれかが設定されていません');
    process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('ギルドコマンドを削除中...');
        await rest.put(
            Routes.applicationGuildCommands(APP_ID, GUILD_ID),
            { body: [] }
        );
        console.log('ギルドコマンドを削除しました');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
