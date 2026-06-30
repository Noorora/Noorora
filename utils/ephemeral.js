const { MessageFlags } = require('discord.js');

const EPHEMERAL = MessageFlags.Ephemeral;

function ephemeralOptions(options = {}) {
    return {
        ...options,
        flags: EPHEMERAL,
    };
}

module.exports = {
    EPHEMERAL,
    ephemeralOptions,
};
