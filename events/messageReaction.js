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
        if (
            client.user &&
            message.author.id === client.user.id
        ) {
            return;
        }

        /*
         * Botによる投稿の場合は、
         * 許可Bot一覧に登録されているBotだけを対象にする。
         *
         * 人間による投稿の場合は、
         * 投稿者に関係なくそのまま処理を続ける。
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
         * 投稿者IDではなく "*" の設定を取得する。
         *
         * Redis上の形式:
         * チャンネルID:*
         *
         * これにより、設定されたチャンネル内では
         * 誰が投稿しても同じリアクションを付ける。
         */
        const emoji = await kv.hGet(
            reactionRulesKey(message.guildId),
            reactionRuleField(
                message.channelId,
                ALL_USERS_ID,
            ),
        );

        // このチャンネルに設定がなければ何もしない
        if (!emoji) {
            return;
        }

        // 設定されたリアクションを付ける
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