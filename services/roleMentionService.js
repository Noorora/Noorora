const { roleMentionTargetsKey, roleMentionMessageMapKey } = require('../keys/redisKeys');

async function collectRoleMentionShowData(client, kv, guildId) {
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

async function applySingleRoleMentionCleanup(kv, guildId, entry) {
    await kv.hDel(roleMentionTargetsKey(guildId), entry.roleId);
    await kv.hDel(roleMentionMessageMapKey(guildId), entry.roleId);
    return `・削除: ロール <@&${entry.roleId}> → 消失した転載先 <#${entry.targetId}>`;
}

async function applyRoleMentionCleanup(kv, guildId, staleEntries) {
    const processed = new Set();
    const removedLines = [];

    for (const entry of staleEntries) {
        const key = `${entry.roleId}:${entry.targetId}`;
        if (processed.has(key)) continue;
        processed.add(key);

        const removedLine = await applySingleRoleMentionCleanup(kv, guildId, entry);
        if (removedLine) removedLines.push(removedLine);
    }

    return removedLines;
}

module.exports = {
    collectRoleMentionShowData,
    applySingleRoleMentionCleanup,
    applyRoleMentionCleanup,
};
