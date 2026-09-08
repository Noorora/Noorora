const {
    ChannelType,
    PermissionFlagsBits,
} = require('discord.js');

const {
    ephemeralOptions,
} = require('../utils/ephemeral');

const {
    addAuditLog,
} = require('../utils/auditLog');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function isAllowedTargetChannel(
    target_channel,
) {
    if (!target_channel) {
        return false;
    }

    if (
        !allowedTargetTypes.includes(
            target_channel.type,
        )
    ) {
        return false;
    }

    return (
        typeof target_channel.send ===
        'function'
    );
}

function getRequiredSendPermission(
    target_channel,
) {
    if (target_channel.isThread?.()) {
        return PermissionFlagsBits.SendMessagesInThreads;
    }

    return PermissionFlagsBits.SendMessages;
}

function canBotSendMessage(
    interaction,
    target_channel,
) {
    const botMember =
        interaction.guild.members.me;

    if (!botMember) {
        return false;
    }

    const permissions =
        target_channel.permissionsFor(
            botMember,
        );

    if (!permissions) {
        return false;
    }

    const sendPermission =
        getRequiredSendPermission(
            target_channel,
        );

    return (
        permissions.has(
            PermissionFlagsBits.ViewChannel,
        ) &&
        permissions.has(sendPermission)
    );
}

async function execute(
    interaction,
    context,
) {
    const { kv } = context;

    const target_channel =
        interaction.options.getChannel(
            'target_channel',
            true,
        );

    const messageContent =
        interaction.options
            .getString(
                'message',
                true,
            )
            .trim();

    if (
        target_channel.guildId !==
        interaction.guildId
    ) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    '送信先には、このサーバー内のチャンネルまたはスレッドを指定してください。',
            }),
        );

        return;
    }

    if (
        !isAllowedTargetChannel(
            target_channel,
        )
    ) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    'その種類のチャンネルにはメッセージを送信できません。',
            }),
        );

        return;
    }

    if (!messageContent) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    '送信するメッセージを入力してください。',
            }),
        );

        return;
    }

    if (messageContent.length > 2000) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    'メッセージは2000文字以内で入力してください。',
            }),
        );

        return;
    }

    if (
        !canBotSendMessage(
            interaction,
            target_channel,
        )
    ) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    'AutoDetectorには、そのチャンネルへメッセージを送信する権限がありません。',
            }),
        );

        return;
    }

    await interaction.deferReply(
        ephemeralOptions(),
    );

    try {
        const sentMessage =
            await target_channel.send({
                content: messageContent,

                /*
                 * メッセージ内のメンション表記を
                 * 実際の通知として動作させない。
                 */
                allowedMentions: {
                    parse: [],
                },
            });

        await addAuditLog(
            interaction,
            kv,
            'Botメッセージ送信',
            `実行者 <@${interaction.user.id}> が、` +
            `Botから <#${target_channel.id}> へ` +
            `メッセージを送信しました。` +
            `メッセージID: ${sentMessage.id}`,
        ).catch(() => null);

        await interaction.editReply({
            content:
                `メッセージを送信しました。\n` +
                `送信先: <#${target_channel.id}>\n` +
                `送信したメッセージ: ${sentMessage.url}`,
        });
    } catch (error) {
        console.error(
            'Botメッセージ送信エラー:',
            error,
        );

        await interaction.editReply({
            content:
                'メッセージの送信に失敗しました。AutoDetectorの権限とRenderログを確認してください。',
        });
    }
}

module.exports = {
    name: 'say',
    execute,
};