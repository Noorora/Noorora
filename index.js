const {
    Client,
    GatewayIntentBits,
    ChannelType,
    Events,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    WebhookClient,
} = require('discord.js');
const { createClient } = require('redis');
const express = require('express');
const crypto = require('crypto');

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
function pendingCleanupKey(token) {
    return `pending-cleanup:${token}`;
}
function roleMentionMessageMapKey(guildId) {
    return `role-mention-message-map:${guildId}`;
}
function forwardTargetsKey(guildId, sourceChannelId) {
    return `forward-targets:${guildId}:${sourceChannelId}`;
}

function forwardIndexKey(guildId) {
    return `forward-index:${guildId}`;
}
function forwardWebhookTargetsKey(guildId, sourceChannelId) {
    return `forward-webhook-targets:${guildId}:${sourceChannelId}`;
}

function forwardWebhookIndexKey(guildId) {
    return `forward-webhook-index:${guildId}`;
}

function forwardAllowedBotsKey(guildId, sourceChannelId) {
    return `forward-allowed-bots:${guildId}:${sourceChannelId}`;
}

function forwardAllowedWebhooksKey(guildId, sourceChannelId) {
    return `forward-allowed-webhooks:${guildId}:${sourceChannelId}`;
}

const FORWARD_ALL_CHANNELS = '__all__';

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

