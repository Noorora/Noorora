const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const {
    splitLinesToMessages,
    splitBySpaceToMessages,
} = require('../utils/messageSplit');

async function collectSpeakerIdsFromChannel(channel) {
    const speakerIds = new Set();
    let before;
    let fetchedCount = 0;

    while (true) {
        const options = {
            limit: 100,
        };

        if (before) {
            options.before = before;
        }

        const batch = await channel.messages.fetch(options);

        if (batch.size === 0) {
            break;
        }

        for (const message of batch.values()) {
            if (!message.author.bot) {
                speakerIds.add(message.author.id);
            }
        }

        fetchedCount += batch.size;

        const lastMessage = batch.last();

        if (!lastMessage) {
            break;
        }

        before = lastMessage.id;

        if (batch.size < 100) {
            break;
        }
    }

    return {
        speakerIds,
        fetchedCount,
    };
}

function buildRoleMenuContent() {
    return [
        '## 👥 ロール分析',
        '',
        '操作を選んでください。',
        '',
        '📋 **ロール未所持者**',
        '指定ロールを持っていないメンバーを表示します。',
        '',
        '➕ **発言履歴未参加者**',
        '指定ロールを持たず、指定チャンネルで発言していないメンバーを表示します。',
        '',
        '🔍 **ロール条件抽出**',
        'あるロールを持ち、別のロールを持っていないメンバーを表示します。',
    ].join('\n');
}

function buildRoleMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('role_menu_missing')
                .setLabel('ロール未所持者')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('role_menu_channelnever')
                .setLabel('発言履歴未参加者')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('role_menu_filter')
                .setLabel('ロール条件抽出')
                .setEmoji('🔍')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildRoleSelectMenu(customId, placeholder) {
    return [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(placeholder)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildChannelSelectMenu(customId, placeholder) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(placeholder)
                .setChannelTypes(ChannelType.GuildText)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildOutputTypeButtons(prefix) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${prefix}:list`)
                .setLabel('一覧表示')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId(`${prefix}:mention`)
                .setLabel('メンション用')
                .setEmoji('📣')
                .setStyle(ButtonStyle.Success),
        ),
    ];
}

async function replyLines(interaction, header, lines) {
    const chunks = splitLinesToMessages(header, lines);

    await interaction.reply(
        ephemeralOptions({
            content: chunks[0],
        }),
    );

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

async function editLines(interaction, header, lines) {
    const chunks = splitLinesToMessages(header, lines);

    await interaction.editReply({
        content: chunks[0],
        components: [],
    });

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

async function replyMentionChunks(interaction, header, rawMentions) {
    const chunks = splitBySpaceToMessages('', rawMentions);

    await interaction.reply(
        ephemeralOptions({
            content:
                `${header}\n` +
                `下のコードブロックをコピーして使ってください。\n\n` +
                `\`\`\`txt\n${chunks[0]}\n\`\`\``,
        }),
    );

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: `\`\`\`txt\n${chunks[i]}\n\`\`\``,
            }),
        );
    }
}

async function editMentionChunks(interaction, header, rawMentions) {
    const chunks = splitBySpaceToMessages('', rawMentions);

    await interaction.editReply({
        content:
            `${header}\n` +
            `下のコードブロックをコピーして使ってください。\n\n` +
            `\`\`\`txt\n${chunks[0]}\n\`\`\``,
        components: [],
    });

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: `\`\`\`txt\n${chunks[i]}\n\`\`\``,
            }),
        );
    }
}

async function collectMissingRoleMembers(interaction, targetRole) {
    await interaction.guild.members.fetch();

    return interaction.guild.members.cache.filter((member) => {
        return !member.user.bot && !member.roles.cache.has(targetRole.id);
    });
}

async function collectChannelNeverMembers(interaction, targetRole, sourceChannel) {
    const {
        speakerIds,
        fetchedCount,
    } = await collectSpeakerIdsFromChannel(sourceChannel);

    await interaction.guild.members.fetch();

    const members = interaction.guild.members.cache.filter((member) => {
        return (
            !member.user.bot &&
            !member.roles.cache.has(targetRole.id) &&
            !speakerIds.has(member.id)
        );
    });

    return {
        members,
        fetchedCount,
    };
}

async function collectFilteredMembers(interaction, hasRole, notRole) {
    await interaction.guild.members.fetch();

    return interaction.guild.members.cache.filter((member) => {
        return (
            !member.user.bot &&
            member.roles.cache.has(hasRole.id) &&
            !member.roles.cache.has(notRole.id)
        );
    });
}

