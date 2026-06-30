const { ephemeralOptions } = require('../utils/ephemeral');
const { buildJoinedDaysInfo } = require('../utils/member');

async function execute(interaction) {
    const member = await interaction.guild.members
        .fetch(interaction.user.id)
        .catch(() => interaction.member ?? null);

    const joinedInfo = buildJoinedDaysInfo(member);
    if (!joinedInfo) {
        await interaction.reply(ephemeralOptions({ content: 'サーバー参加日の取得に失敗しました。' }));
        return;
    }

    await interaction.reply(ephemeralOptions({
        content:
            `あなたはこのサーバーに参加してから **${joinedInfo.daysSinceJoin}日** 経っています。\n` +
            `参加日: ${joinedInfo.joinedAtText}`,
    }));
}

module.exports = {
    name: 'joined',
    execute,
};
