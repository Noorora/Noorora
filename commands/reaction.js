const { ChannelType } = require('discord.js');
const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const {
    reactionRulesKey,
    reactionAllowedBotsKey,
    reactionRuleField,
} = require('../keys/redisKeys');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function parseReactionRules(hash) {
    return Object.entries(hash).map(([field, emoji]) => {
        const sep = field.indexOf(':');
        return {
            field,
            channelId: field.slice(0, sep),
            userId: field.slice(sep + 1),
            emoji,
        };
    });
}

async function execute(interaction, context) {
    const { kv } = context;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
        const targetChannel = interaction.options.getChannel('target_channel', true);
        const user = interaction.options.getUser('user', true);
        const emoji = interaction.options.getString('emoji', true).trim();

        if (!allowedTargetTypes.includes(targetChannel.type)) {
            await interaction.reply(ephemeralOptions({ content: 'target_channel にはテキストチャンネルまたはスレッドを指定してください。' }));
            return;
        }

        await kv.hSet(reactionRulesKey(interaction.guildId), reactionRuleField(targetChannel.id, user.id), emoji);
        await interaction.reply(ephemeralOptions({
            content:
                `自動リアクション設定を登録しました。\n` +
                `対象チャンネル: <#${targetChannel.id}>\n` +
                `ユーザー: <@${user.id}>\n` +
                `絵文字: ${emoji}`,
        }));
        return;
    }

    if (sub === 'show') {
        const rules = parseReactionRules(await kv.hGetAll(reactionRulesKey(interaction.guildId)));
        if (rules.length === 0) {
            await interaction.reply(ephemeralOptions({ content: 'このサーバーにはまだ自動リアクション設定がありません。' }));
            return;
        }

        const lines = rules.map((rule, index) => `${index + 1}. 対象チャンネル: <#${rule.channelId}> / ユーザー: <@${rule.userId}> / 絵文字: ${rule.emoji}`);
        const chunks = splitLinesToMessages('現在の自動リアクション設定一覧:\n', lines);
        await interaction.reply(ephemeralOptions({ content: chunks[0] }));
        for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
        return;
    }

    if (sub === 'unset') {
        const targetChannel = interaction.options.getChannel('target_channel', true);
        const user = interaction.options.getUser('user', true);
        const removed = await kv.hDel(reactionRulesKey(interaction.guildId), reactionRuleField(targetChannel.id, user.id));

        await interaction.reply(ephemeralOptions({
            content: removed
                ? `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定を削除しました。`
                : `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定は見つかりませんでした。`,
        }));
        return;
    }

    if (group === 'allowbot' && sub === 'add') {
        const user = interaction.options.getUser('user', true);
        if (!user.bot) {
            await interaction.reply(ephemeralOptions({ content: 'bot アカウントを指定してください。' }));
            return;
        }
        await kv.sAdd(reactionAllowedBotsKey(interaction.guildId), user.id);
        await interaction.reply(ephemeralOptions({ content: `自動リアクション対象として Bot <@${user.id}> を許可しました。` }));
        return;
    }

    if (group === 'allowbot' && sub === 'show') {
        const botIds = await kv.sMembers(reactionAllowedBotsKey(interaction.guildId));
        if (!botIds || botIds.length === 0) {
            await interaction.reply(ephemeralOptions({ content: 'このサーバーには、許可された Bot 一覧がまだありません。' }));
            return;
        }
        const lines = botIds.map((id, index) => `${index + 1}. <@${id}> (${id})`);
        const chunks = splitLinesToMessages('自動リアクション対象として許可されている Bot 一覧:\n', lines);
        await interaction.reply(ephemeralOptions({ content: chunks[0] }));
        for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
        return;
    }

    if (group === 'allowbot' && sub === 'remove') {
        const user = interaction.options.getUser('user', true);
        const removed = await kv.sRem(reactionAllowedBotsKey(interaction.guildId), user.id);
        await interaction.reply(ephemeralOptions({
            content: removed
                ? `自動リアクション対象から Bot <@${user.id}> を削除しました。`
                : `Bot <@${user.id}> は許可一覧にありませんでした。`,
        }));
    }
}

module.exports = {
    name: 'reaction',
    execute,
};
