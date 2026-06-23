const {
    Client,
    GatewayIntentBits,
    ChannelType,
    Events,
    PermissionFlagsBits,
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

const kv = createClient({ url: REDIS_URL });
kv.on('error', (error) => {
    console.error('Key Value 接続エラー:', error);
});

// ===== Redis キー =====
function forumTargetsKey(guildId, forumId) {
    return `forum-targets:${guildId}:${forumId}`;
}
function forumIndexKey(guildId) {
    return `forum-index:${guildId}`;
}
function forumMessageMapKey(guildId, forumId) {
    return `forum-message-map:${guildId}:${forumId}`;
}
function reactionRulesKey(guildId) {
    return `reaction-rules:${guildId}`;
}
function reactionAllowedBotsKey(guildId) {
    return `reaction-allowed-bots:${guildId}`;
}
function reactionRuleField(channelId, userId) {
    return `${channelId}:${userId}`;
}
function roleMentionTargetsKey(guildId) {
    return `role-mention-targets:${guildId}`;
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
        if (batch.size < 100) break;
    }

    return { speakerIds, fetchedCount };
}

// ===== フォーラム通知テンプレート =====
const DEFAULT_FORUM_MESSAGE_TEMPLATE =
    '{forum} に、新しいスレッドが作成されました！\\n' +
    'スレ主: {author}\\n' +
    'リンク: [{thread}]({link})';

function renderForumMessage(template, data) {
    return template
        .replaceAll('\\r\\n', '\n')
        .replaceAll('\\n', '\n')
        .replaceAll('{forum}', data.forumMention)
        .replaceAll('{forumName}', data.forumName)
        .replaceAll('{thread}', data.threadName)
        .replaceAll('{author}', data.authorMention)
        .replaceAll('{link}', data.threadLink);
}

