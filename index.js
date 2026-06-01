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

// Render Key Value (Redis / Valkey) に接続
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

    // /setup, /showsetup, /unset を受け取る
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        try {
            // /setup channel ... または /setup thread ...
            if (interaction.commandName === 'setup') {
                const sub = interaction.options.getSubcommand();

                // /setup channel
                if (sub === 'channel') {
                    const forum = interaction.options.getChannel('forum', true);
                    const logChannel = interaction.options.getChannel('log_channel', true);

                    if (forum.type !== ChannelType.GuildForum) {
                        await interaction.reply({
                            content: 'forum にはフォーラムチャンネルを指定してください。',
                        });
                        return;
                    }

                    if (logChannel.type !== ChannelType.GuildText) {
                        await interaction.reply({
                            content: 'log_channel にはテキストチャンネルを指定してください。',
                        });
                        return;
                    }

                    // guild ごとの hash に { forumId: targetId } を保存
                    await kv.hSet(guildMapKey(interaction.guildId), forum.id, logChannel.id);

                    await interaction.reply({
                        content:
                            `設定しました。\n` +
                            `フォーラム: <#${forum.id}>\n` +
                            `通知先チャンネル: <#${logChannel.id}>`,
                    });
                    return;
                }

                // /setup thread
                if (sub === 'thread') {
                    const forum = interaction.options.getChannel('forum', true);
                    const threadId = interaction.options.getString('thread_id', true);

                    if (forum.type !== ChannelType.GuildForum) {
                        await interaction.reply({
                            content: 'forum にはフォーラムチャンネルを指定してください。',
                        });
                        return;
                    }

                    const targetThread = await client.channels.fetch(threadId).catch(() => null);

                    if (!targetThread) {
                        await interaction.reply({
                            content: '指定した thread_id のスレッドが見つかりませんでした。',
                        });
                        return;
                    }

                    if (!targetThread.isThread()) {
                        await interaction.reply({
                            content: '指定した ID はスレッドではありません。',
                        });
                        return;
                    }

                    // guild ごとの hash に { forumId: targetThreadId } を保存
                    await kv.hSet(guildMapKey(interaction.guildId), forum.id, targetThread.id);

                    await interaction.reply({
                        content:
                            `設定しました。\n` +
                            `フォーラム: <#${forum.id}>\n` +
                            `通知先スレッド: <#${targetThread.id}>`,
                    });
                    return;
                }
            }

            // /showsetup
            if (interaction.commandName === 'showsetup') {
                const settings = await kv.hGetAll(guildMapKey(interaction.guildId));

                if (!settings || Object.keys(settings).length === 0) {
                    await interaction.reply({
                        content: 'このサーバーにはまだ設定がありません。',
                    });
                    return;
                }

                const lines = Object.entries(settings).map(
                    ([forumId, targetId], index) =>
                        `${index + 1}. フォーラム: <#${forumId}> → 通知先: <#${targetId}>`,
                );

                await interaction.reply({
                    content: `現在の設定一覧:\n${lines.join('\n')}`,
                });
                return;
            }

            // /unset forum:○○
            if (interaction.commandName === 'unset') {
                const forum = interaction.options.getChannel('forum', true);

                if (forum.type !== ChannelType.GuildForum) {
                    await interaction.reply({
                        content: 'forum にはフォーラムチャンネルを指定してください。',
                    });
                    return;
                }

                const deleted = await kv.hDel(guildMapKey(interaction.guildId), forum.id);

                if (!deleted) {
                    await interaction.reply({
                        content: `そのフォーラムの設定は見つかりませんでした: <#${forum.id}>`,
                    });
                    return;
                }

                await interaction.reply({
                    content: `設定を削除しました: <#${forum.id}>`,
                });
                return;
            }
        } catch (error) {
            console.error('interactionCreate でエラー:', error);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: 'コマンド実行中にエラーが発生しました。',
                });
            } else {
                await interaction.reply({
                    content: 'コマンド実行中にエラーが発生しました。',
                });
            }
        }
    });

    // フォーラムに新しいスレッドが立ったら通知
    client.on(Events.ThreadCreate, async (thread) => {
        try {
            if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

            // 保存済み設定から、この forum に対応する通知先を探す
            const targetId = await kv.hGet(guildMapKey(thread.guildId), thread.parentId);
            if (!targetId) return;

            const target = await client.channels.fetch(targetId).catch(() => null);
            if (!target) return;

            const ownerMention = thread.ownerId ? `<@${thread.ownerId}>` : '不明';
            const threadLink =
                thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;
            const forumMention = `<#${thread.parentId}>`;

            const message =
                `${forumMention} に、新しいスレッドが作成されました！\n` +
                `スレ主: ${ownerMention}\n` +
                `リンク: ${threadLink}`;

            // テキストチャンネルでもスレッドでも send() できる
            if (typeof target.send === 'function') {
                await target.send(message);
            }
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

// keep-alive 用
const express = require('express');
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