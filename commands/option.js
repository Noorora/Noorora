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
const {
    botAdminRoleKey,
    botOptionAuditLogKey,
} = require('../keys/redisKeys');

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
        '🗑️ **管理ロール解除**',
        'Bot管理ロール設定を解除します。',
        '',
        '🆔 **管理ロールID設定**',
        '一覧にロールが出てこない場合、ロールIDを直接入力して設定します。',
        '',
        '📝 **操作ログ**',
        '誰がいつBot設定を変更したかを表示します。',
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
                .setCustomId('option_menu_audit_log')
                .setLabel('操作ログ')
                .setEmoji('📝')
                .setStyle(ButtonStyle.Primary),

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

async function addOptionAuditLog(interaction, kv, action, detail) {
    const log = {
        at: Date.now(),
        userId: interaction.user.id,
        userTag: interaction.user.tag,
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
        49,
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

async function showOptionAuditLog(interaction, kv) {
    const logs = await kv.lRange(
        botOptionAuditLogKey(interaction.guildId),
        0,
        19,
    );

    if (!logs || logs.length === 0) {
        await interaction.reply(
            ephemeralOptions({
                content: 'Botオプションの操作ログはまだありません。',
            }),
        );

        return;
    }

    const lines = [];

    lines.push('## 📝 Botオプション操作ログ');
    lines.push('');
    lines.push('最新20件を表示します。');
    lines.push('');

    logs.forEach((raw, index) => {
        let log;

        try {
            log = JSON.parse(raw);
        } catch {
            log = null;
        }

        if (!log) {
            lines.push(`${index + 1}. 解析できないログ`);
            lines.push('');
            return;
        }

        lines.push(`${index + 1}. ${formatDateTime(log.at)}`);
        lines.push(`実行者: <@${log.userId}> (${log.userTag || log.userId})`);
        lines.push(`操作: ${log.action}`);
        lines.push(`内容: ${log.detail}`);
        lines.push('');
    });

    await interaction.reply(
        ephemeralOptions({
            content: lines.join('\n'),
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

        if (interaction.customId === 'option_menu_audit_log') {
            await showOptionAuditLog(
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

            await addOptionAuditLog(
                interaction,
                kv,
                'Bot管理ロール解除',
                `Bot管理ロール <@&${adminRoleId}> の設定を解除しました。`,
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

            await addOptionAuditLog(
                interaction,
                kv,
                'Bot管理ロール設定',
                `Bot管理ロールを <@&${role.id}> に設定しました。`,
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

            await addOptionAuditLog(
                interaction,
                kv,
                'Bot管理ロールID設定',
                `Bot管理ロールを <@&${role.id}> に設定しました。`,
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