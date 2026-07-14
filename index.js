const {
    Client,
    GatewayIntentBits,
    Events,
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');
const { handleInteractionCreate } = require('./handlers/interactionCreate');
const { handleMessageCreate } = require('./handlers/messageCreate');
const { handleForwardEditRelay } = require('./events/forwardRelay');
const { handleForumThreadCreate } = require('./events/forumThreadCreate');
const { registerVoiceStateRelay } = require('./events/voiceStateRelay');

if (process.env.RUN_ON_RENDER !== 'true') {
    console.log('ローカル実行は禁止されています。終了します。');
    process.exit(0);
}

const TOKEN = process.env.TOKEN;
const REDIS_URL = process.env.REDIS_URL;

if (!TOKEN) {
    console.error('TOKEN が設定されていません');
    process.exit(1);
}

if (!REDIS_URL) {
    console.error('REDIS_URL が設定されていません');
    process.exit(1);
}

const kv = createClient({ url: REDIS_URL });
kv.on('error', (error) => {
    console.error('Key Value 接続エラー:', error);
});

async function main() {
    await kv.connect();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildExpressions,
            GatewayIntentBits.GuildVoiceStates,
        ],
    });

    const context = {
        client,
        kv,
    };

    client.once(Events.ClientReady, (readyClient) => {
        console.log(`ログイン完了: ${readyClient.user.tag}`);
    });

    client.on(Events.InteractionCreate, (interaction) => handleInteractionCreate(interaction, context));
    client.on(Events.MessageCreate, (message) => handleMessageCreate(message, context));
    client.on(Events.MessageUpdate, (oldMessage, newMessage) => handleForwardEditRelay(oldMessage, newMessage, context),);
    client.on(Events.ThreadCreate, (thread) => handleForumThreadCreate(thread, context));

    registerVoiceStateRelay(client, kv);

    await client.login(TOKEN);
}

main().catch((error) => {
    console.error('起動時エラー:', error);
    process.exit(1);
});

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.get('/', (req, res) => {
    res.send('Bot is running');
});

app.get('/health', (req, res) => {
    console.log(`[health] ${new Date().toISOString()} /health accessed`);
    res.status(200).send('ok');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on ${PORT}`);
});
