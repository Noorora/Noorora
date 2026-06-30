const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { pendingCleanupKey } = require('../keys/redisKeys');
const {
    buildCleanupChoiceButtons,
    buildCleanupEntryButtons,
    buildStaleSummaryContent,
    buildStaleSelectionContent,
} = require('../components/cleanupButtons');
const {
    applyForumCleanup,
    applySingleForumCleanup,
} = require('../services/forumService');
const {
    applyRoleMentionCleanup,
    applySingleRoleMentionCleanup,
} = require('../services/roleMentionService');

async function handleCleanupButton(interaction, context) {
    const { kv } = context;
    const parts = interaction.customId.split(':');
    const action = parts[0];
    const kind = parts[1];
    const token = parts[2];

    if (!['cleanup_all', 'cleanup_pick', 'cleanup_back', 'cleanup_cancel', 'cleanup_one'].includes(action)) {
        return false;
    }

    const pendingRaw = await kv.get(pendingCleanupKey(token));
    if (!pendingRaw) {
        await interaction.reply(ephemeralOptions({
            content: '確認情報の有効期限が切れたため、もう一度 show を実行してください。',
        }));
        return true;
    }

    const pending = JSON.parse(pendingRaw);
    if (pending.guildId !== interaction.guildId || pending.kind !== kind) {
        await interaction.reply(ephemeralOptions({
            content: 'この確認情報は現在のサーバーでは使用できません。',
        }));
        return true;
    }

    const staleEntries = pending.staleEntries || [];
    const staleLines = pending.staleLines || [];
    const validLines = pending.validLines || [];

    if (action === 'cleanup_cancel') {
        await kv.del(pendingCleanupKey(token));
        await interaction.update({ content: '削除をキャンセルしました。', components: [] });
        return true;
    }

    if (action === 'cleanup_back') {
        await interaction.update({
            content: buildStaleSummaryContent(kind, validLines, staleLines),
            components: buildCleanupChoiceButtons(kind, token),
        });
        return true;
    }

    if (action === 'cleanup_pick') {
        const page = Number(parts[3] || 0);
        await interaction.update({
            content: buildStaleSelectionContent(kind, staleLines, page),
            components: buildCleanupEntryButtons(kind, token, staleEntries, page),
        });
        return true;
    }

    if (action === 'cleanup_all') {
        const removedLines = kind === 'forum'
            ? await applyForumCleanup(kv, interaction.guildId, staleEntries)
            : await applyRoleMentionCleanup(kv, interaction.guildId, staleEntries);

        await kv.del(pendingCleanupKey(token));
        await interaction.update({
            content: removedLines.length === 0
                ? '削除対象はありませんでした。'
                : `一括削除を完了しました。 ${removedLines.length} 件の設定を削除しました。`,
            components: [],
        });

        if (removedLines.length > 0) {
            const chunks = splitLinesToMessages('削除した設定一覧:\n', removedLines);
            for (const chunk of chunks) {
                await interaction.followUp(ephemeralOptions({ content: chunk }));
            }
        }
        return true;
    }

    if (action === 'cleanup_one') {
        const index = Number(parts[3]);
        const page = Number(parts[4] || 0);
        const entry = staleEntries[index];

        if (!entry) {
            await interaction.reply(ephemeralOptions({
                content: 'その削除候補は見つかりませんでした。もう一度 show を実行してください。',
            }));
            return true;
        }

        const removedLine = kind === 'forum'
            ? await applySingleForumCleanup(kv, interaction.guildId, entry)
            : await applySingleRoleMentionCleanup(kv, interaction.guildId, entry);

        const nextStaleEntries = staleEntries.filter((_, i) => i !== index);
        const nextStaleLines = staleLines.filter((_, i) => i !== index);

        if (nextStaleEntries.length === 0) {
            await kv.del(pendingCleanupKey(token));
            await interaction.update({
                content: '個別削除を完了しました。削除候補はすべて解消されました。',
                components: [],
            });
            if (removedLine) await interaction.followUp(ephemeralOptions({ content: removedLine }));
            return true;
        }

        await kv.setEx(pendingCleanupKey(token), 900, JSON.stringify({
            ...pending,
            staleEntries: nextStaleEntries,
            staleLines: nextStaleLines,
        }));

        const maxPage = Math.max(0, Math.ceil(nextStaleEntries.length / 10) - 1);
        const nextPage = Math.min(page, maxPage);
        await interaction.update({
            content: buildStaleSelectionContent(kind, nextStaleLines, nextPage),
            components: buildCleanupEntryButtons(kind, token, nextStaleEntries, nextPage),
        });
        if (removedLine) await interaction.followUp(ephemeralOptions({ content: removedLine }));
        return true;
    }

    return false;
}

module.exports = {
    handleCleanupButton,
};
