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
// 1フォーラムに複数通知先
function forumTargetsKey(guildId, forumId) {
    return `forum-targets:${guildId}:${forumId}`;
}

// そのサーバーで使っている forumId 一覧
function forumIndexKey(guildId) {
    return `forum-index:${guildId}`;
}

// フォーラムごとの「通知先ID -> メッセージテンプレート」
function forumMessageMapKey(guildId, forumId) {
    return `forum-message-map:${guildId}:${forumId}`;
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

// ===== 指定チャンネルで一度でも発言したユーザーIDを集める =====
async function collectSpeakerIdsFromChannel(channel) {
    const speakerIds = new Set();
    let before;
    let fetchedCount = 0;

    while (true) {
        const options = { limit: 100 };
        if (before) options.before = before;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        for (const message of batch.values()) {
            if (!message.author.bot) {
                speakerIds.add(message.author.id);
            }
        }

        fetchedCount += batch.size;

        const lastMessage = batch.last();
        if (!lastMessage) break;

        before = lastMessage.id;

        // 最後のページ
        if (batch.size < 100) break;
    }

    return { speakerIds, fetchedCount };
}

// ===== フォーラム通知テンプレート =====
// デフォルト文面は今までの形を維持
const DEFAULT_FORUM_MESSAGE_TEMPLATE =
    '{forum} に、新しいスレッドが作成されました！\n' +
    'スレ主: {author}\n' +
    'リンク: {link}';

function renderForumMessage(template, data) {
    return template
        .replaceAll('\\n', '\n')
        .replaceAll('<br>', '\n')
        .replaceAll('{forum}', data.forumMention)
        .replaceAll('{forumName}', data.forumName)
        .replaceAll('{thread}', data.threadName)
        .replaceAll('{author}', data.authorMention)
        .replaceAll('{link}', data.threadLink);
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
                    const messageTemplate = interaction.options.getString('message', false);

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

                    // 通知先を追加
                    await kv.sAdd(forumTargetsKey(interaction.guildId, forum.id), logChannel.id);
                    await kv.sAdd(forumIndexKey(interaction.guildId), forum.id);

                    // メッセージテンプレートも targetId ごとに保存
                    if (messageTemplate) {
                        await kv.hSet(
                            forumMessageMapKey(interaction.guildId, forum.id),
                            logChannel.id,
                            messageTemplate
                        );
                    }

                    await interaction.reply({
                        content:
                            `フォーラム通知先を追加しました。\n` +
                            `フォーラム: <#${forum.id}>\n` +
                            `通知先チャンネル: <#${logChannel.id}>`,
                    });
                    return;
                }

                // /forum thread
                if (sub === 'thread') {
                    const forum = interaction.options.getChannel('forum', true);
                    const threadId = interaction.options.getString('thread_id', true);
                    const messageTemplate = interaction.options.getString('message', false);

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

                    // 通知先を追加
                    await kv.sAdd(forumTargetsKey(interaction.guildId, forum.id), targetThread.id);
                    await kv.sAdd(forumIndexKey(interaction.guildId), forum.id);

                    // メッセージテンプレートも targetId ごとに保存
                    if (messageTemplate) {
                        await kv.hSet(
                            forumMessageMapKey(interaction.guildId, forum.id),
                            targetThread.id,
                            messageTemplate
                        );
                    }

                    await interaction.reply({
                        content:
                            `フォーラム通知先を追加しました。\n` +
                            `フォーラム: <#${forum.id}>\n` +
                            `通知先スレッド: <#${targetThread.id}>`,
                    });
                    return;
                }

                // /forum show
                if (sub === 'show') {
                    const forumIds = await kv.sMembers(forumIndexKey(interaction.guildId));

                    if (!forumIds || forumIds.length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだフォーラム通知設定がありません。',
                        });
                        return;
                    }

                    const lines = [];

                    for (const forumId of forumIds) {
                        const targetIds = await kv.sMembers(forumTargetsKey(interaction.guildId, forumId));

                        if (!targetIds || targetIds.length === 0) {
                            continue;
                        }

                        lines.push(`フォーラム: <#${forumId}>`);

                        for (const targetId of targetIds) {
                            const customMessage = await kv.hGet(
                                forumMessageMapKey(interaction.guildId, forumId),
                                targetId
                            );

                            lines.push(
                                `　・通知先: <#${targetId}> / カスタム文面: ${customMessage ? 'あり' : 'なし'}`
                            );
                        }
                    }

                    if (lines.length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだフォーラム通知設定がありません。',
                        });
                        return;
                    }

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
                    const targetId = interaction.options.getString('target_id', false)?.trim();

                    if (forum.type !== ChannelType.GuildForum) {
                        await interaction.reply({
                            content: 'forum にはフォーラムチャンネルを指定してください。',
                        });
                        return;
                    }

                    const targetKey = forumTargetsKey(interaction.guildId, forum.id);
                    const messageKey = forumMessageMapKey(interaction.guildId, forum.id);

                    const targetIds = await kv.sMembers(targetKey);

                    if (!targetIds || targetIds.length === 0) {
                        await interaction.reply({
                            content: `そのフォーラムの設定は見つかりませんでした: <#${forum.id}>`,
                        });
                        return;
                    }

                    // target_id が指定されている → 1件だけ削除
                    if (targetId) {
                        const removed = await kv.sRem(targetKey, targetId);

                        if (!removed) {
                            await interaction.reply({
                                content:
                                    `フォーラム <#${forum.id}> に、通知先 <#${targetId}> の設定は見つかりませんでした。`,
                            });
                            return;
                        }

                        // その通知先に対応するカスタム文面も消す
                        await kv.hDel(messageKey, targetId);

                        // 残り通知先が0件なら、indexからも外してキー削除
                        const remainingTargets = await kv.sMembers(targetKey);
                        if (!remainingTargets || remainingTargets.length === 0) {
                            await kv.del(targetKey);
                            await kv.del(messageKey);
                            await kv.sRem(forumIndexKey(interaction.guildId), forum.id);
                        }

                        await interaction.reply({
                            content:
                                `フォーラム <#${forum.id}> から通知先 <#${targetId}> を削除しました。`,
                        });
                        return;
                    }

                    // target_id が指定されていない → 全部削除
                    await kv.del(targetKey);
                    await kv.del(messageKey);
                    await kv.sRem(forumIndexKey(interaction.guildId), forum.id);

                    await interaction.reply({
                        content: `フォーラム <#${forum.id}> に紐づく通知先をすべて削除しました。`,
                    });
                    return;
                }
                // /forum placeholders
                if (sub === 'placeholders') {
                    await interaction.reply({
                        content:
                            '## カスタムメッセージで使えるプレースホルダ一覧\n' +
                            '・`{forum}` → フォーラムメンション\n' +
                            '・`{forumName}` → フォーラム名\n' +
                            '・`{thread}` → スレッド名\n' +
                            '・`{author}` → スレ主メンション\n' +
                            '・`{link}` → スレッドURL\n' +
                            '\n' +
                            '## 改行の書き方\n' +
                            '改行したい場合は `\\n` を使ってください。\n' +
                            '\n' +
                            '## 例\n' +
                            '```txt\n' +
                            '{forum} に新しいスレッドが作成されました！\\n' +
                            'スレ主: {author}\\n' +
                            'リンク: {link}\n' +
                            '```',
                        ephemeral: true,
                    });
                    return;
                }
            }

            // =========================================================
            // /role 系
            // =========================================================
            if (interaction.commandName === 'role') {
                const group = interaction.options.getSubcommandGroup();
                const sub = interaction.options.getSubcommand();

                // /role missing list
                if (group === 'missing' && sub === 'list') {
                    const targetRole = interaction.options.getRole('role', true);

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

                    const lines = membersWithoutRole.map(
                        (member) => `・${member.user.tag} (<@${member.id}>)`
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

                // /role missing mention
                if (group === 'missing' && sub === 'mention') {
                    const targetRole = interaction.options.getRole('role', true);

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

                // /role channelnever list
                if (group === 'channelnever' && sub === 'list') {
                    const targetRole = interaction.options.getRole('role', true);
                    const channel = interaction.options.getChannel('channel', true);

                    if (channel.type !== ChannelType.GuildText) {
                        await interaction.reply({
                            content: 'channel には通常のテキストチャンネルを指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.deferReply({ ephemeral: true });

                    const { speakerIds, fetchedCount } = await collectSpeakerIdsFromChannel(channel);

                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) =>
                            !member.user.bot &&
                            !member.roles.cache.has(targetRole.id) &&
                            !speakerIds.has(member.id)
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.editReply({
                            content:
                                `ロール <@&${targetRole.id}> を持っておらず、` +
                                `チャンネル <#${channel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーはいません。`,
                        });
                        return;
                    }

                    const lines = filteredMembers.map(
                        (member) => `・${member.user.tag} (<@${member.id}>)`
                    );

                    const chunks = splitLinesToMessages(
                        `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${channel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバー一覧:\n`,
                        lines
                    );

                    await interaction.editReply({
                        content: chunks[0],
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({
                            content: chunks[i],
                            ephemeral: true,
                        });
                    }

                    return;
                }

                // /role channelnever mention
                if (group === 'channelnever' && sub === 'mention') {
                    const targetRole = interaction.options.getRole('role', true);
                    const channel = interaction.options.getChannel('channel', true);

                    if (channel.type !== ChannelType.GuildText) {
                        await interaction.reply({
                            content: 'channel には通常のテキストチャンネルを指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.deferReply({ ephemeral: true });

                    const { speakerIds, fetchedCount } = await collectSpeakerIdsFromChannel(channel);

                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) =>
                            !member.user.bot &&
                            !member.roles.cache.has(targetRole.id) &&
                            !speakerIds.has(member.id)
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.editReply({
                            content:
                                `ロール <@&${targetRole.id}> を持っておらず、` +
                                `チャンネル <#${channel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーはいません。`,
                        });
                        return;
                    }

                    const rawMentions = filteredMembers.map((member) => `<@${member.id}>`);
                    const chunks = splitBySpaceToMessages('', rawMentions);

                    await interaction.editReply({
                        content:
                            `ロール <@&${targetRole.id}> を持っておらず、` +
                            `チャンネル <#${channel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーのコピペ用メンションです。\n` +
                            `下のコードブロックをコピーして使ってください。\n\n` +
                            '```txt\n' +
                            chunks[0] +
                            '\n```',
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({
                            content: '```txt\n' + chunks[i] + '\n```',
                            ephemeral: true,
                        });
                    }

                    return;
                }

                // /role filter list
                if (group === 'filter' && sub === 'list') {
                    const hasRole = interaction.options.getRole('has', true);
                    const notRole = interaction.options.getRole('not', true);

                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) =>
                            !member.user.bot &&
                            member.roles.cache.has(hasRole.id) &&
                            !member.roles.cache.has(notRole.id)
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.reply({
                            content: `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーはいません。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    const lines = filteredMembers.map(
                        (member) => `・${member.user.tag} (<@${member.id}>)`
                    );

                    const chunks = splitLinesToMessages(
                        `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバー一覧:\n`,
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

                // /role filter mention
                if (group === 'filter' && sub === 'mention') {
                    const hasRole = interaction.options.getRole('has', true);
                    const notRole = interaction.options.getRole('not', true);

                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) =>
                            !member.user.bot &&
                            member.roles.cache.has(hasRole.id) &&
                            !member.roles.cache.has(notRole.id)
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.reply({
                            content: `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーはいません。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    const rawMentions = filteredMembers.map((member) => `<@${member.id}>`);
                    const chunks = splitBySpaceToMessages('', rawMentions);

                    await interaction.reply({
                        content:
                            `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーのコピペ用メンションです。\n` +
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

            if (interaction.deferred) {
                await interaction.editReply({
                    content: 'コマンド実行中にエラーが発生しました。',
                }).catch(() => null);
            } else if (interaction.replied) {
                await interaction.followUp({
                    content: 'コマンド実行中にエラーが発生しました。',
                    ephemeral: true,
                }).catch(() => null);
            } else {
                await interaction.reply({
                    content: 'コマンド実行中にエラーが発生しました。',
                    ephemeral: true,
                }).catch(() => null);
            }
        }
    });

    // =========================================================
    // フォーラムに新しいスレッドが立ったら通知
    // =========================================================
    client.on(Events.ThreadCreate, async (thread) => {
        try {
            if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

            const targetIds = await kv.sMembers(forumTargetsKey(thread.guildId, thread.parentId));
            if (!targetIds || targetIds.length === 0) return;

            const ownerMention = thread.ownerId ? `<@${thread.ownerId}>` : '不明';
            const threadLink =
                thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;
            const forumMention = `<#${thread.parentId}>`;
            const forumName = thread.parent.name ?? 'フォーラム';
            const threadName = thread.name ?? '無題';

            for (const targetId of targetIds) {
                const customTemplate = await kv.hGet(
                    forumMessageMapKey(thread.guildId, thread.parentId),
                    targetId
                );

                const template = customTemplate || DEFAULT_FORUM_MESSAGE_TEMPLATE;

                const message = renderForumMessage(template, {
                    forumMention,
                    forumName,
                    threadName,
                    authorMention: ownerMention,
                    threadLink,
                });

                const result = await sendToTarget(client, targetId, message);

                if (!result.ok) {
                    console.warn(`通知送信失敗: ${result.reason}, targetId=${targetId}`);
                }
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