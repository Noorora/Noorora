const { WebhookClient } = require('discord.js');

const {
    forwardWebhookTargetsKey,
    forwardExcludeChannelsKey,
} = require('../keys/redisKeys');

const {
    FORWARD_ALL_CHANNELS,
} = require('../config/constants');

const {
    buildNewcomerMark,
} = require('../utils/member');

function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function getMemberDisplayName(member) {
    return (
        member?.displayName ||
        member?.user?.globalName ||
        member?.user?.username ||
        '不明なユーザー'
    );
}

function getMemberAvatarURL(member) {
    return (
        member?.displayAvatarURL?.({
            extension: 'png',
            size: 128,
        }) ||
        member?.user?.displayAvatarURL?.({
            extension: 'png',
            size: 128,
        }) ||
        null
    );
}

function getVoiceMembers(channel) {
    if (!channel?.members) {
        return [];
    }

    return [...channel.members.values()]
        .filter((member) => member.voice?.channelId === channel.id)
        .sort((a, b) => {
            return getMemberDisplayName(a).localeCompare(
                getMemberDisplayName(b),
                'ja',
            );
        });
}

function formatVoiceMemberList(channel, maxMembers = 30) {
    if (!channel) {
        return '・（取得できませんでした）';
    }

    const members = getVoiceMembers(channel);

    if (members.length === 0) {
        return '・（現在いません）';
    }

    const visibleMembers = members.slice(0, maxMembers);

    const lines = visibleMembers.map((member) => {
        const newcomerMark = buildNewcomerMark(member).trim();
        const displayName = getMemberDisplayName(member);

        return newcomerMark
            ? `・${newcomerMark} ${displayName}`
            : `・${displayName}`;
    });

    if (members.length > maxMembers) {
        lines.push(`・...ほか ${members.length - maxMembers} 名`);
    }

    return lines.join('\n');
}

function buildVoiceNoticeContent(member, oldChannel, newChannel) {
    const memberMention = `<@${member.id}>`;
    const nowText = formatDateTime(Date.now());

    if (!oldChannel && newChannel) {
        return [
            `🔊 ${memberMention} がVCに参加しました。`,
            `参加先: <#${newChannel.id}>`,
            `時刻: ${nowText}`,
            '',
            `現在の ${newChannel.name}:`,
            formatVoiceMemberList(newChannel),
        ].join('\n');
    }

    if (oldChannel && !newChannel) {
        return [
            `🔇 ${memberMention} がVCから退出しました。`,
            `退出元: <#${oldChannel.id}>`,
            `時刻: ${nowText}`,
            '',
            `現在の ${oldChannel.name}:`,
            formatVoiceMemberList(oldChannel),
        ].join('\n');
    }

    if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        return [
            `🔁 ${memberMention} がVCを移動しました。`,
            `移動元: <#${oldChannel.id}>`,
            `移動先: <#${newChannel.id}>`,
            `時刻: ${nowText}`,
            '',
            `現在の ${oldChannel.name}:`,
            formatVoiceMemberList(oldChannel),
            '',
            `現在の ${newChannel.name}:`,
            formatVoiceMemberList(newChannel),
        ].join('\n');
    }

    return null;
}

async function sendVoiceNoticeToWebhook(webhookUrl, member, newChannel, oldChannel, content) {
    const displayName = getMemberDisplayName(member);
    const newcomerMark = buildNewcomerMark(member).trim();

    const channelName =
        newChannel?.name ||
        oldChannel?.name ||
        'Voice';

    const webhookUsername = newcomerMark
        ? `${newcomerMark} ${displayName} | 🔊 ${channelName}`
        : `${displayName} | 🔊 ${channelName}`;

    const avatarURL = getMemberAvatarURL(member);

    const webhookClient = new WebhookClient({
        url: webhookUrl,
    });

    await webhookClient.send({
        content,
        username: webhookUsername.slice(0, 80),
        avatarURL,
        allowedMentions: {
            parse: [],
        },
    });
}

function registerVoiceStateRelay(client, kv) {
    client.on('voiceStateUpdate', async (oldState, newState) => {
        console.log(
            '[voiceStateUpdate]',
            oldState.channelId,
            '->',
            newState.channelId,
            newState.member?.user?.tag,
        );
        try {
            const guildId = newState.guild?.id || oldState.guild?.id;
            if (!guildId) return;

            const member = newState.member || oldState.member;
            if (!member) return;

            // Bot自身は無視
            if (member.id === client.user.id) return;

            const oldChannel = oldState.channel;
            const newChannel = newState.channel;

            // ミュート/スピーカー状態変更など、チャンネル移動を伴わない更新は無視
            if (oldChannel?.id === newChannel?.id) return;

            const relatedChannel = newChannel || oldChannel;
            if (!relatedChannel) return;

            // 鯖全体転送の除外チャンネルにVCが入っていたら通知しない
            const excludedChannelIds = await kv.sMembers(
                forwardExcludeChannelsKey(guildId),
            );

            if (excludedChannelIds.includes(relatedChannel.id)) return;

            // /forward set source_channel未指定、つまりサーバー全体転送のWebhookを使う
            const webhookUrls = await kv.sMembers(
                forwardWebhookTargetsKey(guildId, FORWARD_ALL_CHANNELS),
            );

            if (!webhookUrls || webhookUrls.length === 0) return;

            const content = buildVoiceNoticeContent(member, oldChannel, newChannel);
            if (!content) return;

            const uniqueWebhookUrls = [...new Set(webhookUrls)];

            for (const webhookUrl of uniqueWebhookUrls) {
                await sendVoiceNoticeToWebhook(
                    webhookUrl,
                    member,
                    newChannel,
                    oldChannel,
                    content,
                );
            }
        } catch (error) {
            console.error('VC参加通知でエラー:', error);
        }
    });
}

module.exports = {
    registerVoiceStateRelay,
};