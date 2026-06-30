const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { buildHelpLines } = require('../templates/helpTemplate');

async function execute(interaction) {
    const chunks = splitLinesToMessages('', buildHelpLines());
    await interaction.reply(ephemeralOptions({ content: chunks[0] }));

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
    }
}

module.exports = {
    name: 'help',
    execute,
};
