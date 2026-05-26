const {
    Client,
    GatewayIntentBits,
    ChannelType,
    Events,
} = require('discord.js');
const { createClient } = require('redis');

// ===== 設定ここから =====
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
// ===== 設定ここまで =====

// Render Key Value に接続
const kv = createClient({ url: REDIS_URL });

kv.on('error', (error) => {
    console.error('Key Value 接続エラー:', error);
});

// guild ごとに設定を分けるためのキー
function guildMapKey(guildId) {
    return `forum-log-map:${guildId}`;
}

async function main() {
    await kv.connect();

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
    });

    client.once(Events.ClientReady, (readyClient) => {
        console.log(`ログイン完了: ${readyClient.user.tag}`);
    });

    // /setup を受け取る
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'setup') return;

        try {
            const forum = interaction.options.getChannel('forum', true);
            const log = interaction.options.getChannel('log', true);

            if (forum.type !== ChannelType.GuildForum) {
                await interaction.reply({
                    content: 'forum にはフォーラムチャンネルを指定してください。',
                    ephemeral: true,
                });
                return;
            }

            if (log.type !== ChannelType.GuildText) {
                await interaction.reply({
                    content: 'log にはテキストチャンネルを指定してください。',
                    ephemeral: true,
                });
                return;
            }

            // guildごとの hash に { forumId: logChannelId } を保存
            await kv.hSet(guildMapKey(interaction.guildId), forum.id, log.id);

            await interaction.reply({
                content:
                    `設定しました。\n` +
                    `フォーラム: <#${forum.id}>\n` +
                    `通知先: <#${log.id}>`,
                ephemeral: true,
            });
        } catch (error) {
            console.error('/setup でエラー:', error);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: '設定中にエラーが発生しました。',
                    ephemeral: true,
                });
            } else {
                await interaction.reply({
                    content: '設定中にエラーが発生しました。',
                    ephemeral: true,
                });
            }
        }
    });

    // フォーラムに新しいスレッドが立ったら通知
    client.on(Events.ThreadCreate, async (thread) => {
        try {
            if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

            // 保存済み設定から、この forum に対応する通知先を探す
            const logChannelId = await kv.hGet(guildMapKey(thread.guildId), thread.parentId);
            if (!logChannelId) return;

            const logChannel = await client.channels.fetch(logChannelId);
            if (!logChannel || !logChannel.isTextBased()) return;

            const ownerMention = thread.ownerId ? `<@${thread.ownerId}>` : '不明';
            const threadLink =
                thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;
            const forumMention = `<#${thread.parentId}>`;

            const message =
                `${forumMention} に、新しいスレッドが作成されました！\n` +
                `スレ主: ${ownerMention}\n` +
                `リンク: ${threadLink}`;

            await logChannel.send(message);
        } catch (error) {
            console.error('threadCreate でエラー:', error);
        }
    });

    await client.login(TOKEN);
}

main().catch((error) => {
    console.error('起動時エラー:', error);
    process.exit(1);
});