async function normalizeCustomEmojiText(message, text) {
    if (!text || !message.guild) return text;

    const emojiNamePattern = /:([a-zA-Z0-9_]+):/g;

    let guildEmojis;
    try {
        guildEmojis = await message.guild.emojis.fetch();
    } catch (error) {
        console.warn('絵文字一覧の取得に失敗:', error);
        return text;
    }

    return text.replace(emojiNamePattern, (match, emojiName) => {
        const emoji = guildEmojis.find((item) => item.name === emojiName);

        if (!emoji) {
            console.log(`[emoji normalize] not found: ${emojiName}`);
            return match;
        }

        const converted = emoji.animated
            ? `<a:${emoji.name}:${emoji.id}>`
            : `<:${emoji.name}:${emoji.id}>`;

        console.log(`[emoji normalize] ${match} -> ${converted}`);

        return converted;
    });
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

function toPlainCustomEmojiText(text) {
    if (!text) return text;

    return text
        .replace(/<a:([a-zA-Z0-9_]+):\d{17,20}>/g, ':$1:')
        .replace(/<:([a-zA-Z0-9_]+):\d{17,20}>/g, ':$1:');
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
        await target.send({
            content: message,
            allowedMentions: {
                parse: [],
            },
        });
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

// ===== ロールメンション転載テンプレート =====
const DEFAULT_ROLE_MENTION_MESSAGE_TEMPLATE =
    '送信主：{author}\\n' +
    '{body_quote}\\n' +
    '{link}';

function buildHelpLines() {
    return [
        '## Bot使い方マニュアル',
        '',
        'このBotは、フォーラム通知、ロールメンション転載、自動リアクション、ロール確認、Webhook転送などを行えます。',
        '',
        '---',
        '',
        '## /forum',
        'フォーラム通知設定を管理します。',
        '',
        '### /forum channel',
        '指定したフォーラムに新しいスレッドが作成されたとき、指定チャンネルまたはスレッドへ通知します。',
        '',
        '例:',
        '`/forum channel target_channel:#通知先 forum:#フォーラム`',
        '`/forum channel target_channel:#通知先 forum_ids:123,456,789`',
        '',
        '### /forum show',
        '現在のフォーラム通知設定を表示します。',
        '消えている通知先がある場合は、一括削除または個別削除できます。',
        '',
        '### /forum unset',
        'フォーラム通知設定を削除します。',
        '',
        '### /forum placeholders',
        'フォーラム通知メッセージで使えるプレースホルダ一覧を表示します。',
        '',
        '---',
        '',
        '## /rolemention',
        '特定ロールがメンションされた投稿を、別チャンネルまたはスレッドへ転載します。',
        '',
        '### /rolemention set',
        'ロールメンション転載設定を追加します。',
        '',
        '例:',
        '`/rolemention set role:@対象ロール target_channel:#転載先`',
        '',
        '### /rolemention show',
        '現在のロールメンション転載設定を表示します。',
        '消えている転載先がある場合は、一括削除または個別削除できます。',
        '',
        '### /rolemention unset',
        '指定ロールの転載設定を削除します。',
        '',
        '### /rolemention placeholders',
        'ロールメンション転載メッセージで使えるプレースホルダ一覧を表示します。',
        '',
        '---',
        '',
        '## /reaction',
        '指定チャンネルで、指定ユーザーの投稿に自動リアクションを付けます。',
        '',
        '### /reaction set',
        '自動リアクション設定を追加します。',
        '',
        '例:',
        '`/reaction set target_channel:#対象チャンネル user:@対象ユーザー emoji:✅`',
        '',
        '### /reaction show',
        '現在の自動リアクション設定一覧を表示します。',
        '',
        '### /reaction unset',
        '自動リアクション設定を削除します。',
        '',
        '### /reaction allowbot add/show/remove',
        'Bot投稿も自動リアクション対象にしたい場合、許可Botを管理します。',
        '',
        '---',
        '',
        '## /forward',
        '特定チャンネルの投稿を、Webhookを使って別チャンネルへ転送します。',
        '別サーバーへの転送も可能です。',
        '',
        '### /forward set',
        '転送元チャンネルと転送先Webhook URLを登録します。',
        '',
        '例:',
        '`/forward set source_channel:#転送元 target_webhook_url:https://discord.com/api/webhooks/...`',
        '',
        '### /forward show',
        '転送設定、許可Bot、許可Webhookをまとめて表示します。',
        '',
        '### /forward unset',
        '転送先Webhook URLの設定を削除します。',
        '',
        '### /forward allow add',
        '転送を許可するBotまたはWebhookを追加します。',
        '',
        '例:',
        '`/forward allow add source_channel:#転送元 type:webhook id:1520969045063405628`',
        '`/forward allow add source_channel:#転送元 type:bot id:123456789012345678`',
        '',
        '### /forward allow remove',
        '転送許可対象を削除します。',
        '',
        '例:',
        '`/forward allow remove source_channel:#転送元 type:webhook id:1520969045063405628`',
        '',
        '### 転送仕様',
        '・人間の投稿はそのまま転送対象になります。',
        '・Bot投稿は、許可Botに登録されている場合だけ転送されます。',
        '・Webhook投稿は、許可Webhookに登録されている場合だけ転送されます。',
        '・転送時のメンション通知は飛ばさない設定です。',
        '・添付ファイルはWebhook転送で一緒に送信できます。',
        '',
        '---',
        '',
        '## /role',
        'ロール条件でメンバー一覧やコピペ用メンションを表示します。',
        '',
        '### /role missing list',
        '指定ロールを持っていないメンバー一覧を表示します。',
        '',
        '### /role missing mention',
        '指定ロールを持っていないメンバーのコピペ用メンションを表示します。',
        '',
        '### /role channelnever list',
        '指定ロールを持っておらず、指定チャンネルで一度も発言していないメンバーを表示します。',
        '',
        '### /role channelnever mention',
        '上記条件に当てはまるメンバーのコピペ用メンションを表示します。',
        '',
        '### /role filter list',
        'あるロールを持ち、別のロールを持っていないメンバーを表示します。',
        '',
        '### /role filter mention',
        '上記条件に当てはまるメンバーのコピペ用メンションを表示します。',
        '',
        '---',
        '',
        '## /hasrole',
        '指定したロールを持っているメンバー一覧を表示します。',
        '',
        '例:',
        '`/hasrole list role:@対象ロール`',
        '',
        '---',
        '',
        '## 注意',
        '・管理系コマンドは基本的にサーバー管理権限を持つ人向けです。',
        '・Webhook URLは秘密情報です。公開チャンネルやGitHubなどに貼らないでください。',
        '・転送ループを防ぐため、このBot自身の投稿は転送しません。',
    ];
}

function renderRoleMentionMessage(template, data) {
    return template
        .replaceAll('\\r\\n', '\n')
        .replaceAll('\\n', '\n')
        .replaceAll('{author}', data.authorMention)
        .replaceAll('{roles}', data.roleMentions)
        .replaceAll('{channel}', data.channelMention)
        .replaceAll('{link}', data.messageLink)
        .replaceAll('{body}', data.body)
        .replaceAll('{body_quote}', data.bodyQuote);
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

function buildCleanupChoiceButtons(kind, token) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cleanup_all:${kind}:${token}`)
                .setLabel('一括削除')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`cleanup_pick:${kind}:${token}:0`)
                .setLabel('個別削除')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`cleanup_cancel:${kind}:${token}`)
                .setLabel('キャンセル')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildCleanupEntryButtons(kind, token, staleEntries, page = 0, pageSize = 10) {
    const rows = [];
    const start = page * pageSize;
    const pageEntries = staleEntries.slice(start, start + pageSize);

    for (let rowIndex = 0; rowIndex < Math.ceil(pageEntries.length / 5); rowIndex++) {
        const row = new ActionRowBuilder();
        for (let i = rowIndex * 5; i < Math.min((rowIndex + 1) * 5, pageEntries.length); i++) {
            const absoluteIndex = start + i;
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`cleanup_one:${kind}:${token}:${absoluteIndex}:${page}`)
                    .setLabel(String(absoluteIndex + 1))
                    .setStyle(ButtonStyle.Danger),
            );
        }
        rows.push(row);
    }

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cleanup_pick:${kind}:${token}:${Math.max(page - 1, 0)}`)
            .setLabel('前へ')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`cleanup_pick:${kind}:${token}:${page + 1}`)
            .setLabel('次へ')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(start + pageSize >= staleEntries.length),
        new ButtonBuilder()
            .setCustomId(`cleanup_back:${kind}:${token}`)
            .setLabel('選択画面に戻る')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`cleanup_cancel:${kind}:${token}`)
            .setLabel('キャンセル')
            .setStyle(ButtonStyle.Secondary),
    );
    rows.push(navRow);

    return rows;
}

