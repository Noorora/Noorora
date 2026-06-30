const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'list') return;

    const targetRole = interaction.options.getRole('role', true);
    await interaction.guild.members.fetch();

    const membersWithRole = interaction.guild.members.cache.filter(
        (member) => !member.user.bot && member.roles.cache.has(targetRole.id),
    );

    if (membersWithRole.size === 0) {
        await interaction.reply(ephemeralOptions({
            content: `ロール <@&${targetRole.id}> を持っているメンバーはいません。`,
        }));
        return;
    }

    const lines = membersWithRole.map((member) => `・${member.user.tag} (<@${member.id}>)`);
    const chunks = splitLinesToMessages(`ロール <@&${targetRole.id}> を持っているメンバー一覧:\n`, lines);

    await interaction.reply(ephemeralOptions({ content: chunks[0] }));
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
    }
}

module.exports = {
    name: 'hasrole',
    execute,
};
