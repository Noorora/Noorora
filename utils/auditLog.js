const { botOptionAuditLogKey } = require('../keys/redisKeys');

async function addAuditLog(interaction, kv, action, detail) {
    const log = {
        at: Date.now(),
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        commandName: interaction.commandName || 'component',
        action,
        detail,
    };

    const key = botOptionAuditLogKey(interaction.guildId);

    await kv.lPush(
        key,
        JSON.stringify(log),
    );

    await kv.lTrim(
        key,
        0,
        99,
    );
}

module.exports = {
    addAuditLog,
};