async function outputMissingRoleResult(interaction, targetRole, mode, alreadyAcknowledged = false) {
    const members = await collectMissingRoleMembers(
        interaction,
        targetRole,
    );

    if (members.size === 0) {
        const content = `ロール <@&${targetRole.id}> を持っていないメンバーはいません。`;

        if (alreadyAcknowledged) {
            await interaction.editReply({
                content,
                components: [],
            });
        } else {
            await interaction.reply(
                ephemeralOptions({
                    content,
                }),
            );
        }

        return;
    }

    if (mode === 'list') {
        const lines = members.map((member) => {
            return `・${member.user.tag} (<@${member.id}>)`;
        });

        const header = `ロール <@&${targetRole.id}> を持っていないメンバー一覧:\n`;

        if (alreadyAcknowledged) {
            await editLines(
                interaction,
                header,
                lines,
            );
        } else {
            await replyLines(
                interaction,
                header,
                lines,
            );
        }

        return;
    }

    if (mode === 'mention') {
        const rawMentions = members.map((member) => {
            return `<@${member.id}>`;
        });

        const header = `ロール <@&${targetRole.id}> を持っていないメンバーのコピペ用メンションです。`;

        if (alreadyAcknowledged) {
            await editMentionChunks(
                interaction,
                header,
                rawMentions,
            );
        } else {
            await replyMentionChunks(
                interaction,
                header,
                rawMentions,
            );
        }
    }
}

async function outputChannelNeverResult(interaction, targetRole, sourceChannel, mode, alreadyAcknowledged = false) {
    if (sourceChannel.type !== ChannelType.GuildText) {
        const content = 'source_channel には通常のテキストチャンネルを指定してください。';

        if (alreadyAcknowledged) {
            await interaction.editReply({
                content,
                components: [],
            });
        } else {
            await interaction.reply(
                ephemeralOptions({
                    content,
                }),
            );
        }

        return;
    }

    let members;
    let fetchedCount;

    if (alreadyAcknowledged) {
        await interaction.editReply({
            content:
                `チャンネル <#${sourceChannel.id}> の履歴を取得しています。\n` +
                `しばらくお待ちください。`,
            components: [],
        });

        const result = await collectChannelNeverMembers(
            interaction,
            targetRole,
            sourceChannel,
        );

        members = result.members;
        fetchedCount = result.fetchedCount;
    } else {
        await interaction.deferReply(
            ephemeralOptions(),
        );

        const result = await collectChannelNeverMembers(
            interaction,
            targetRole,
            sourceChannel,
        );

        members = result.members;
        fetchedCount = result.fetchedCount;
    }

    if (members.size === 0) {
        await interaction.editReply({
            content:
                `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーはいません。`,
            components: [],
        });
        return;
    }

    if (mode === 'list') {
        const lines = members.map((member) => {
            return `・${member.user.tag} (<@${member.id}>)`;
        });

        const chunks = splitLinesToMessages(
            `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバー一覧:\n`,
            lines,
        );

        await interaction.editReply({
            content: chunks[0],
            components: [],
        });

        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(
                ephemeralOptions({
                    content: chunks[i],
                }),
            );
        }

        return;
    }

    if (mode === 'mention') {
        const rawMentions = members.map((member) => {
            return `<@${member.id}>`;
        });

        const chunks = splitBySpaceToMessages(
            '',
            rawMentions,
        );

        await interaction.editReply({
            content:
                `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーのコピペ用メンションです。\n` +
                `下のコードブロックをコピーして使ってください。\n\n` +
                `\`\`\`txt\n${chunks[0]}\n\`\`\``,
            components: [],
        });

        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(
                ephemeralOptions({
                    content: `\`\`\`txt\n${chunks[i]}\n\`\`\``,
                }),
            );
        }
    }
}

async function outputFilterResult(interaction, hasRole, notRole, mode, alreadyAcknowledged = false) {
    const members = await collectFilteredMembers(
        interaction,
        hasRole,
        notRole,
    );

    if (members.size === 0) {
        const content = `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーはいません。`;

        if (alreadyAcknowledged) {
            await interaction.editReply({
                content,
                components: [],
            });
        } else {
            await interaction.reply(
                ephemeralOptions({
                    content,
                }),
            );
        }

        return;
    }

    if (mode === 'list') {
        const lines = members.map((member) => {
            return `・${member.user.tag} (<@${member.id}>)`;
        });

        const header = `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバー一覧:\n`;

        if (alreadyAcknowledged) {
            await editLines(
                interaction,
                header,
                lines,
            );
        } else {
            await replyLines(
                interaction,
                header,
                lines,
            );
        }

        return;
    }

    if (mode === 'mention') {
        const rawMentions = members.map((member) => {
            return `<@${member.id}>`;
        });

        const header = `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーのコピペ用メンションです。`;

        if (alreadyAcknowledged) {
            await editMentionChunks(
                interaction,
                header,
                rawMentions,
            );
        } else {
            await replyMentionChunks(
                interaction,
                header,
                rawMentions,
            );
        }
    }
}

async function execute(interaction) {
    await interaction.reply(
        ephemeralOptions({
            content: buildRoleMenuContent(),
            components: buildRoleMenuComponents(),
        }),
    );
}

