function forumTargetsKey(guildId, forumId) {
    return `forum-targets:${guildId}:${forumId}`;
}

function forumIndexKey(guildId) {
    return `forum-index:${guildId}`;
}

function forumMessageMapKey(guildId, forumId) {
    return `forum-message-map:${guildId}:${forumId}`;
}

function reactionRulesKey(guildId) {
    return `reaction-rules:${guildId}`;
}

function reactionAllowedBotsKey(guildId) {
    return `reaction-allowed-bots:${guildId}`;
}

function reactionRuleField(channelId, userId) {
    return `${channelId}:${userId}`;
}

function roleMentionTargetsKey(guildId) {
    return `role-mention-targets:${guildId}`;
}

function roleMentionMessageMapKey(guildId) {
    return `role-mention-message-map:${guildId}`;
}

function pendingCleanupKey(token) {
    return `pending-cleanup:${token}`;
}

function forwardWebhookTargetsKey(guildId, sourceChannelId) {
    return `forward-webhook-targets:${guildId}:${sourceChannelId}`;
}

function forwardWebhookIndexKey(guildId) {
    return `forward-webhook-index:${guildId}`;
}

function forwardAllowedBotsKey(guildId, sourceChannelId) {
    return `forward-allowed-bots:${guildId}:${sourceChannelId}`;
}

function forwardAllowedWebhooksKey(guildId, sourceChannelId) {
    return `forward-allowed-webhooks:${guildId}:${sourceChannelId}`;
}

function forwardExcludeChannelsKey(guildId) {
    return `forward-exclude-channels:${guildId}`;
}

module.exports = {
    forumTargetsKey,
    forumIndexKey,
    forumMessageMapKey,
    reactionRulesKey,
    reactionAllowedBotsKey,
    reactionRuleField,
    roleMentionTargetsKey,
    roleMentionMessageMapKey,
    pendingCleanupKey,
    forwardWebhookTargetsKey,
    forwardWebhookIndexKey,
    forwardAllowedBotsKey,
    forwardAllowedWebhooksKey,
    forwardExcludeChannelsKey,
};