function buildStaleSummaryContent(kind, validLines, staleLines) {
    const title =
        kind === 'forum'
            ? '現在のフォーラム通知設定一覧:'
            : '現在のロールメンション転載設定一覧:';

    return [
        title,
        `有効な設定: ${validLines.length} 行`,
        `削除候補: ${staleLines.length} 件`,
        '',
        '消えている転送先が見つかりました。',
        '「一括削除」または「個別削除」を選んでください。',
    ].join('\n');
}

function buildStaleSelectionContent(kind, staleLines, page = 0, pageSize = 10) {
    const title =
        kind === 'forum'
            ? 'フォーラム通知設定の個別削除'
            : 'ロールメンション転載設定の個別削除';

    const start = page * pageSize;
    const pageLines = staleLines.slice(start, start + pageSize);
    const numberedLines = pageLines.map((line, index) => `${start + index + 1}. ${line}`);

    const totalPages = Math.max(1, Math.ceil(staleLines.length / pageSize));

    return [
        title,
        `ページ ${page + 1}/${totalPages}`,
        '',
        ...numberedLines,
        '',
        '削除したい番号のボタンを押してください。',
    ].join('\n');
}

async function collectForumShowData(client, guildId) {
    const forumIds = await kv.sMembers(forumIndexKey(guildId));
    const validLines = [];
    const staleEntries = [];

    for (const forumId of forumIds) {
        const forumChannel = await client.channels.fetch(forumId).catch(() => null);
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum || forumChannel.guildId !== guildId) {
            staleEntries.push({ type: 'forum_missing', forumId });
            continue;
        }

        const targetIds = await kv.sMembers(forumTargetsKey(guildId, forumId));
        if (!targetIds || targetIds.length === 0) continue;

        validLines.push(`フォーラム: <#${forumId}>`);
        for (const targetId of targetIds) {
            const targetChannel = await client.channels.fetch(targetId).catch(() => null);
            if (!targetChannel || targetChannel.guildId !== guildId || typeof targetChannel.send !== 'function') {
                staleEntries.push({ type: 'target_missing', forumId, targetId });
                continue;
            }

            const customMessage = await kv.hGet(
                forumMessageMapKey(guildId, forumId),
                targetId,
            );
            validLines.push(`　・通知先: <#${targetId}> / カスタム文面: ${customMessage ? 'あり' : 'なし'}`);
        }
    }

    return { validLines, staleEntries };
}

async function applySingleForumCleanup(guildId, entry) {
    if (entry.type === 'forum_missing') {
        const targetKey = forumTargetsKey(guildId, entry.forumId);
        const messageKey = forumMessageMapKey(guildId, entry.forumId);
        await kv.del(targetKey);
        await kv.del(messageKey);
        await kv.sRem(forumIndexKey(guildId), entry.forumId);
        return `・削除: 消失したフォーラム <#${entry.forumId}> に紐づく通知設定`;
    }

    if (entry.type === 'target_missing') {
        const targetKey = forumTargetsKey(guildId, entry.forumId);
        const messageKey = forumMessageMapKey(guildId, entry.forumId);
        await kv.sRem(targetKey, entry.targetId);
        await kv.hDel(messageKey, entry.targetId);

        const remainingTargets = await kv.sMembers(targetKey);
        if (!remainingTargets || remainingTargets.length === 0) {
            await kv.del(targetKey);
            await kv.del(messageKey);
            await kv.sRem(forumIndexKey(guildId), entry.forumId);
        }

        return `・削除: フォーラム <#${entry.forumId}> → 消失した通知先 <#${entry.targetId}>`;
    }

    return null;
}

async function applyForumCleanup(guildId, staleEntries) {
    const processed = new Set();
    const removedLines = [];

    for (const entry of staleEntries) {
        const key = `${entry.type}:${entry.forumId}:${entry.targetId || ''}`;
        if (processed.has(key)) continue;
        processed.add(key);

        const removedLine = await applySingleForumCleanup(guildId, entry);
        if (removedLine) removedLines.push(removedLine);
    }

    return removedLines;
}

async function collectRoleMentionShowData(client, guildId) {
    const settings = await kv.hGetAll(roleMentionTargetsKey(guildId));
    const validLines = [];
    const staleEntries = [];

    for (const [roleId, targetId] of Object.entries(settings)) {
        const targetChannel = await client.channels.fetch(targetId).catch(() => null);
        if (!targetChannel || targetChannel.guildId !== guildId || typeof targetChannel.send !== 'function') {
            staleEntries.push({ roleId, targetId });
            continue;
        }

        const customMessage = await kv.hGet(roleMentionMessageMapKey(guildId), roleId);
        validLines.push(`ロール: <@&${roleId}> → 転載先: <#${targetId}> / カスタム文面: ${customMessage ? 'あり' : 'なし'}`);
    }

    return { validLines, staleEntries };
}

