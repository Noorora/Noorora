const { roleMentionTargetsKey, roleMentionMessageMapKey } = require('../keys/redisKeys');
const { sendToTarget } = require('../utils/channel');
const {
    DEFAULT_ROLE_MENTION_MESSAGE_TEMPLATE,
    renderRoleMentionMessage,
} = require('../templates/roleMentionTemplate');

async function handleRoleMentionRelay(message, context) {
    const { client, kv } = context;

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
            if (!targets.has(targetId)) targets.set(targetId, []);
            targets.get(targetId).push(role.id);
        }
        if (targets.size === 0) return;

        const rawMessageBody = message.content?.trim() || '（本文なし）';
        const messageBody = rawMessageBody.length > 1500
            ? rawMessageBody.slice(0, 1500) + '\n...(省略)'
            : rawMessageBody;
        const bodyQuote = messageBody.split('\n').map((line) => `> ${line}`).join('\n');

        for (const [targetId, roleIds] of targets.entries()) {
            const roleMentions = roleIds.map((id) => `<@&${id}>`).join(' ');
            const roleIdForTemplate = roleIds[0];
            const customTemplate = await kv.hGet(roleMentionMessageMapKey(message.guildId), roleIdForTemplate);
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
}

module.exports = {
    handleRoleMentionRelay,
};