function normalizeForumIdsInput(raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function resolveForumIds(client, guildId, singleForum, forumIdsRaw) {
    const result = { valid: [], invalid: [] };

    if (singleForum) {
        if (singleForum.type === ChannelType.GuildForum) {
            result.valid.push(singleForum.id);
        } else {
            result.invalid.push({ input: singleForum.id, reason: 'フォーラムではありません' });
        }
        return result;
    }

    const ids = normalizeForumIdsInput(forumIdsRaw || '');
    for (const id of ids) {
        const channel = await client.channels.fetch(id).catch(() => null);
        if (!channel) {
            result.invalid.push({ input: id, reason: '見つかりませんでした' });
            continue;
        }
        if (channel.guildId !== guildId) {
            result.invalid.push({ input: id, reason: 'このサーバーのフォーラムではありません' });
            continue;
        }
        if (channel.type !== ChannelType.GuildForum) {
            result.invalid.push({ input: id, reason: 'フォーラムではありません' });
            continue;
        }
        result.valid.push(channel.id);
    }

    result.valid = [...new Set(result.valid)];
    return result;
}

function parseReactionRules(hash) {
    return Object.entries(hash).map(([field, emoji]) => {
        const sep = field.indexOf(':');
        const channelId = field.slice(0, sep);
        const userId = field.slice(sep + 1);
        return { field, channelId, userId, emoji };
    });
}

async function main() {
    await kv.connect();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
        ],
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

                if (sub === 'channel') {
                    const forum = interaction.options.getChannel('forum', false);
                    const forumIdsRaw = interaction.options.getString('forum_ids', false);
                    const targetChannel = interaction.options.getChannel('target_channel', true);
                    const messageTemplate = interaction.options.getString('message', false);

                    if ((forum && forumIdsRaw) || (!forum && !forumIdsRaw)) {
                        await interaction.reply({
                            content: 'forum か forum_ids のどちらか片方だけを指定してください。',
                        });
                        return;
                    }

                    const allowedTargetTypes = [
                        ChannelType.GuildText,
                        ChannelType.PublicThread,
                        ChannelType.PrivateThread,
                        ChannelType.AnnouncementThread,
                    ];

                    if (!allowedTargetTypes.includes(targetChannel.type)) {
                        await interaction.reply({
                            content: 'target_channel にはテキストチャンネルまたは既存スレッドを指定してください。',
                        });
                        return;
                    }

                    const resolved = await resolveForumIds(client, interaction.guildId, forum, forumIdsRaw);

                    if (resolved.valid.length === 0) {
                        const failLines = resolved.invalid.map((item) => `・${item.input} → ${item.reason}`);
                        const chunks = splitLinesToMessages(
                            'フォーラム通知先を追加できませんでした。\n',
                            failLines.length > 0 ? failLines : ['・有効なフォーラムがありませんでした'],
                        );
                        await interaction.reply({ content: chunks[0] });
                        for (let i = 1; i < chunks.length; i++) {
                            await interaction.followUp({ content: chunks[i] });
                        }
                        return;
                    }

                    const successLines = [];
                    const failLines = [];

                    for (const forumId of resolved.valid) {
                        await kv.sAdd(forumTargetsKey(interaction.guildId, forumId), targetChannel.id);
                        await kv.sAdd(forumIndexKey(interaction.guildId), forumId);

                        if (messageTemplate) {
                            await kv.hSet(
                                forumMessageMapKey(interaction.guildId, forumId),
                                targetChannel.id,
                                messageTemplate,
                            );
                        }

                        successLines.push(`・<#${forumId}> → <#${targetChannel.id}>`);
                    }

                    for (const item of resolved.invalid) {
                        failLines.push(`・${item.input} → ${item.reason}`);
                    }

                    const previewMessage = messageTemplate ? messageTemplate.replaceAll('\\\\n', '\n') : null;
                    const lines = [
                        `通知先: <#${targetChannel.id}>`,
                        `カスタムメッセージ: ${messageTemplate ? 'あり' : 'なし'}`,
                        '',
                        '成功:',
                        ...successLines,
                        ...(failLines.length ? ['', '失敗:', ...failLines] : []),
                    ];

                    const chunks = splitLinesToMessages('フォーラム通知先を一括追加しました。\n', lines);
                    let firstContent = chunks[0];

                    if (previewMessage) {
                        firstContent += `\n設定メッセージ:\n\`\`\`txt\n${previewMessage}\n\`\`\``;
                    }

                    await interaction.reply({ content: firstContent });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i] });
                    }
                    return;
                }

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
                            '改行したい場合は `\\\\n` を使ってください。\n' +
                            '\n' +
                            '## 例\n' +
                            '```txt\n' +
                            '{forum} に新しいスレッドが作成されました！\\\\n' +
                            'スレ主: {author}\\\\n' +
                            'リンク: [{thread}]({link})\n' +
                            '```',
                        ephemeral: true,
                    });
                    return;
                }

                if (sub === 'show') {
                    const forumIds = await kv.sMembers(forumIndexKey(interaction.guildId));
                    if (!forumIds || forumIds.length === 0) {
                        await interaction.reply({ content: 'このサーバーにはまだフォーラム通知設定がありません。' });
                        return;
                    }

                    const lines = [];
                    for (const forumId of forumIds) {
                        const targetIds = await kv.sMembers(forumTargetsKey(interaction.guildId, forumId));
                        if (!targetIds || targetIds.length === 0) continue;

                        lines.push(`フォーラム: <#${forumId}>`);
                        for (const targetId of targetIds) {
                            const customMessage = await kv.hGet(
                                forumMessageMapKey(interaction.guildId, forumId),
                                targetId,
                            );
                            lines.push(`　・通知先: <#${targetId}> / カスタム文面: ${customMessage ? 'あり' : 'なし'}`);
                        }
                    }

                    if (lines.length === 0) {
                        await interaction.reply({ content: 'このサーバーにはまだフォーラム通知設定がありません。' });
                        return;
                    }

                    const chunks = splitLinesToMessages('現在のフォーラム通知設定一覧:\n', lines);
                    await interaction.reply({ content: chunks[0] });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i] });
                    }
                    return;
                }

                if (sub === 'unset') {
                    const forum = interaction.options.getChannel('forum', false);
                    const targetChannel = interaction.options.getChannel('target_channel', false);
                    const guildId = interaction.guildId;

                    if (!forum && !targetChannel) {
                        await interaction.reply({ content: 'forum か target_channel のどちらかは指定してください。' });
                        return;
                    }

                    if (forum && forum.type !== ChannelType.GuildForum) {
                        await interaction.reply({ content: 'forum にはフォーラムチャンネルを指定してください。' });
                        return;
                    }

                    const allowedTargetTypes = [
                        ChannelType.GuildText,
                        ChannelType.PublicThread,
                        ChannelType.PrivateThread,
                        ChannelType.AnnouncementThread,
                    ];

                    if (targetChannel && !allowedTargetTypes.includes(targetChannel.type)) {
                        await interaction.reply({ content: 'target_channel にはテキストチャンネルまたはスレッドを指定してください。' });
                        return;
                    }

                    const forumIds = await kv.sMembers(forumIndexKey(guildId));
                    if (!forumIds || forumIds.length === 0) {
                        await interaction.reply({ content: 'このサーバーにはまだフォーラム通知設定がありません。' });
                        return;
                    }

                    if (forum && targetChannel) {
                        const targetKey = forumTargetsKey(guildId, forum.id);
                        const messageKey = forumMessageMapKey(guildId, forum.id);
                        const removed = await kv.sRem(targetKey, targetChannel.id);

                        if (!removed) {
                            await interaction.reply({ content: `フォーラム <#${forum.id}> に、通知先 <#${targetChannel.id}> の設定は見つかりませんでした。` });
                            return;
                        }

                        await kv.hDel(messageKey, targetChannel.id);

                        const remainingTargets = await kv.sMembers(targetKey);
                        if (!remainingTargets || remainingTargets.length === 0) {
                            await kv.del(targetKey);
                            await kv.del(messageKey);
                            await kv.sRem(forumIndexKey(guildId), forum.id);
                        }

                        await interaction.reply({ content: `フォーラム <#${forum.id}> から通知先 <#${targetChannel.id}> を削除しました。` });
                        return;
                    }

                    if (forum && !targetChannel) {
                        const targetKey = forumTargetsKey(guildId, forum.id);
                        const messageKey = forumMessageMapKey(guildId, forum.id);
                        const targetIds = await kv.sMembers(targetKey);

                        if (!targetIds || targetIds.length === 0) {
                            await interaction.reply({ content: `そのフォーラムの設定は見つかりませんでした: <#${forum.id}>` });
                            return;
                        }

                        await kv.del(targetKey);
                        await kv.del(messageKey);
                        await kv.sRem(forumIndexKey(guildId), forum.id);

                        await interaction.reply({ content: `フォーラム <#${forum.id}> に紐づく通知先をすべて削除しました。` });
                        return;
                    }

                    if (!forum && targetChannel) {
                        let removedCount = 0;
                        const removedLines = [];

                        for (const forumId of forumIds) {
                            const targetKey = forumTargetsKey(guildId, forumId);
                            const messageKey = forumMessageMapKey(guildId, forumId);
                            const removed = await kv.sRem(targetKey, targetChannel.id);

                            if (removed) {
                                removedCount += 1;
                                removedLines.push(`・フォーラム <#${forumId}> から通知先 <#${targetChannel.id}> を削除`);
                                await kv.hDel(messageKey, targetChannel.id);

                                const remainingTargets = await kv.sMembers(targetKey);
                                if (!remainingTargets || remainingTargets.length === 0) {
                                    await kv.del(targetKey);
                                    await kv.del(messageKey);
                                    await kv.sRem(forumIndexKey(guildId), forumId);
                                }
                            }
                        }

                        if (removedCount === 0) {
                            await interaction.reply({ content: `通知先 <#${targetChannel.id}> に紐づく設定は見つかりませんでした。` });
                            return;
                        }

                        const chunks = splitLinesToMessages(
                            `通知先 <#${targetChannel.id}> に紐づく設定を ${removedCount} 件削除しました。\n`,
                            removedLines,
                        );
                        await interaction.reply({ content: chunks[0] });
                        for (let i = 1; i < chunks.length; i++) {
                            await interaction.followUp({ content: chunks[i] });
                        }
                        return;
                    }
                }
            }

            // =========================================================
            // /rolemention 系
            // =========================================================
            if (interaction.commandName === 'rolemention') {
                const sub = interaction.options.getSubcommand();

                if (sub === 'set') {
                    const role = interaction.options.getRole('role', true);
                    const targetChannel = interaction.options.getChannel('target_channel', true);

                    const allowedTargetTypes = [
                        ChannelType.GuildText,
                        ChannelType.PublicThread,
                        ChannelType.PrivateThread,
                        ChannelType.AnnouncementThread,
                    ];

                    if (!allowedTargetTypes.includes(targetChannel.type)) {
                        await interaction.reply({
                            content: 'target_channel にはチャンネルまたはスレッドを指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await kv.hSet(roleMentionTargetsKey(interaction.guildId), role.id, targetChannel.id);

                    await interaction.reply({
                        content:
                            `ロールメンション転載設定を登録しました。\n` +
                            `ロール: <@&${role.id}>\n` +
                            `転載先: <#${targetChannel.id}>`,
                        ephemeral: true,
                    });
                    return;
                }

                if (sub === 'show') {
                    const settings = await kv.hGetAll(roleMentionTargetsKey(interaction.guildId));
                    if (!settings || Object.keys(settings).length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだロールメンション転載設定がありません。',
                            ephemeral: true,
                        });
                        return;
                    }

                    const lines = Object.entries(settings).map(
                        ([roleId, targetId], index) =>
                            `${index + 1}. ロール: <@&${roleId}> → 転載先: <#${targetId}>`,
                    );

                    const chunks = splitLinesToMessages('現在のロールメンション転載設定一覧:\n', lines);
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

                if (sub === 'unset') {
                    const role = interaction.options.getRole('role', true);
                    const removed = await kv.hDel(roleMentionTargetsKey(interaction.guildId), role.id);

                    if (!removed) {
                        await interaction.reply({
                            content: `ロール <@&${role.id}> の転載設定は見つかりませんでした。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.reply({
                        content: `ロール <@&${role.id}> の転載設定を削除しました。`,
                        ephemeral: true,
                    });
                    return;
                }
            }

            // =========================================================
            // /reaction 系
            // =========================================================
            if (interaction.commandName === 'reaction') {
                const group = interaction.options.getSubcommandGroup(false);
                const sub = interaction.options.getSubcommand();

                if (sub === 'set') {
                    const targetChannel = interaction.options.getChannel('target_channel', true);
                    const user = interaction.options.getUser('user', true);
                    const emoji = interaction.options.getString('emoji', true).trim();

                    const allowedTargetTypes = [
                        ChannelType.GuildText,
                        ChannelType.PublicThread,
                        ChannelType.PrivateThread,
                        ChannelType.AnnouncementThread,
                    ];

                    if (!allowedTargetTypes.includes(targetChannel.type)) {
                        await interaction.reply({
                            content: 'target_channel にはテキストチャンネルまたはスレッドを指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await kv.hSet(
                        reactionRulesKey(interaction.guildId),
                        reactionRuleField(targetChannel.id, user.id),
                        emoji,
                    );

                    await interaction.reply({
                        content:
                            `自動リアクション設定を登録しました。\n` +
                            `対象チャンネル: <#${targetChannel.id}>\n` +
                            `ユーザー: <@${user.id}>\n` +
                            `絵文字: ${emoji}`,
                        ephemeral: true,
                    });
                    return;
                }

                if (sub === 'show') {
                    const rulesHash = await kv.hGetAll(reactionRulesKey(interaction.guildId));
                    const rules = parseReactionRules(rulesHash);

                    if (rules.length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだ自動リアクション設定がありません。',
                            ephemeral: true,
                        });
                        return;
                    }

                    const lines = rules.map(
                        (rule, index) =>
                            `${index + 1}. 対象チャンネル: <#${rule.channelId}> / ユーザー: <@${rule.userId}> / 絵文字: ${rule.emoji}`,
                    );

                    const chunks = splitLinesToMessages('現在の自動リアクション設定一覧:\n', lines);
                    await interaction.reply({ content: chunks[0], ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                    return;
                }

                if (sub === 'unset') {
                    const targetChannel = interaction.options.getChannel('target_channel', true);
                    const user = interaction.options.getUser('user', true);

                    const removed = await kv.hDel(
                        reactionRulesKey(interaction.guildId),
                        reactionRuleField(targetChannel.id, user.id),
                    );

                    if (!removed) {
                        await interaction.reply({
                            content: `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定は見つかりませんでした。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.reply({
                        content: `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定を削除しました。`,
                        ephemeral: true,
                    });
                    return;
                }

                if (group === 'allowbot' && sub === 'add') {
                    const user = interaction.options.getUser('user', true);
                    if (!user.bot) {
                        await interaction.reply({
                            content: 'bot アカウントを指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    await kv.sAdd(reactionAllowedBotsKey(interaction.guildId), user.id);
                    await interaction.reply({
                        content: `自動リアクション対象として Bot <@${user.id}> を許可しました。`,
                        ephemeral: true,
                    });
                    return;
                }

                if (group === 'allowbot' && sub === 'show') {
                    const botIds = await kv.sMembers(reactionAllowedBotsKey(interaction.guildId));
                    if (!botIds || botIds.length === 0) {
                        await interaction.reply({
                            content: 'このサーバーには、許可された Bot 一覧がまだありません。',
                            ephemeral: true,
                        });
                        return;
                    }

                    const lines = botIds.map((id, index) => `${index + 1}. <@${id}> (${id})`);
                    const chunks = splitLinesToMessages('自動リアクション対象として許可されている Bot 一覧:\n', lines);

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

                if (group === 'allowbot' && sub === 'remove') {
                    const user = interaction.options.getUser('user', true);
                    const removed = await kv.sRem(reactionAllowedBotsKey(interaction.guildId), user.id);

                    if (!removed) {
                        await interaction.reply({
                            content: `Bot <@${user.id}> は許可一覧にありませんでした。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    await interaction.reply({
                        content: `自動リアクション対象から Bot <@${user.id}> を削除しました。`,
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

                if (group === 'missing' && sub === 'list') {
                    const targetRole = interaction.options.getRole('role', true);
                    await interaction.guild.members.fetch();
                    const membersWithoutRole = interaction.guild.members.cache.filter((member) => !member.user.bot && !member.roles.cache.has(targetRole.id));

                    if (membersWithoutRole.size === 0) {
                        await interaction.reply({ content: `ロール <@&${targetRole.id}> を持っていないメンバーはいません。`, ephemeral: true });
                        return;
                    }

                    const lines = membersWithoutRole.map((member) => `・${member.user.tag} (<@${member.id}>)`);
                    const chunks = splitLinesToMessages(`ロール <@&${targetRole.id}> を持っていないメンバー一覧:\n`, lines);

                    await interaction.reply({ content: chunks[0], ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                    return;
                }

                if (group === 'missing' && sub === 'mention') {
                    const targetRole = interaction.options.getRole('role', true);
                    await interaction.guild.members.fetch();
                    const membersWithoutRole = interaction.guild.members.cache.filter((member) => !member.user.bot && !member.roles.cache.has(targetRole.id));

                    if (membersWithoutRole.size === 0) {
                        await interaction.reply({ content: `ロール <@&${targetRole.id}> を持っていないメンバーはいません。`, ephemeral: true });
                        return;
                    }

                    const rawMentions = membersWithoutRole.map((member) => `<@${member.id}>`);
                    const chunks = splitBySpaceToMessages('', rawMentions);

                    await interaction.reply({
                        content:
                            `ロール <@&${targetRole.id}> を持っていないメンバーのコピペ用メンションです。\n` +
                            `下のコードブロックをコピーして使ってください。\n\n` +
                            '```txt\n' + chunks[0] + '\n```',
                        ephemeral: true,
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: '```txt\n' + chunks[i] + '\n```', ephemeral: true });
                    }
                    return;
                }

                if (group === 'channelnever' && sub === 'list') {
                    const targetRole = interaction.options.getRole('role', true);
                    const sourceChannel = interaction.options.getChannel('source_channel', true);

                    if (sourceChannel.type !== ChannelType.GuildText) {
                        await interaction.reply({ content: 'source_channel には通常のテキストチャンネルを指定してください。', ephemeral: true });
                        return;
                    }

                    await interaction.deferReply({ ephemeral: true });
                    const { speakerIds, fetchedCount } = await collectSpeakerIdsFromChannel(sourceChannel);
                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && !member.roles.cache.has(targetRole.id) && !speakerIds.has(member.id),
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.editReply({
                            content: `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーはいません。`,
                        });
                        return;
                    }

                    const lines = filteredMembers.map((member) => `・${member.user.tag} (<@${member.id}>)`);
                    const chunks = splitLinesToMessages(
                        `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバー一覧:\n`,
                        lines,
                    );

                    await interaction.editReply({ content: chunks[0] });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                    return;
                }

                if (group === 'channelnever' && sub === 'mention') {
                    const targetRole = interaction.options.getRole('role', true);
                    const sourceChannel = interaction.options.getChannel('source_channel', true);

                    if (sourceChannel.type !== ChannelType.GuildText) {
                        await interaction.reply({ content: 'source_channel には通常のテキストチャンネルを指定してください。', ephemeral: true });
                        return;
                    }

                    await interaction.deferReply({ ephemeral: true });
                    const { speakerIds, fetchedCount } = await collectSpeakerIdsFromChannel(sourceChannel);
                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && !member.roles.cache.has(targetRole.id) && !speakerIds.has(member.id),
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.editReply({
                            content: `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーはいません。`,
                        });
                        return;
                    }

                    const rawMentions = filteredMembers.map((member) => `<@${member.id}>`);
                    const chunks = splitBySpaceToMessages('', rawMentions);

                    await interaction.editReply({
                        content:
                            `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーのコピペ用メンションです。\n` +
                            `下のコードブロックをコピーして使ってください。\n\n` +
                            '```txt\n' + chunks[0] + '\n```',
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: '```txt\n' + chunks[i] + '\n```', ephemeral: true });
                    }
                    return;
                }

                if (group === 'filter' && sub === 'list') {
                    const hasRole = interaction.options.getRole('has', true);
                    const notRole = interaction.options.getRole('not', true);
                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && member.roles.cache.has(hasRole.id) && !member.roles.cache.has(notRole.id),
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.reply({ content: `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーはいません。`, ephemeral: true });
                        return;
                    }

                    const lines = filteredMembers.map((member) => `・${member.user.tag} (<@${member.id}>)`);
                    const chunks = splitLinesToMessages(
                        `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバー一覧:\n`,
                        lines,
                    );

                    await interaction.reply({ content: chunks[0], ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                    return;
                }

                if (group === 'filter' && sub === 'mention') {
                    const hasRole = interaction.options.getRole('has', true);
                    const notRole = interaction.options.getRole('not', true);
                    await interaction.guild.members.fetch();

                    const filteredMembers = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && member.roles.cache.has(hasRole.id) && !member.roles.cache.has(notRole.id),
                    );

                    if (filteredMembers.size === 0) {
                        await interaction.reply({ content: `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーはいません。`, ephemeral: true });
                        return;
                    }

                    const rawMentions = filteredMembers.map((member) => `<@${member.id}>`);
                    const chunks = splitBySpaceToMessages('', rawMentions);

                    await interaction.reply({
                        content:
                            `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーのコピペ用メンションです。\n` +
                            `下のコードブロックをコピーして使ってください。\n\n` +
                            '```txt\n' + chunks[0] + '\n```',
                        ephemeral: true,
                    });

                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: '```txt\n' + chunks[i] + '\n```', ephemeral: true });
                    }
                    return;
                }
            }

            // =========================================================
            // /hasrole 系
            // =========================================================
            if (interaction.commandName === 'hasrole') {
                const sub = interaction.options.getSubcommand();

                if (sub === 'list') {
                    const targetRole = interaction.options.getRole('role', true);
                    await interaction.guild.members.fetch();

                    const membersWithRole = interaction.guild.members.cache.filter(
                        (member) => !member.user.bot && member.roles.cache.has(targetRole.id),
                    );

                    if (membersWithRole.size === 0) {
                        await interaction.reply({
                            content: `ロール <@&${targetRole.id}> を持っているメンバーはいません。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    const lines = membersWithRole.map((member) => `・${member.user.tag} (<@${member.id}>)`);
                    const chunks = splitLinesToMessages(
                        `ロール <@&${targetRole.id}> を持っているメンバー一覧:\n`,
                        lines,
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
            }
        } catch (error) {
            console.error('interactionCreate でエラー:', error);
            if (interaction.deferred) {
                await interaction.editReply({ content: 'コマンド実行中にエラーが発生しました。' }).catch(() => null);
            } else if (interaction.replied) {
                await interaction.followUp({ content: 'コマンド実行中にエラーが発生しました。', ephemeral: true }).catch(() => null);
            } else {
                await interaction.reply({ content: 'コマンド実行中にエラーが発生しました。', ephemeral: true }).catch(() => null);
            }
        }
    });

    // =========================================================
    // メッセージ送信時の自動リアクション
    // =========================================================
    client.on(Events.MessageCreate, async (message) => {
        try {
            if (!message.guild) return;

            // 自分自身のBotには反応しない
            if (message.author.id === client.user.id) return;

            // Bot投稿は原則無視。ただし許可済みBotだけ通す
            if (message.author.bot) {
                const isAllowedBot = await kv.sIsMember(
                    reactionAllowedBotsKey(message.guildId),
                    message.author.id,
                );

                if (!isAllowedBot) return;
            }

            const emoji = await kv.hGet(
                reactionRulesKey(message.guildId),
                reactionRuleField(message.channelId, message.author.id),
            );

            if (!emoji) return;
            await message.react(emoji);
        } catch (error) {
            console.error('messageCreate で自動リアクション付与失敗:', error);
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
            const threadLink = thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;
            const forumMention = `<#${thread.parentId}>`;
            const forumName = thread.parent.name ?? 'フォーラム';
            const threadName = thread.name ?? '無題';

            for (const targetId of targetIds) {
                const customTemplate = await kv.hGet(forumMessageMapKey(thread.guildId, thread.parentId), targetId);
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

    // =========================================================
    // ロールメンションがあったメッセージのリンクを転載
    // =========================================================
    client.on(Events.MessageCreate, async (message) => {
        try {
            if (!message.guild) return;
            if (message.author.bot) return;
            if (!message.mentions.roles || message.mentions.roles.size === 0) return;

            const settings = await kv.hGetAll(roleMentionTargetsKey(message.guildId));
            if (!settings || Object.keys(settings).length === 0) return;

            const targets = new Map();

            for (const role of message.mentions.roles.values()) {
                const targetId = settings[role.id];
                if (!targetId) continue;

                if (!targets.has(targetId)) {
                    targets.set(targetId, []);
                }
                targets.get(targetId).push(role.id);
            }

            if (targets.size === 0) return;

            for (const [targetId, roleIds] of targets.entries()) {
                const roleMentions = roleIds.map((id) => `<@&${id}>`).join(' ');

                const content =
                    `ロールメンションがありました。\n` +
                    `ロール: ${roleMentions}\n` +
                    `送信者: <@${message.author.id}>\n` +
                    `場所: <#${message.channelId}>\n` +
                    `リンク: ${message.url}`;

                const result = await sendToTarget(client, targetId, content);

                if (!result.ok) {
                    console.warn(`ロールメンション転載失敗: ${result.reason}, targetId=${targetId}`);
                }
            }
        } catch (error) {
            console.error('messageCreate でロールメンション転載失敗:', error);
        }
    });

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