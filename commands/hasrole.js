const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    RoleSelectMenuBuilder,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { addAuditLog } = require('../utils/auditLog');

function buildHasRoleMenuContent() {
    return [
        '## 👥 ロール所持者確認',
        '',
        '操作を選んでください。',
        '',
        '📋 **ロール所持者一覧**',
        '指定したロールを持っているメンバー一覧を表示します。',
    ].join('\n');
}

function buildHasRoleMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('hasrole_menu_list')
                .setLabel('ロール所持者一覧')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),
        ),
    ];
}

function buildHasRoleRoleSelectMenu() {
    return [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId('hasrole_list_select_role')
                .setPlaceholder('確認するロールを選択してください')
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

async function showMembersWithRole(interaction, targetRole, alreadyAcknowledged = false, kv = null) {
    await interaction.guild.members.fetch();

    const membersWithRole = interaction.guild.members.cache.filter((member) => {
        return !member.user.bot && member.roles.cache.has(targetRole.id);
    });

    await addAuditLog(
        interaction,
        kv,
        'ロール所持者一覧取得',
        `ロール <@&${targetRole.id}> を持っているメンバー一覧を取得しました。対象人数: ${membersWithRole.size}人`,
    ).catch(() => null);

    if (membersWithRole.size === 0) {
        const content = `ロール <@&${targetRole.id}> を持っているメンバーはいません。`;

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

    const lines = membersWithRole.map((member) => {
        return `・${member.user.tag} (<@${member.id}>)`;
    });

    const chunks = splitLinesToMessages(
        `ロール <@&${targetRole.id}> を持っているメンバー一覧:\n`,
        lines,
    );

    if (alreadyAcknowledged) {
        await interaction.editReply({
            content: chunks[0],
            components: [],
        });
    } else {
        await interaction.reply(
            ephemeralOptions({
                content: chunks[0],
            }),
        );
    }

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

async function execute(interaction) {
    await interaction.reply(
        ephemeralOptions({
            content: buildHasRoleMenuContent(),
            components: buildHasRoleMenuComponents(),
        }),
    );
}

async function handleComponent(interaction, context) {
    const { kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'hasrole_menu_list') {
            await interaction.reply(
                ephemeralOptions({
                    content: '確認するロールを選択してください。',
                    components: buildHasRoleRoleSelectMenu(),
                }),
            );

            return true;
        }

        return false;
    }

    if (interaction.isRoleSelectMenu()) {
        if (interaction.customId === 'hasrole_list_select_role') {
            const roleId = interaction.values[0];

            const targetRole = await interaction.guild.roles
                .fetch(roleId)
                .catch(() => null);

            if (!targetRole) {
                await interaction.update({
                    content: '選択されたロールが見つかりませんでした。',
                    components: [],
                });

                return true;
            }

            await interaction.update({
                content:
                    `ロール <@&${targetRole.id}> を持っているメンバーを取得しています。`,
                components: [],
            });

            await showMembersWithRole(
                interaction,
                targetRole,
                true,
                kv,
            );

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'hasrole',
    execute,
    handleComponent,
};