async function handleComponent(interaction) {
    if (interaction.isButton()) {
        if (interaction.customId === 'role_menu_missing') {
            await interaction.reply(
                ephemeralOptions({
                    content: '基準ロールを選択してください。',
                    components: buildRoleSelectMenu(
                        'role_missing_select_role',
                        '基準ロールを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId === 'role_menu_channelnever') {
            await interaction.reply(
                ephemeralOptions({
                    content: '基準ロールを選択してください。',
                    components: buildRoleSelectMenu(
                        'role_channelnever_select_role',
                        '基準ロールを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId === 'role_menu_filter') {
            await interaction.reply(
                ephemeralOptions({
                    content: '所持必須ロールを選択してください。',
                    components: buildRoleSelectMenu(
                        'role_filter_select_has',
                        '所持必須ロールを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId.startsWith('role_missing_output:')) {
            const [, roleId, mode] = interaction.customId.split(':');

            const role = await interaction.guild.roles
                .fetch(roleId)
                .catch(() => null);

            if (!role) {
                await interaction.update({
                    content: '選択されたロールが見つかりませんでした。',
                    components: [],
                });

                return true;
            }

            await interaction.update({
                content:
                    `ロール <@&${role.id}> の未所持者を取得しています。\n` +
                    `しばらくお待ちください。`,
                components: [],
            });

            await outputMissingRoleResult(
                interaction,
                role,
                mode,
                true,
            );

            return true;
        }

        if (interaction.customId.startsWith('role_channelnever_output:')) {
            const [, roleId, channelId, mode] = interaction.customId.split(':');

            const role = await interaction.guild.roles
                .fetch(roleId)
                .catch(() => null);

            const channel = await interaction.guild.channels
                .fetch(channelId)
                .catch(() => null);

            if (!role) {
                await interaction.update({
                    content: '選択されたロールが見つかりませんでした。',
                    components: [],
                });

                return true;
            }

            if (!channel || channel.type !== ChannelType.GuildText) {
                await interaction.update({
                    content: '選択されたチャンネルが見つからないか、通常のテキストチャンネルではありません。',
                    components: [],
                });

                return true;
            }

            await outputChannelNeverResult(
                interaction,
                role,
                channel,
                mode,
                true,
            );

            return true;
        }

        if (interaction.customId.startsWith('role_filter_output:')) {
            const [, hasRoleId, notRoleId, mode] = interaction.customId.split(':');

            const hasRole = await interaction.guild.roles
                .fetch(hasRoleId)
                .catch(() => null);

            const notRole = await interaction.guild.roles
                .fetch(notRoleId)
                .catch(() => null);

            if (!hasRole || !notRole) {
                await interaction.update({
                    content: '選択されたロールが見つかりませんでした。',
                    components: [],
                });

                return true;
            }

            await interaction.update({
                content:
                    `ロール条件に合うメンバーを取得しています。\n` +
                    `所持: <@&${hasRole.id}>\n` +
                    `未所持: <@&${notRole.id}>`,
                components: [],
            });

            await outputFilterResult(
                interaction,
                hasRole,
                notRole,
                mode,
                true,
            );

            return true;
        }

        return false;
    }

    if (interaction.isRoleSelectMenu()) {
        if (interaction.customId === 'role_missing_select_role') {
            const roleId = interaction.values[0];

            await interaction.update({
                content:
                    `基準ロール: <@&${roleId}>\n` +
                    `出力形式を選択してください。`,
                components: buildOutputTypeButtons(`role_missing_output:${roleId}`),
            });

            return true;
        }

        if (interaction.customId === 'role_channelnever_select_role') {
            const roleId = interaction.values[0];

            await interaction.update({
                content:
                    `基準ロール: <@&${roleId}>\n` +
                    `確認するテキストチャンネルを選択してください。`,
                components: buildChannelSelectMenu(
                    `role_channelnever_select_channel:${roleId}`,
                    '確認するテキストチャンネルを選択してください',
                ),
            });

            return true;
        }

        if (interaction.customId === 'role_filter_select_has') {
            const hasRoleId = interaction.values[0];

            await interaction.update({
                content:
                    `所持必須ロール: <@&${hasRoleId}>\n` +
                    `未所持条件にするロールを選択してください。`,
                components: buildRoleSelectMenu(
                    `role_filter_select_not:${hasRoleId}`,
                    '未所持条件にするロールを選択してください',
                ),
            });

            return true;
        }

        if (interaction.customId.startsWith('role_filter_select_not:')) {
            const hasRoleId = interaction.customId.split(':')[1];
            const notRoleId = interaction.values[0];

            await interaction.update({
                content:
                    `所持必須ロール: <@&${hasRoleId}>\n` +
                    `未所持条件ロール: <@&${notRoleId}>\n` +
                    `出力形式を選択してください。`,
                components: buildOutputTypeButtons(`role_filter_output:${hasRoleId}:${notRoleId}`),
            });

            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId.startsWith('role_channelnever_select_channel:')) {
            const roleId = interaction.customId.split(':')[1];
            const channelId = interaction.values[0];

            await interaction.update({
                content:
                    `基準ロール: <@&${roleId}>\n` +
                    `確認チャンネル: <#${channelId}>\n` +
                    `出力形式を選択してください。`,
                components: buildOutputTypeButtons(`role_channelnever_output:${roleId}:${channelId}`),
            });

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'role',
    execute,
    handleComponent,
};