const {
    Client,
    GatewayIntentBits,
    ChannelType,
    Events,
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');

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

// ===== Redis キー =====
function guildMapKey(guildId) {
    return `forum-log-map:${guildId}`;
}

function missingRoleKey(guildId) {
    return `missing-role:${guildId}`;
}

// ===== 長文分割用 =====
function splitLinesToMessages(header, lines, maxLength = 1900) {
    const chunks = [];
    let current = header;

    for (const line of lines) {
        if ((current + line + '\n').length > maxLength) {
            chunks.push(current.trimEnd());
            current = '';
        }
        current += line + '\n';
    }

    if (current.trim()) {
        chunks.push(current.trimEnd());
    }

    return chunks;
}

// ===== スペース区切り分割用 =====
function splitBySpaceToMessages(header, items, maxLength = 1800) {
    const chunks = [];
    let current = header;

    for (const item of items) {
        if ((current + item + ' ').length > maxLength) {
            chunks.push(current.trimEnd());
            current = '';
        }
        current += `${item} `;
    }

    if (current.trim()) {
        chunks.push(current.trimEnd());
    }

    return chunks;
}

// ===== 転送先へ送信 =====
async function sendToTarget(client, targetId, message) {
    const target = await client.channels.fetch(targetId).catch(() => null);
    if (!target) return { ok: false, reason: 'target_not_found' };

    if (typeof target.send !== 'function') {
        return { ok: false, reason: 'target_not_sendable' };
    }

    // 既存スレッドがアーカイブされていたら、可能なら起こす
    if (typeof target.isThread === 'function' && target.isThread()) {
        if (target.archived && !target.locked) {
            try {
                await target.setArchived(false);
            } catch (e) {
                console.warn('スレッドのアーカイブ解除に失敗:', e);
            }
        }
    }

    try {
        await target.send(message);
        return { ok: true };
    } catch (error) {
        console.error('送信失敗:', error);
        return { ok: false, reason: 'send_failed' };
    }
}

async function main() {
    await kv.connect();

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });

    client.once(Events.ClientReady, (readyClient) => {
        console.log(`ログイン完了: ${readyClient.user.tag}`);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        if (!interaction.inGuild()) {
            await interaction.reply({
                content: 'このコマンドはサーバー内でのみ使用できます。',
                ephemeral: true,
            });
            return;
        }

        try {
            // =========================================================
            // /forum 系
            // =========================================================
            if (interaction.commandName === 'forum') {
                const sub = interaction.options.getSubcommand();

                // /forum channel
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

                    await kv.hSet(guildMapKey(interaction.guildId), forum.id, logChannel.id);

                    await interaction.reply({
                        content:
                            `フォーラム通知設定を登録しました。\n` +
                            `フォーラム: <#${forum.id}>\n` +
                            `通知先チャンネル: <#${logChannel.id}>`,
                    });
                    return;
                }

                // /forum thread
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

                    await kv.hSet(guildMapKey(interaction.guildId), forum.id, targetThread.id);

                    await interaction.reply({
                        content:
                            `フォーラム通知設定を登録しました。\n` +
                            `フォーラム: <#${forum.id}>\n` +
                            `通知先スレッド: <#${targetThread.id}>`,
                    });
                    return;
                }

                // /forum show
                if (sub === 'show') {
                    const settings = await kv.hGetAll(guildMapKey(interaction.guildId));

                    if (!settings || Object.keys(settings).length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだフォーラム通知設定がありません。',
                        });
                        return;
                    }

                    const lines = Object.entries(settings).map(
                        ([forumId, targetId], index) =>
                            `${index + 1}. フォーラム: <#${forumId}> → 通知先: <#${targetId}>`,
                    );

                    const chunks = splitLinesToMessages('現在のフォーラム通知設定一覧:\n', lines);

                    await interaction.reply({ content: chunks[0] });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i] });
                    }
                    return;
                }

                // /forum unset
                if (sub === 'unset') {
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
                        content: `フォーラム通知設定を削除しました: <#${forum.id}>`,
                    });
                    return;
                }
            }

            // =========================================================
            // /role 系
            // =========================================================
            if (interaction.commandName === 'role') {
                const sub = interaction.options.getSubcommand();

                // /role set
                if (sub === 'set') {
                    const role = interaction.options.getRole('target', true);

                    await kv.set(missingRoleKey(interaction.guildId), role.id);

                    await interaction.reply({
                        content: `未所持チェック対象ロールを設定しました: <@&${role.id}>`,
                    });
                    return;
                }

                // /role show
                if (sub === 'show') {
                    const roleId = await kv.get(missingRoleKey(interaction.guildId));

                    if (!roleId) {
                        await interaction.reply({
                            content: '未所持チェック対象ロールはまだ設定されていません。',
                        });
                        return;
                    }

                    await interaction.reply({
                        content: `現在の未所持チェック対象ロール: <@&${roleId}>`,
                    });
                    return;
                }

                // /role unset
                if (sub === 'unset') {
                    const deleted = await kv.del(missingRoleKey(interaction.guildId));

                    if (!deleted) {
                        await interaction.reply({
                            content: '未所持チェック対象ロールは設定されていません。',
                        });
                        return;
                    }

                    await interaction.reply({
                        content: '未所持チェック対象ロールの設定を削除しました。',
                    });
                    return;
                }

                // /role missing
                if (sub === 'missing') {
                    const roleId = await kv.get(missingRoleKey(interaction.guildId));

                    if (!roleId) {
                        await interaction.reply({
                            content: '未所持チェック対象ロールが設定されていません。先に /role set を使ってください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    const targetRole = await interaction.guild.roles.fetch(roleId).catch(() => null);

                    if (!targetRole) {
                        await interaction.reply({
                            content: '設定されているロールが見つかりませんでした。/role set で設定し直してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.guild.members.fetch();

                    const membersWithoutRole = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && !member.roles.cache.has(targetRole.id)
                    );

                    if (membersWithoutRole.size === 0) {
                        await interaction.reply({
                            content: `ロール <@&${targetRole.id}> を持っていないメンバーはいません。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    // 昔の表示形式に戻す
                    const lines = membersWithoutRole.map(
                        (member) => `• ${member.user.tag} (<@${member.id}>)`
                    );

                    const chunks = splitLinesToMessages(
                        `ロール <@&${targetRole.id}> を持っていないメンバー一覧:\n`,
                        lines
                    );

                    await interaction.reply({
                        content: chunks[0],
                        ephemeral: true,
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({
                            content: chunks[i],
                            ephemeral: true,
                        });
                    }

                    return;
                }

                // /role mentionmissing
                if (sub === 'mentionmissing') {
                    const roleId = await kv.get(missingRoleKey(interaction.guildId));

                    if (!roleId) {
                        await interaction.reply({
                            content: '未所持チェック対象ロールが設定されていません。先に /role set を使ってください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    const targetRole = await interaction.guild.roles.fetch(roleId).catch(() => null);

                    if (!targetRole) {
                        await interaction.reply({
                            content: '設定されているロールが見つかりませんでした。/role set で設定し直してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.guild.members.fetch();

                    const membersWithoutRole = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && !member.roles.cache.has(targetRole.id)
                    );

                    if (membersWithoutRole.size === 0) {
                        await interaction.reply({
                            content: `ロール <@&${targetRole.id}> を持っていないメンバーはいません。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    const rawMentions = membersWithoutRole.map((member) => `<@${member.id}>`);
                    const chunks = splitBySpaceToMessages('', rawMentions);

                    await interaction.reply({
                        content:
                            `ロール <@&${targetRole.id}> を持っていないメンバーのコピペ用メンションです。\n` +
                            `下のコードブロックをコピーして使ってください。\n\n` +
                            '```txt\n' +
                            chunks[0] +
                            '\n```',
                        ephemeral: true,
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({
                            content: '```txt\n' + chunks[i] + '\n```',
                            ephemeral: true,
                        });
                    }

                    return;
                }
            }
        } catch (error) {
            console.error('interactionCreate でエラー:', error);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: 'コマンド実行中にエラーが発生しました。',
                    ephemeral: true,
                });
            } else {
                await interaction.reply({
                    content: 'コマンド実行中にエラーが発生しました。',
                    ephemeral: true,
                });
            }
        }
    });

    // =========================================================
    // フォーラムに新しいスレッドが立ったら通知
    // =========================================================
    client.on(Events.ThreadCreate, async (thread) => {
        try {
            if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

            const targetId = await kv.hGet(guildMapKey(thread.guildId), thread.parentId);
            if (!targetId) return;

            const ownerMention = thread.ownerId ? `<@${thread.ownerId}>` : '不明';
            const threadLink =
                thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;
            const forumMention = `<#${thread.parentId}>`;

            const message =
                `${forumMention} に、新しいスレッドが作成されました！\n` +
                `スレ主: ${ownerMention}\n` +
                `リンク: ${threadLink}`;

            const result = await sendToTarget(client, targetId, message);

            if (!result.ok) {
                console.warn(`通知送信失敗: ${result.reason}, targetId=${targetId}`);
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

// =========================================================
// keep-alive 用
// =========================================================
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
``