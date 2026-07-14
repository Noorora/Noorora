const {
    ChannelType,
    PermissionFlagsBits,
} = require('discord.js');

const { splitLinesToMessages } = require('../utils/messageSplit');
const { ephemeralOptions } = require('../utils/ephemeral');

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

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub !== 'list') {
        return;
    }

    await interaction.deferReply(
        ephemeralOptions(),
    );

    const lines = [];
    let totalPins = 0;

    const channels = interaction.guild.channels.cache
        .filter((channel) => {
            return (
                (
                    channel.type === ChannelType.GuildText ||
                    channel.type === ChannelType.GuildAnnouncement
                ) &&
                channel
                    .permissionsFor(interaction.member)
                    ?.has(PermissionFlagsBits.ViewChannel)
            );
        })
        .sort((a, b) => a.position - b.position);

    for (const channel of channels.values()) {
        try {
            const pinnedMessages =
                await channel.messages.fetchPinned();

            if (pinnedMessages.size === 0) {
                continue;
            }

            lines.push('');
            lines.push(`## #${channel.name}`);
            lines.push('');

            const sortedMessages =
                [...pinnedMessages.values()]
                    .sort((a, b) =>
                        a.createdTimestamp - b.createdTimestamp,
                    );

            for (const message of sortedMessages) {
                totalPins += 1;

                const content =
                    message.content?.trim() ||
                    '（本文なし）';

                lines.push(
                    `【${totalPins}件目】`,
                );

                lines.push(
                    `投稿者: ${message.author.tag}`,
                );

                lines.push(
                    `日時: ${formatDateTime(
                        message.createdTimestamp,
                    )}`,
                );

                lines.push(
                    `内容:\n${content}`,
                );

                lines.push(
                    `リンク: ${message.url}`,
                );

                if (message.attachments.size > 0) {
                    for (const attachment of message.attachments.values()) {
                        lines.push(
                            `添付: ${attachment.url}`,
                        );
                    }
                }

                lines.push('');
                lines.push(
                    '--------------------------------------------------',
                );
                lines.push('');
            }
        }
        catch (error) {
            console.warn(
                `ピン留め取得失敗: ${channel.name}`,
                error,
            );
        }
    }

    if (totalPins === 0) {
        await interaction.editReply({
            content:
                'サーバー内にピン留めされたメッセージは見つかりませんでした。',
        });
        return;
    }

    const chunks = splitLinesToMessages(
        `📌 サーバー内ピン留め一覧\n総件数: ${totalPins}件\n`,
        lines,
    );

    await interaction.editReply({
        content: chunks[0],
    });

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

module.exports = {
    name: 'pins',
    execute,
};