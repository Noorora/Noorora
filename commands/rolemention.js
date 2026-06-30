const crypto = require('crypto');
const { ChannelType } = require('discord.js');
const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { buildCleanupChoiceButtons, buildStaleSummaryContent } = require('../components/cleanupButtons');
const { pendingCleanupKey, roleMentionTargetsKey, roleMentionMessageMapKey } = require('../keys/redisKeys');
const { buildRoleMentionPlaceholdersHelp } = require('../templates/roleMentionTemplate');
const { collectRoleMentionShowData } = require('../services/roleMentionService');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

async function execute(interaction, context) {
    const { client, kv } = context;
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
        const role = interaction.options.getRole('role', true);
        const targetChannel = interaction.options.getChannel('target_channel', true);
        const messageTemplate = interaction.options.getString('message', false);

        if (!allowedTargetTypes.includes(targetChannel.type)) {
            await interaction.reply(ephemeralOptions({ content: 'target_channel にはチャンネルまたはスレッドを指定してください。' }));
            return;
        }

        await kv.hSet(roleMentionTargetsKey(interaction.guildId), role.id, targetChannel.id);
        if (messageTemplate) await kv.hSet(roleMentionMessageMapKey(interaction.guildId), role.id, messageTemplate);

        let content =
            `ロールメンション転載設定を登録しました。\n` +
            `ロール: <@&${role.id}>\n` +
            `転載先: <#${targetChannel.id}>\n` +
            `カスタムメッセージ: ${messageTemplate ? 'あり' : 'なし'}`;
        if (messageTemplate) content += `\n設定メッセージ:\n\`\`\`txt\n${messageTemplate.replaceAll('\\n', '\n')}\n\`\`\``;

        await interaction.reply(ephemeralOptions({ content }));
        return;
    }

    if (sub === 'placeholders') {
        await interaction.reply(ephemeralOptions({ content: buildRoleMentionPlaceholdersHelp() }));
        return;
    }

    if (sub === 'show') {
        const { validLines, staleEntries } = await collectRoleMentionShowData(client, kv, interaction.guildId);
        if (validLines.length === 0 && staleEntries.length === 0) {
            await interaction.reply(ephemeralOptions({ content: 'このサーバーにはまだロールメンション転載設定がありません。' }));
            return;
        }

        if (staleEntries.length === 0) {
            const chunks = splitLinesToMessages('現在のロールメンション転載設定一覧:\n', validLines);
            await interaction.reply(ephemeralOptions({ content: chunks[0] }));
            for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
            return;
        }

        const staleLines = staleEntries.map((entry) => `ロール <@&${entry.roleId}> → 消失した転載先 <#${entry.targetId}>`);
        const token = crypto.randomUUID();
        await kv.setEx(pendingCleanupKey(token), 900, JSON.stringify({ kind: 'rolemention', guildId: interaction.guildId, validLines, staleEntries, staleLines }));

        await interaction.reply(ephemeralOptions({
            content: buildStaleSummaryContent('rolemention', validLines, staleLines),
            components: buildCleanupChoiceButtons('rolemention', token),
        }));
        if (validLines.length > 0) {
            const validChunks = splitLinesToMessages('有効な設定一覧:\n', validLines);
            for (const chunk of validChunks) await interaction.followUp(ephemeralOptions({ content: chunk }));
        }
        const staleChunks = splitLinesToMessages('削除候補一覧:\n', staleLines.map((line, index) => `${index + 1}. ${line}`));
        for (const chunk of staleChunks) await interaction.followUp(ephemeralOptions({ content: chunk }));
        return;
    }

    if (sub === 'unset') {
        const role = interaction.options.getRole('role', true);
        const removed = await kv.hDel(roleMentionTargetsKey(interaction.guildId), role.id);
        if (!removed) {
            await interaction.reply(ephemeralOptions({ content: `ロール <@&${role.id}> の転載設定は見つかりませんでした。` }));
            return;
        }
        await kv.hDel(roleMentionMessageMapKey(interaction.guildId), role.id);
        await interaction.reply(ephemeralOptions({ content: `ロール <@&${role.id}> の転載設定を削除しました。` }));
    }
}

module.exports = {
    name: 'rolemention',
    execute,
};
