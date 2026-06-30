const {
    reactionRulesKey,
    reactionAllowedBotsKey,
    reactionRuleField,
} = require('../keys/redisKeys');

async function handleMessageReaction(message, context) {
    const { client, kv } = context;

    try {
        if (!message.guild) return;
        if (message.author.id === client.user.id) return;

        if (message.author.bot) {
            const isAllowedBot = await kv.sIsMember(reactionAllowedBotsKey(message.guildId), message.author.id);
            if (!isAllowedBot) return;
        }

        const emoji = await kv.hGet(reactionRulesKey(message.guildId), reactionRuleField(message.channelId, message.author.id));
        if (!emoji) return;

        await message.react(emoji);
    } catch (error) {
        console.error('messageCreate で自動リアクション付与失敗:', error);
    }
}

module.exports = {
    handleMessageReaction,
};
