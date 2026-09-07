const {
    handleMessageReaction,
} = require('../events/messageReaction');

const {
    handleForwardRelay,
} = require('../events/forwardRelay');

async function handleMessageCreate(
    message,
    context,
) {
    await handleMessageReaction(
        message,
        context,
    );

    await handleForwardRelay(
        message,
        context,
    );
}

module.exports = {
    handleMessageCreate,
};