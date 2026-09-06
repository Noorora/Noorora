const {
    PermissionFlagsBits,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { handleCleanupButton } = require('./cleanupButtons');
const { botAdminRoleKey } = require('../keys/redisKeys');

const commandModules = [
    require('../commands/help'),
    require('../commands/option'),
    require('../commands/forum'),
    require('../commands/forumlog'),
    require('../commands/rolemention'),
    require('../commands/reaction'),
    require('../commands/role'),
    require('../commands/forward'),
    require('../commands/hasrole'),
    require('../commands/joined'),
    require('../commands/pins'),
    //require('../commands/music'),//サーバーの容量を食いすぎるので封印
];

const commands = new Map(
    commandModules.map((command) => [command.name, command]),
);

const publicCommandNames = new Set([
    'help',
    'joined',
    'music',
]);

async function hasBotCommandPermission(interaction, context) {
    if (!interaction.inGuild()) {
        return false;
    }

    const ownerUserId = process.env.BOT_OWNER_USER_ID;

    if (
        ownerUserId &&
        interaction.user?.id === ownerUserId
    ) {
        return true;
    }

    const memberPermissions = interaction.memberPermissions;

    if (
        memberPermissions &&
        memberPermissions.has(PermissionFlagsBits.ManageGuild)
    ) {
        return true;
    }

    const { kv } = context;

    const adminRoleId = await kv.get(
        botAdminRoleKey(interaction.guildId),
    );

    if (!adminRoleId) {
        return false;
    }

    const member = interaction.member;

    if (!member || !member.roles) {
        return false;
    }

    return member.roles.cache.has(adminRoleId);
}

function isPublicInteraction(interaction) {
    if (interaction.isChatInputCommand()) {
        return publicCommandNames.has(interaction.commandName);
    }

    return false;
}

async function rejectNoPermission(interaction) {
    await replyInteractionError(
        interaction,
        'この操作を使用する権限がありません。Bot管理ロール、または「サーバー管理」権限が必要です。',
    );
}

async function handleInteractionCreate(interaction, context) {

    if (
        interaction.isButton() ||
        interaction.isModalSubmit() ||
        interaction.isChannelSelectMenu() ||
        interaction.isRoleSelectMenu() ||
        interaction.isUserSelectMenu()
    ) {
        if (!interaction.inGuild()) {
            await interaction.reply(
                ephemeralOptions({
                    content: 'この操作はサーバー内でのみ使用できます。',
                }),
            );
            return;
        }

        try {
            const permitted = await hasBotCommandPermission(
                interaction,
                context,
            );

            if (!permitted) {
                await rejectNoPermission(interaction);
                return;
            }

            const customId = interaction.customId || '';

            const componentCommandName =
                customId.split('_')[0];

            const componentCommand =
                commands.get(componentCommandName);

            if (
                componentCommand &&
                typeof componentCommand.handleComponent ===
                'function'
            ) {
                try {
                    const handled =
                        await componentCommand.handleComponent(
                            interaction,
                            context,
                        );

                    if (handled) {
                        return;
                    }
                } catch (error) {
                    console.error(
                        `[component] command=${componentCommandName} customId=${customId}`,
                        error,
                    );

                    throw error;
                }
            }

            if (interaction.isButton()) {
                const handled = await handleCleanupButton(
                    interaction,
                    context,
                );

                if (handled) {
                    return;
                }
            }
        } catch (error) {
            console.error('component interaction でエラー:', error);
            await replyInteractionError(
                interaction,
                '確認処理中にエラーが発生しました。',
            );
            return;
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (!interaction.inGuild()) {
        await interaction.reply(
            ephemeralOptions({
                content: 'このコマンドはサーバー内でのみ使用できます。',
            }),
        );
        return;
    }

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
        if (!isPublicInteraction(interaction)) {
            const permitted = await hasBotCommandPermission(
                interaction,
                context,
            );

            if (!permitted) {
                await rejectNoPermission(interaction);
                return;
            }
        }

        await command.execute(interaction, context);
    } catch (error) {
        console.error('interactionCreate でエラー:', error);
        await replyInteractionError(
            interaction,
            'コマンド実行中にエラーが発生しました。',
        );
    }
}

async function replyInteractionError(interaction, message) {
    if (interaction.deferred) {
        await interaction.editReply({
            content: message,
        }).catch(() => null);
        return;
    }

    if (interaction.replied) {
        await interaction.followUp(
            ephemeralOptions({
                content: message,
            }),
        ).catch(() => null);
        return;
    }

    await interaction.reply(
        ephemeralOptions({
            content: message,
        }),
    ).catch(() => null);
}

module.exports = {
    handleInteractionCreate,
};