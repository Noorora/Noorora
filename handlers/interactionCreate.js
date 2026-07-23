const { ephemeralOptions } = require('../utils/ephemeral');
const { handleCleanupButton } = require('./cleanupButtons');

const commandModules = [
    require('../commands/help'),
    require('../commands/forum'),
    require('../commands/forumlog'),
    require('../commands/rolemention'),
    require('../commands/reaction'),
    require('../commands/role'),
    require('../commands/forward'),
    require('../commands/hasrole'),
    require('../commands/joined'),
    require('../commands/pins'),
];

const commands = new Map(
    commandModules.map((command) => [command.name, command]),
);

async function handleInteractionCreate(interaction, context) {
    // =========================================================
    // ボタン / モーダル系
    // =========================================================
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
            // 各コマンド側のボタン/モーダル処理を先に見る
            for (const command of commandModules) {
                if (typeof command.handleComponent !== 'function') {
                    continue;
                }

                const handled = await command.handleComponent(
                    interaction,
                    context,
                );

                if (handled) {
                    return;
                }
            }

            // 既存の cleanup ボタン処理
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

    // =========================================================
    // スラッシュコマンド系
    // =========================================================
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