async function applySingleRoleMentionCleanup(guildId, entry) {
    await kv.hDel(roleMentionTargetsKey(guildId), entry.roleId);
    await kv.hDel(roleMentionMessageMapKey(guildId), entry.roleId);
    return `・削除: ロール <@&${entry.roleId}> → 消失した転載先 <#${entry.targetId}>`;
}

async function applyRoleMentionCleanup(guildId, staleEntries) {
    const processed = new Set();
    const removedLines = [];

    for (const entry of staleEntries) {
        const key = `${entry.roleId}:${entry.targetId}`;
        if (processed.has(key)) continue;
        processed.add(key);

        const removedLine = await applySingleRoleMentionCleanup(guildId, entry);
        if (removedLine) removedLines.push(removedLine);
    }

    return removedLines;
}

async function main() {
    await kv.connect();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildExpressions,
        ],
    });

    client.once(Events.ClientReady, (readyClient) => {
        console.log(`ログイン完了: ${readyClient.user.tag}`);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton()) {
            try {
                const parts = interaction.customId.split(':');
                const action = parts[0];
                const kind = parts[1];
                const token = parts[2];

                if (!['cleanup_all', 'cleanup_pick', 'cleanup_back', 'cleanup_cancel', 'cleanup_one'].includes(action)) {
                    return;
                }

                const pendingRaw = await kv.get(pendingCleanupKey(token));
                if (!pendingRaw) {
                    await interaction.reply({
                        content: '確認情報の有効期限が切れたため、もう一度 show を実行してください。',
                        ephemeral: true,
                    });
                    return;
                }

                const pending = JSON.parse(pendingRaw);
                if (pending.guildId !== interaction.guildId || pending.kind !== kind) {
                    await interaction.reply({
                        content: 'この確認情報は現在のサーバーでは使用できません。',
                        ephemeral: true,
                    });
                    return;
                }

                const staleEntries = pending.staleEntries || [];
                const staleLines = pending.staleLines || [];
                const validLines = pending.validLines || [];

                if (action === 'cleanup_cancel') {
                    await kv.del(pendingCleanupKey(token));
                    await interaction.update({
                        content: '削除をキャンセルしました。',
                        components: [],
                    });
                    return;
                }

                if (action === 'cleanup_back') {
                    await interaction.update({
                        content: buildStaleSummaryContent(kind, validLines, staleLines),
                        components: buildCleanupChoiceButtons(kind, token),
                    });
                    return;
                }

                if (action === 'cleanup_pick') {
                    const page = Number(parts[3] || 0);
                    await interaction.update({
                        content: buildStaleSelectionContent(kind, staleLines, page),
                        components: buildCleanupEntryButtons(kind, token, staleEntries, page),
                    });
                    return;
                }

                if (action === 'cleanup_all') {
                    let removedLines = [];
                    if (kind === 'forum') {
                        removedLines = await applyForumCleanup(interaction.guildId, staleEntries);
                    } else if (kind === 'rolemention') {
                        removedLines = await applyRoleMentionCleanup(interaction.guildId, staleEntries);
                    }

                    await kv.del(pendingCleanupKey(token));

                    const summary =
                        removedLines.length === 0
                            ? '削除対象はありませんでした。'
                            : `一括削除を完了しました。 ${removedLines.length} 件の設定を削除しました。`;

                    await interaction.update({
                        content: summary,
                        components: [],
                    });

                    if (removedLines.length > 0) {
                        const chunks = splitLinesToMessages('削除した設定一覧:\n', removedLines);
                        for (const chunk of chunks) {
                            await interaction.followUp({ content: chunk, ephemeral: true });
                        }
                    }
                    return;
                }

                if (action === 'cleanup_one') {
                    const index = Number(parts[3]);
                    const page = Number(parts[4] || 0);
                    const entry = staleEntries[index];

                    if (!entry) {
                        await interaction.reply({
                            content: 'その削除候補は見つかりませんでした。もう一度 show を実行してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    let removedLine = null;
                    if (kind === 'forum') {
                        removedLine = await applySingleForumCleanup(interaction.guildId, entry);
                    } else if (kind === 'rolemention') {
                        removedLine = await applySingleRoleMentionCleanup(interaction.guildId, entry);
                    }

                    const nextStaleEntries = staleEntries.filter((_, i) => i !== index);
                    const nextStaleLines = staleLines.filter((_, i) => i !== index);

                    if (nextStaleEntries.length === 0) {
                        await kv.del(pendingCleanupKey(token));
                        await interaction.update({
                            content: '個別削除を完了しました。削除候補はすべて解消されました。',
                            components: [],
                        });
                        if (removedLine) {
                            await interaction.followUp({ content: removedLine, ephemeral: true });
                        }
                        return;
                    }

                    const nextPending = {
                        ...pending,
                        staleEntries: nextStaleEntries,
                        staleLines: nextStaleLines,
                    };
                    await kv.setEx(pendingCleanupKey(token), 900, JSON.stringify(nextPending));

                    const maxPage = Math.max(0, Math.ceil(nextStaleEntries.length / 10) - 1);
                    const nextPage = Math.min(page, maxPage);

                    await interaction.update({
                        content: buildStaleSelectionContent(kind, nextStaleLines, nextPage),
                        components: buildCleanupEntryButtons(kind, token, nextStaleEntries, nextPage),
                    });

                    if (removedLine) {
                        await interaction.followUp({ content: removedLine, ephemeral: true });
                    }
                    return;
                }
            } catch (error) {
                console.error('cleanup button でエラー:', error);
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: '確認処理中にエラーが発生しました。', ephemeral: true }).catch(() => null);
                } else {
                    await interaction.reply({ content: '確認処理中にエラーが発生しました。', ephemeral: true }).catch(() => null);
                }
                return;
            }
        }

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
            // /help 系
            // =========================================================
            if (interaction.commandName === 'help') {
                const helpLines = buildHelpLines();
                const chunks = splitLinesToMessages('', helpLines);

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

                    const previewMessage = messageTemplate ? messageTemplate.replaceAll('\\n', '\n') : null;
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
                            '改行したい場合は `\\n` を使ってください。\n' +
                            '\n' +
                            '## 例\n' +
                            '```txt\n' +
                            '{forum} に新しいスレッドが作成されました！\\n' +
                            'スレ主: {author}\\n' +
                            'リンク: [{thread}]({link})\n' +
                            '```',
                        ephemeral: true,
                    });
                    return;
                }

                if (sub === 'show') {
                    const { validLines, staleEntries } = await collectForumShowData(client, interaction.guildId);

                    if (validLines.length === 0 && staleEntries.length === 0) {
                        await interaction.reply({ content: 'このサーバーにはまだフォーラム通知設定がありません。' });
                        return;
                    }

                    if (staleEntries.length === 0) {
                        const chunks = splitLinesToMessages('現在のフォーラム通知設定一覧:\n', validLines);
                        await interaction.reply({ content: chunks[0] });
                        for (let i = 1; i < chunks.length; i++) {
                            await interaction.followUp({ content: chunks[i] });
                        }
                        return;
                    }

                    const staleLines = staleEntries.map((entry) =>
                        entry.type === 'forum_missing'
                            ? `消失したフォーラム: <#${entry.forumId}>`
                            : `フォーラム <#${entry.forumId}> → 消失した通知先 <#${entry.targetId}>`
                    );

                    const token = crypto.randomUUID();
                    await kv.setEx(
                        pendingCleanupKey(token),
                        900,
                        JSON.stringify({
                            kind: 'forum',
                            guildId: interaction.guildId,
                            validLines,
                            staleEntries,
                            staleLines,
                        }),
                    );

                    await interaction.reply({
                        content: buildStaleSummaryContent('forum', validLines, staleLines),
                        components: buildCleanupChoiceButtons('forum', token),
                        ephemeral: true,
                    });

                    if (validLines.length > 0) {
                        const validChunks = splitLinesToMessages('有効な設定一覧:\n', validLines);
                        for (const chunk of validChunks) {
                            await interaction.followUp({ content: chunk, ephemeral: true });
                        }
                    }

                    const staleChunks = splitLinesToMessages(
                        '削除候補一覧:\n',
                        staleLines.map((line, index) => `${index + 1}. ${line}`),
                    );
                    for (const chunk of staleChunks) {
                        await interaction.followUp({ content: chunk, ephemeral: true });
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
                    const messageTemplate = interaction.options.getString('message', false);

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

                    if (messageTemplate) {
                        await kv.hSet(roleMentionMessageMapKey(interaction.guildId), role.id, messageTemplate);
                    }

                    const previewMessage = messageTemplate ? messageTemplate.replaceAll('\\n', '\n') : null;

                    let content =
                        `ロールメンション転載設定を登録しました。\n` +
                        `ロール: <@&${role.id}>\n` +
                        `転載先: <#${targetChannel.id}>\n` +
                        `カスタムメッセージ: ${messageTemplate ? 'あり' : 'なし'}`;

                    if (previewMessage) {
                        content += `\n設定メッセージ:\n\`\`\`txt\n${previewMessage}\n\`\`\``;
                    }

                    await interaction.reply({
                        content,
                        ephemeral: true,
                    });
                    return;
                }

                if (sub === 'placeholders') {
                    await interaction.reply({
                        content:
                            '## ロールメンション転載で使えるプレースホルダ一覧\n' +
                            '・`{author}` → 送信者メンション\n' +
                            '・`{roles}` → メンションされたロール一覧\n' +
                            '・`{channel}` → 元チャンネルメンション\n' +
                            '・`{link}` → 元メッセージリンク\n' +
                            '・`{body}` → 本文そのまま\n' +
                            '・`{body_quote}` → 引用形式の本文\n' +
                            '\n' +
                            '## 改行の書き方\n' +
                            '改行したい場合は `\\n` を使ってください。\n' +
                            '\n' +
                            '## 例\n' +
                            '```txt\n' +
                            '送信主：{author}\\n' +
                            '{body_quote}\\n' +
                            '# {channel}\\n' +
                            '{link}\n' +
                            '```',
                        ephemeral: true,
                    });
                    return;
                }

                if (sub === 'show') {
                    const { validLines, staleEntries } = await collectRoleMentionShowData(client, interaction.guildId);

                    if (validLines.length === 0 && staleEntries.length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだロールメンション転載設定がありません。',
                            ephemeral: true,
                        });
                        return;
                    }

                    if (staleEntries.length === 0) {
                        const chunks = splitLinesToMessages('現在のロールメンション転載設定一覧:\n', validLines);
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

                    const staleLines = staleEntries.map(
                        (entry) => `ロール <@&${entry.roleId}> → 消失した転載先 <#${entry.targetId}>`,
                    );

                    const token = crypto.randomUUID();
                    await kv.setEx(
                        pendingCleanupKey(token),
                        900,
                        JSON.stringify({
                            kind: 'rolemention',
                            guildId: interaction.guildId,
                            validLines,
                            staleEntries,
                            staleLines,
                        }),
                    );

                    await interaction.reply({
                        content: buildStaleSummaryContent('rolemention', validLines, staleLines),
                        components: buildCleanupChoiceButtons('rolemention', token),
                        ephemeral: true,
                    });

                    if (validLines.length > 0) {
                        const validChunks = splitLinesToMessages('有効な設定一覧:\n', validLines);
                        for (const chunk of validChunks) {
                            await interaction.followUp({ content: chunk, ephemeral: true });
                        }
                    }

                    const staleChunks = splitLinesToMessages(
                        '削除候補一覧:\n',
                        staleLines.map((line, index) => `${index + 1}. ${line}`),
                    );
                    for (const chunk of staleChunks) {
                        await interaction.followUp({ content: chunk, ephemeral: true });
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

                    await kv.hDel(roleMentionMessageMapKey(interaction.guildId), role.id);

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

            // =========================================================
            // /forward 系
            // =========================================================
            if (interaction.commandName === 'forward') {
                const group = interaction.options.getSubcommandGroup(false);
                const sub = interaction.options.getSubcommand();

                // =========================================================
                // /forward allow add/remove
                // Bot / Webhook の許可対象を統合管理
                // =========================================================
                if (group === 'allow') {
                    if (sub === 'add') {
                        const sourceChannel = interaction.options.getChannel('source_channel', false);
                        const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;
                        const type = interaction.options.getString('type', true);
                        const id = interaction.options.getString('id', true).trim();

                        if (!/^\d{17,20}$/.test(id)) {
                            await interaction.reply({
                                content: 'IDの形式が正しくありません。17〜20桁程度のDiscord IDを指定してください。',
                                ephemeral: true,
                            });
                            return;
                        }

                        if (type === 'bot') {
                            await kv.sAdd(
                                forwardAllowedBotsKey(interaction.guildId, sourceChannel.id),
                                id,
                            );

                            await interaction.reply({
                                content:
                                    `転送許可Botを追加しました。\n` +
                                    `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n`
                                    `Bot ID: ${id}`,
                                ephemeral: true,
                            });
                            return;
                        }

                        if (type === 'webhook') {
                            await kv.sAdd(
                                forwardAllowedWebhooksKey(interaction.guildId, sourceChannel.id),
                                id,
                            );

                            await interaction.reply({
                                content:
                                    `転送許可Webhookを追加しました。\n` +
                                    `転送元: <#${sourceChannel.id}>\n` +
                                    `Webhook ID: ${id}`,
                                ephemeral: true,
                            });
                            return;
                        }

                        await interaction.reply({
                            content: 'type は `bot` または `webhook` を指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }

                    if (sub === 'remove') {
                        const sourceChannel = interaction.options.getChannel('source_channel', true);
                        const type = interaction.options.getString('type', true);
                        const id = interaction.options.getString('id', true).trim();

                        if (!/^\d{17,20}$/.test(id)) {
                            await interaction.reply({
                                content: 'IDの形式が正しくありません。17〜20桁程度のDiscord IDを指定してください。',
                                ephemeral: true,
                            });
                            return;
                        }

                        if (type === 'bot') {
                            const removed = await kv.sRem(
                                forwardAllowedBotsKey(interaction.guildId, sourceChannel.id),
                                id,
                            );

                            await interaction.reply({
                                content: removed
                                    ? `転送許可Botを削除しました。\n転送元: <#${sourceChannel.id}>\nBot ID: ${id}`
                                    : `転送元 <#${sourceChannel.id}> の許可Bot一覧に ${id} はありませんでした。`,
                                ephemeral: true,
                            });
                            return;
                        }

                        if (type === 'webhook') {
                            const removed = await kv.sRem(
                                forwardAllowedWebhooksKey(interaction.guildId, sourceChannel.id),
                                id,
                            );

                            await interaction.reply({
                                content: removed
                                    ? `転送許可Webhookを削除しました。\n転送元: <#${sourceChannel.id}>\nWebhook ID: ${id}`
                                    : `転送元 <#${sourceChannel.id}> の許可Webhook一覧に ${id} はありませんでした。`,
                                ephemeral: true,
                            });
                            return;
                        }

                        await interaction.reply({
                            content: 'type は `bot` または `webhook` を指定してください。',
                            ephemeral: true,
                        });
                        return;
                    }
                }

                // =========================================================
                // /forward set
                // 転送元チャンネル → 転送先Webhook URL を登録
                // =========================================================
                if (sub === 'set') {
                    const sourceChannel = interaction.options.getChannel('source_channel', false);
                    const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;
                    const targetWebhookUrl = interaction.options.getString('target_webhook_url', true).trim();

                    if (sub === 'set') {
                        const sourceChannel = interaction.options.getChannel('source_channel', false);
                        const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;

                        const targetWebhookUrl = interaction.options
                            .getString('target_webhook_url', true)
                            .trim();

                        if (!targetWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
                            await interaction.reply({
                                content: 'Webhook URL の形式が正しくありません。',
                                ephemeral: true,
                            });
                            return;
                        }

                        await kv.sAdd(
                            forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
                            targetWebhookUrl,
                        );

                        await kv.sAdd(
                            forwardWebhookIndexKey(interaction.guildId),
                            sourceChannelId,
                        );

                        await interaction.reply({
                            content:
                                `転送設定を登録しました。\n` +
                                `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n` +
                                `転送先: Webhook URL`,
                            ephemeral: true,
                        });
                        return;
                    }
                }

                // =========================================================
                // /forward show
                // 転送設定 + 許可Bot + 許可Webhook を全部まとめて表示
                // =========================================================
                if (sub === 'show') {
                    const sourceChannelIds = await kv.sMembers(
                        forwardWebhookIndexKey(interaction.guildId),
                    );

                    if (!sourceChannelIds || sourceChannelIds.length === 0) {
                        await interaction.reply({
                            content: 'このサーバーにはまだ転送設定がありません。',
                            ephemeral: true,
                        });
                        return;
                    }

                    const lines = [];

                    for (const sourceChannelId of sourceChannelIds) {
                        const webhookUrls = await kv.sMembers(
                            forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
                        );

                        const allowedBotIds = await kv.sMembers(
                            forwardAllowedBotsKey(interaction.guildId, sourceChannelId),
                        );

                        const allowedWebhookIds = await kv.sMembers(
                            forwardAllowedWebhooksKey(interaction.guildId, sourceChannelId),
                        );

                        const sourceLabel =
                            sourceChannelId === FORWARD_ALL_CHANNELS
                                ? 'サーバー全体'
                                : `<#${sourceChannelId}>`;

                        lines.push(`転送元: ${sourceLabel}`);

                        lines.push('　転送先Webhook:');
                        if (webhookUrls && webhookUrls.length > 0) {
                            for (let i = 0; i < webhookUrls.length; i++) {
                                lines.push(`　　${i + 1}. 登録済み`);
                            }
                        } else {
                            lines.push('　　・なし');
                        }

                        lines.push('　許可Bot:');
                        if (allowedBotIds && allowedBotIds.length > 0) {
                            for (const botId of allowedBotIds) {
                                lines.push(`　　・<@${botId}> (${botId})`);
                            }
                        } else {
                            lines.push('　　・なし');
                        }

                        lines.push('　許可Webhook:');
                        if (allowedWebhookIds && allowedWebhookIds.length > 0) {
                            for (const webhookId of allowedWebhookIds) {
                                lines.push(`　　・${webhookId}`);
                            }
                        } else {
                            lines.push('　　・なし');
                        }

                        lines.push('');
                    }

                    const chunks = splitLinesToMessages('現在の転送設定一覧:\n', lines);

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

                // =========================================================
                // /forward unset
                // 転送先Webhook URL を削除
                // =========================================================
                if (sub === 'unset') {
                    const sourceChannel = interaction.options.getChannel('source_channel', false);
                    const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;

                    const targetWebhookUrl = interaction.options
                        .getString('target_webhook_url', true)
                        .trim();

                    const removed = await kv.sRem(
                        forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
                        targetWebhookUrl,
                    );

                    if (!removed) {
                        await interaction.reply({
                            content:
                                `${sourceChannel ? `転送元 <#${sourceChannel.id}>` : 'サーバー全体転送'} の指定Webhook設定は見つかりませんでした。`,
                            ephemeral: true,
                        });
                        return;
                    }

                    const remainingTargets = await kv.sMembers(
                        forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
                    );

                    if (!remainingTargets || remainingTargets.length === 0) {
                        await kv.del(
                            forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
                        );

                        await kv.sRem(
                            forwardWebhookIndexKey(interaction.guildId),
                            sourceChannelId,
                        );
                    }

                    await interaction.reply({
                        content:
                            `転送設定を削除しました。\n` +
                            `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}`,
                        ephemeral: true,
                    });
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

            if (message.author.id === client.user.id) return;

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

                const messageContent = renderForumMessage(template, {
                    forumMention,
                    forumName,
                    threadName,
                    authorMention: ownerMention,
                    threadLink,
                });

                const result = await sendToTarget(client, targetId, messageContent);
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

            const rawMessageBody = message.content?.trim() || '（本文なし）';
            const messageBody =
                rawMessageBody.length > 1500
                    ? rawMessageBody.slice(0, 1500) + '\n...(省略)'
                    : rawMessageBody;

            const bodyQuote = messageBody
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n');

            for (const [targetId, roleIds] of targets.entries()) {
                const roleMentions = roleIds.map((id) => `<@&${id}>`).join(' ');
                const roleIdForTemplate = roleIds[0];

                const customTemplate = await kv.hGet(
                    roleMentionMessageMapKey(message.guildId),
                    roleIdForTemplate,
                );
                const template = customTemplate || DEFAULT_ROLE_MENTION_MESSAGE_TEMPLATE;

                const messageContent = renderRoleMentionMessage(template, {
                    authorMention: `<@${message.author.id}>`,
                    roleMentions,
                    channelMention: `<#${message.channelId}>`,
                    messageLink: message.url,
                    body: messageBody,
                    bodyQuote,
                });

                const result = await sendToTarget(client, targetId, messageContent);
                if (!result.ok) {
                    console.warn(`ロールメンション転載失敗: ${result.reason}, targetId=${targetId}`);
                }
            }
        } catch (error) {
            console.error('messageCreate でロールメンション転載失敗:', error);
        }
    });

    // =========================================================
    // 特定チャンネルの書き込みをWebhookで別サーバーへ転送
    // =========================================================
    client.on(Events.MessageCreate, async (message) => {
        try {
            if (!message.guild) return;

            // 自分自身のBot投稿だけ無視
            if (message.author.id === client.user.id) return;

            // 許可Bot / 許可Webhookリストを読む
            const channelAllowedBotIds = await kv.sMembers(
                forwardAllowedBotsKey(message.guildId, message.channelId),
            );

            const serverAllowedBotIds = await kv.sMembers(
                forwardAllowedBotsKey(message.guildId, FORWARD_ALL_CHANNELS),
            );

            const allowedBotIds = [
                ...(channelAllowedBotIds || []),
                ...(serverAllowedBotIds || []),
            ];

            const channelAllowedWebhookIds = await kv.sMembers(
                forwardAllowedWebhooksKey(message.guildId, message.channelId),
            );

            const serverAllowedWebhookIds = await kv.sMembers(
                forwardAllowedWebhooksKey(message.guildId, FORWARD_ALL_CHANNELS),
            );

            const allowedWebhookIds = [
                ...(channelAllowedWebhookIds || []),
                ...(serverAllowedWebhookIds || []),
            ];

            // Webhook投稿なら、許可Webhookだけ通す
            if (message.webhookId) {
                if (!allowedWebhookIds.includes(message.webhookId)) return;
            }
            // 通常Bot投稿なら、許可Botだけ通す
            else if (message.author.bot) {
                if (!allowedBotIds.includes(message.author.id)) return;
            }
            // 人間投稿はそのまま通す

            const channelWebhookUrls = await kv.sMembers(
                forwardWebhookTargetsKey(message.guildId, message.channelId),
            );

            const serverWebhookUrls = await kv.sMembers(
                forwardWebhookTargetsKey(message.guildId, FORWARD_ALL_CHANNELS),
            );

            const webhookUrls = [
                ...(channelWebhookUrls || []),
                ...(serverWebhookUrls || []),
            ];

            const uniqueWebhookUrls = [...new Set(webhookUrls)];

            if (uniqueWebhookUrls.length === 0) return;

            let body = message.content?.trim() || '';
            body = toPlainCustomEmojiText(body);

            const files =
                message.attachments.size > 0
                    ? [...message.attachments.values()].map((attachment) => ({
                        attachment: attachment.url,
                        name: attachment.name || 'attachment',
                    }))
                    : [];

            const content = body || undefined;

            const displayName =
                message.member?.displayName ||
                message.author.globalName ||
                message.author.username;

            const webhookUsername = `${displayName} | #${message.channel.name}`;

            const avatarURL =
                message.member?.displayAvatarURL({
                    extension: 'png',
                    size: 128,
                }) ||
                message.author.displayAvatarURL({
                    extension: 'png',
                    size: 128,
                });

            for (const webhookUrl of uniqueWebhookUrls) {
                const webhookClient = new WebhookClient({
                    url: webhookUrl,
                });

                await webhookClient.send({
                    content,
                    username: webhookUsername,
                    avatarURL,
                    files,
                    allowedMentions: {
                        parse: [],
                    },
                });
            }
        } catch (error) {
            console.error('Webhook転送でエラー:', error);
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