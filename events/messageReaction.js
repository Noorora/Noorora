const {
    reactionRulesKey,
    reactionAllowedBotsKey,
    reactionRuleField,
} = require('../keys/redisKeys');

const ALL_USERS_ID = '*';

async function handleMessageReaction(message, context) {
    const { client, kv } = context;

    try {
        // DMでは処理しない
        if (!message.guild) {
            return;
        }

        // AutoDetector自身の投稿にはリアクションしない
        if (message.author.id === client.user.id) {
            return;
        }

        /*
         * 人間の投稿は、投稿者に関係なく対象。
         *
         * Botの投稿だけは、従来どおり
         * 「許可Bot一覧」に登録されている場合のみ対象にする。
         */
        if (message.author.bot) {
            const isAllowedBot = await kv.sIsMember(
                reactionAllowedBotsKey(message.guildId),
                message.author.id,
            );

            if (!isAllowedBot) {
                return;
            }
        }

        /*
         * 投稿者IDではなく "*" を使用する。
         *
         * Redis上のフィールド:
         * channelId:*
         *
         * これにより、同じチャンネル内であれば
         * 誰が投稿したかに関係なく同じ設定を取得する。
         */
        const emoji = await kv.hGet(
            reactionRulesKey(message.guildId),
            reactionRuleField(
                message.channelId,
                ALL_USERS_ID,
            ),
        );

        // このチャンネルに自動リアクション設定がない
        if (!emoji) {
            return;
        }

        await message.react(emoji);
    } catch (error) {
        console.error(
            'messageCreate で自動リアクション付与失敗:',
            error,
        );
    }
}

module.exports = {
    handleMessageReaction,
};