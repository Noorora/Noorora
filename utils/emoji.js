async function normalizeCustomEmojiText(message, text) {
    if (!text || !message.guild) return text;

    let guildEmojis;
    try {
        guildEmojis = await message.guild.emojis.fetch();
    } catch (error) {
        console.warn('絵文字一覧の取得に失敗:', error);
        return text;
    }

    return text.replace(
        /<a?:([a-zA-Z0-9_]+):(\d{17,20})>|:([a-zA-Z0-9_]+):/g,
        (match, existingEmojiName, existingEmojiId, shortEmojiName) => {
            if (existingEmojiName && existingEmojiId) {
                return match;
            }

            const emojiName = shortEmojiName;
            const emoji = guildEmojis.find((item) => item.name === emojiName);

            if (!emoji) {
                return match;
            }

            return emoji.animated
                ? `<a:${emoji.name}:${emoji.id}>`
                : `<:${emoji.name}:${emoji.id}>`;
        },
    );
}

module.exports = {
    normalizeCustomEmojiText,
};
