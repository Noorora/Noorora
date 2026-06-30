const { ChannelType } = require('discord.js');
const { forumTargetsKey, forumMessageMapKey } = require('../keys/redisKeys');
const { sendToTarget } = require('../utils/channel');
const { buildNewcomerMark } = require('../utils/member');
const {
    DEFAULT_FORUM_MESSAGE_TEMPLATE,
    renderForumMessage,
} = require('../templates/forumTemplate');

async function handleForumThreadCreate(thread, context) {
    const { client, kv } = context;

    try {
        if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

        const targetIds = await kv.sMembers(forumTargetsKey(thread.guildId, thread.parentId));
        if (!targetIds || targetIds.length === 0) return;

        const ownerMention = thread.ownerId ? `<@${thread.ownerId}>` : '不明';
        const threadLink = thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;
        const forumMention = `<#${thread.parentId}>`;
        const forumName = thread.parent.name ?? 'フォーラム';
        const threadName = thread.name ?? '無題';
        const ownerMember = thread.ownerId
            ? await thread.guild.members.fetch(thread.ownerId).catch(() => null)
            : null;
        const newcomerMark = buildNewcomerMark(ownerMember);

        for (const targetId of targetIds) {
            const customTemplate = await kv.hGet(forumMessageMapKey(thread.guildId, thread.parentId), targetId);
            const template = customTemplate || DEFAULT_FORUM_MESSAGE_TEMPLATE;
            const messageContent = renderForumMessage(template, {
                forumMention,
                forumName,
                threadName,
                authorMention: ownerMention,
                newcomerMark,
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
}

module.exports = {
    handleForumThreadCreate,
};
