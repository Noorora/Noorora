const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    RoleSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { botAdminRoleKey } = require('../keys/redisKeys');

function buildOptionMenuContent() {
    return [
        '## ⚙️ Botオプション設定',
        '',
        '操作を選んでください。',
        '',
        '📋 **設定一覧**',
        '現在のBot管理ロール設定を表示します。',
        '',
        '➕ **管理ロール設定**',
        '一覧からBot管理ロールを選択して設定します。',
        '',
        '🆔 **管理ロールID設定**',
        '一覧にロールが出てこない場合、ロールIDを直接入力して設定します。',
        '',
        '🗑️ **管理ロール解除**',
        'Bot管理ロール設定を解除します。',
        '',
        '補足:',
        'Bot管理ロールを持っている人、または「サーバー管理」権限を持っている人は管理系コマンドを使えます。',
    ].join('\n');
}

function buildOptionMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('option_menu_show')
                .setLabel('設定一覧')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('option_menu_set_admin_role')
                .setLabel('管理ロール設定')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('option_menu_unset_admin_role')
                .setLabel('管理ロール解除')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('option_menu_set_admin_role_by_id')
                .setLabel('管理ロールID設定')
                .setEmoji('🆔')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildAdminRoleSelectMenu() {
    return [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId('option_select_admin_role')
                .setPlaceholder('Bot管理ロールを選択してください')
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildAdminRoleIdModal() {
    return new ModalBuilder()
        .setCustomId('option_admin_role_id_modal')
        .setTitle('Bot管理ロールID設定')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('role_id')
                    .setLabel('Bot管理ロールにするロールID')
                    .setPlaceholder('例: 123456789012345678')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

async function showOptionSettings(interaction, kv) {
    const adminRoleId = await kv.get(
        botAdminRoleKey(interaction.guildId),
    );

    const content = adminRoleId
        ? [
            '## ⚙️ 現在のBotオプション設定',
            '',
            `Bot管理ロール: <@&${adminRoleId}>`,
            '',
            'このロールを持つ人は、管理系コマンドを使用できます。',
        ].join('\n')
        : [
            '## ⚙️ 現在のBotオプション設定',
            '',
            'Bot管理ロール: 未設定',
            '',
            '現在は「サーバー管理」権限を持つ人のみが管理系コマンドを使用できます。',
        ].join('\n');

    await interaction.reply(
        ephemeralOptions({
            content,
        }),
    );
}

async function execute(interaction, context) {
    await interaction.reply(
        ephemeralOptions({
            content: buildOptionMenuContent(),
            components: buildOptionMenuComponents(),
        }),
    );
}

async function handleComponent(interaction, context) {
    const { kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'option_menu_show') {
            await showOptionSettings(
                interaction,
                kv,
            );

            return true;
        }

        if (interaction.customId === 'option_menu_set_admin_role') {
            await interaction.reply(
                ephemeralOptions({
                    content: 'Bot管理ロールにするロールを選択してください。',
                    components: buildAdminRoleSelectMenu(),
                }),
            );

            return true;
        }

        if (interaction.customId === 'option_menu_set_admin_role_by_id') {
            await interaction.showModal(
                buildAdminRoleIdModal(),
            );

            return true;
        }

        if (interaction.customId === 'option_menu_unset_admin_role') {
            const adminRoleId = await kv.get(
                botAdminRoleKey(interaction.guildId),
            );

            if (!adminRoleId) {
                await interaction.reply(
                    ephemeralOptions({
                        content: 'Bot管理ロールはまだ設定されていません。',
                    }),
                );

                return true;
            }

            await kv.del(
                botAdminRoleKey(interaction.guildId),
            );

            await interaction.reply(
                ephemeralOptions({
                    content: `Bot管理ロール <@&${adminRoleId}> の設定を解除しました。`,
                }),
            );

            return true;
        }

        return false;
    }

    if (interaction.isRoleSelectMenu()) {
        if (interaction.customId === 'option_select_admin_role') {
            const roleId = interaction.values[0];

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

            await kv.set(
                botAdminRoleKey(interaction.guildId),
                role.id,
            );

            await interaction.update({
                content:
                    `Bot管理ロールを <@&${role.id}> に設定しました。\n` +
                    `このロールを持つ人は、管理系コマンドを使用できます。`,
                components: [],
            });

            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'option_admin_role_id_modal') {
            const roleId = interaction.fields
                .getTextInputValue('role_id')
                .trim();

            if (!/^\d{17,20}$/.test(roleId)) {
                await interaction.reply(
                    ephemeralOptions({
                        content: 'ロールIDの形式が正しくありません。17〜20桁程度のDiscord IDを指定してください。',
                    }),
                );

                return true;
            }

            const role = await interaction.guild.roles
                .fetch(roleId)
                .catch(() => null);

            if (!role) {
                await interaction.reply(
                    ephemeralOptions({
                        content: `ロールID ${roleId} のロールがこのサーバー内で見つかりませんでした。`,
                    }),
                );

                return true;
            }

            await kv.set(
                botAdminRoleKey(interaction.guildId),
                role.id,
            );

            await interaction.reply(
                ephemeralOptions({
                    content:
                        `Bot管理ロールを <@&${role.id}> に設定しました。\n` +
                        `このロールを持つ人は、管理系コマンドを使用できます。`,
                }),
            );

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'option',
    execute,
    handleComponent,
};