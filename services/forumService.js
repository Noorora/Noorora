const { ChannelType } = require('discord.js');
const {
    forumTargetsKey,
    forumIndexKey,
    forumMessageMapKey,
} = require('../keys/redisKeys');

function normalizeForumIdsInput(raw) {
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
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

async function collectForumShowData(client, kv, guildId) {
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

            const customMessage = await kv.hGet(forumMessageMapKey(guildId, forumId), targetId);
            validLines.push(`　・通知先: <#${targetId}> / カスタム文面: ${customMessage ? 'あり' : 'なし'}`);
        }
    }

    return { validLines, staleEntries };
}

async function applySingleForumCleanup(kv, guildId, entry) {
    if (entry.type === 'forum_missing') {
        await kv.del(forumTargetsKey(guildId, entry.forumId));
        await kv.del(forumMessageMapKey(guildId, entry.forumId));
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

async function applyForumCleanup(kv, guildId, staleEntries) {
    const processed = new Set();
    const removedLines = [];

    for (const entry of staleEntries) {
        const key = `${entry.type}:${entry.forumId}:${entry.targetId || ''}`;
        if (processed.has(key)) continue;
        processed.add(key);

        const removedLine = await applySingleForumCleanup(kv, guildId, entry);
        if (removedLine) removedLines.push(removedLine);
    }

    return removedLines;
}

module.exports = {
    normalizeForumIdsInput,
    resolveForumIds,
    collectForumShowData,
    applySingleForumCleanup,
    applyForumCleanup,
};
