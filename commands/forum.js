const crypto = require('crypto');
const { ChannelType } = require('discord.js');
const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { buildCleanupChoiceButtons, buildStaleSummaryContent } = require('../components/cleanupButtons');
const { pendingCleanupKey, forumTargetsKey, forumIndexKey, forumMessageMapKey } = require('../keys/redisKeys');
const { buildForumPlaceholdersHelp } = require('../templates/forumTemplate');
const {
    resolveForumIds,
    collectForumShowData,
} = require('../services/forumService');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

async function execute(interaction, context) {
    const { client, kv } = context;
    const sub = interaction.options.getSubcommand();

    if (sub === 'channel') {
        const forum = interaction.options.getChannel('forum', false);
        const forumIdsRaw = interaction.options.getString('forum_ids', false);
        const targetChannel = interaction.options.getChannel('target_channel', true);
        const messageTemplate = interaction.options.getString('message', false);

        if ((forum && forumIdsRaw) || (!forum && !forumIdsRaw)) {
            await interaction.reply('forum か forum_ids のどちらか片方だけを指定してください。');
            return;
        }

        if (!allowedTargetTypes.includes(targetChannel.type)) {
            await interaction.reply('target_channel にはテキストチャンネルまたは既存スレッドを指定してください。');
            return;
        }

        const resolved = await resolveForumIds(client, interaction.guildId, forum, forumIdsRaw);
        if (resolved.valid.length === 0) {
            const failLines = resolved.invalid.map((item) => `・${item.input} → ${item.reason}`);
            const chunks = splitLinesToMessages('フォーラム通知先を追加できませんでした。\n', failLines.length > 0 ? failLines : ['・有効なフォーラムがありませんでした']);
            await interaction.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
            return;
        }

        const successLines = [];
        const failLines = [];
        for (const forumId of resolved.valid) {
            await kv.sAdd(forumTargetsKey(interaction.guildId, forumId), targetChannel.id);
            await kv.sAdd(forumIndexKey(interaction.guildId), forumId);
            if (messageTemplate) {
                await kv.hSet(forumMessageMapKey(interaction.guildId, forumId), targetChannel.id, messageTemplate);
            }
            successLines.push(`・<#${forumId}> → <#${targetChannel.id}>`);
        }
        for (const item of resolved.invalid) failLines.push(`・${item.input} → ${item.reason}`);

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
        if (messageTemplate) {
            firstContent += `\n設定メッセージ:\n\`\`\`txt\n${messageTemplate.replaceAll('\\n', '\n')}\n\`\`\``;
        }
        await interaction.reply(firstContent);
        for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
        return;
    }

    if (sub === 'placeholders') {
        await interaction.reply(ephemeralOptions({ content: buildForumPlaceholdersHelp() }));
        return;
    }

    if (sub === 'show') {
        const { validLines, staleEntries } = await collectForumShowData(client, kv, interaction.guildId);
        if (validLines.length === 0 && staleEntries.length === 0) {
            await interaction.reply('このサーバーにはまだフォーラム通知設定がありません。');
            return;
        }

        if (staleEntries.length === 0) {
            const chunks = splitLinesToMessages('現在のフォーラム通知設定一覧:\n', validLines);
            await interaction.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
            return;
        }

        const staleLines = staleEntries.map((entry) => entry.type === 'forum_missing'
            ? `消失したフォーラム: <#${entry.forumId}>`
            : `フォーラム <#${entry.forumId}> → 消失した通知先 <#${entry.targetId}>`);
        const token = crypto.randomUUID();
        await kv.setEx(pendingCleanupKey(token), 900, JSON.stringify({ kind: 'forum', guildId: interaction.guildId, validLines, staleEntries, staleLines }));

        await interaction.reply(ephemeralOptions({
            content: buildStaleSummaryContent('forum', validLines, staleLines),
            components: buildCleanupChoiceButtons('forum', token),
        }));
        if (validLines.length > 0) {
            const validChunks = splitLinesToMessages('有効な設定一覧:\n', validLines);
            for (const chunk of validChunks) await interaction.followUp(ephemeralOptions({ content: chunk }));
        }
        const staleChunks = splitLinesToMessages('削除候補一覧:\n', staleLines.map((line, index) => `${index + 1}. ${line}`));
        for (const chunk of staleChunks) await interaction.followUp(ephemeralOptions({ content: chunk }));
        return;
    }

    if (sub === 'unset') {
        const forum = interaction.options.getChannel('forum', false);
        const targetChannel = interaction.options.getChannel('target_channel', false);
        const guildId = interaction.guildId;

        if (!forum && !targetChannel) {
            await interaction.reply('forum か target_channel のどちらかは指定してください。');
            return;
        }
        if (forum && forum.type !== ChannelType.GuildForum) {
            await interaction.reply('forum にはフォーラムチャンネルを指定してください。');
            return;
        }
        if (targetChannel && !allowedTargetTypes.includes(targetChannel.type)) {
            await interaction.reply('target_channel にはテキストチャンネルまたはスレッドを指定してください。');
            return;
        }

        const forumIds = await kv.sMembers(forumIndexKey(guildId));
        if (!forumIds || forumIds.length === 0) {
            await interaction.reply('このサーバーにはまだフォーラム通知設定がありません。');
            return;
        }

        if (forum && targetChannel) {
            await removeForumTarget(interaction, kv, guildId, forum.id, targetChannel.id);
            return;
        }

        if (forum && !targetChannel) {
            const targetKey = forumTargetsKey(guildId, forum.id);
            const messageKey = forumMessageMapKey(guildId, forum.id);
            const targetIds = await kv.sMembers(targetKey);
            if (!targetIds || targetIds.length === 0) {
                await interaction.reply(`そのフォーラムの設定は見つかりませんでした: <#${forum.id}>`);
                return;
            }
            await kv.del(targetKey);
            await kv.del(messageKey);
            await kv.sRem(forumIndexKey(guildId), forum.id);
            await interaction.reply(`フォーラム <#${forum.id}> に紐づく通知先をすべて削除しました。`);
            return;
        }

        if (!forum && targetChannel) {
            let removedCount = 0;
            const removedLines = [];
            for (const forumId of forumIds) {
                const removed = await removeForumTargetCore(kv, guildId, forumId, targetChannel.id);
                if (removed) {
                    removedCount += 1;
                    removedLines.push(`・フォーラム <#${forumId}> から通知先 <#${targetChannel.id}> を削除`);
                }
            }
            if (removedCount === 0) {
                await interaction.reply(`通知先 <#${targetChannel.id}> に紐づく設定は見つかりませんでした。`);
                return;
            }
            const chunks = splitLinesToMessages(`通知先 <#${targetChannel.id}> に紐づく設定を ${removedCount} 件削除しました。\n`, removedLines);
            await interaction.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
        }
    }
}

async function removeForumTarget(interaction, kv, guildId, forumId, targetChannelId) {
    const removed = await removeForumTargetCore(kv, guildId, forumId, targetChannelId);
    if (!removed) {
        await interaction.reply(`フォーラム <#${forumId}> に、通知先 <#${targetChannelId}> の設定は見つかりませんでした。`);
        return;
    }
    await interaction.reply(`フォーラム <#${forumId}> から通知先 <#${targetChannelId}> を削除しました。`);
}

async function removeForumTargetCore(kv, guildId, forumId, targetChannelId) {
    const targetKey = forumTargetsKey(guildId, forumId);
    const messageKey = forumMessageMapKey(guildId, forumId);
    const removed = await kv.sRem(targetKey, targetChannelId);
    if (!removed) return false;

    await kv.hDel(messageKey, targetChannelId);
    const remainingTargets = await kv.sMembers(targetKey);
    if (!remainingTargets || remainingTargets.length === 0) {
        await kv.del(targetKey);
        await kv.del(messageKey);
        await kv.sRem(forumIndexKey(guildId), forumId);
    }
    return true;
}

module.exports = {
    name: 'forum',
    execute,
};
