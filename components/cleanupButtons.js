const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function buildCleanupChoiceButtons(kind, token) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cleanup_all:${kind}:${token}`)
                .setLabel('一括削除')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`cleanup_pick:${kind}:${token}:0`)
                .setLabel('個別削除')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`cleanup_cancel:${kind}:${token}`)
                .setLabel('キャンセル')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildCleanupEntryButtons(kind, token, staleEntries, page = 0, pageSize = 10) {
    const rows = [];
    const start = page * pageSize;
    const pageEntries = staleEntries.slice(start, start + pageSize);

    for (let rowIndex = 0; rowIndex < Math.ceil(pageEntries.length / 5); rowIndex++) {
        const row = new ActionRowBuilder();
        for (let i = rowIndex * 5; i < Math.min((rowIndex + 1) * 5, pageEntries.length); i++) {
            const absoluteIndex = start + i;
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`cleanup_one:${kind}:${token}:${absoluteIndex}:${page}`)
                    .setLabel(String(absoluteIndex + 1))
                    .setStyle(ButtonStyle.Danger),
            );
        }
        rows.push(row);
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cleanup_pick:${kind}:${token}:${Math.max(page - 1, 0)}`)
                .setLabel('前へ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page <= 0),
            new ButtonBuilder()
                .setCustomId(`cleanup_pick:${kind}:${token}:${page + 1}`)
                .setLabel('次へ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(start + pageSize >= staleEntries.length),
            new ButtonBuilder()
                .setCustomId(`cleanup_back:${kind}:${token}`)
                .setLabel('選択画面に戻る')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`cleanup_cancel:${kind}:${token}`)
                .setLabel('キャンセル')
                .setStyle(ButtonStyle.Secondary),
        ),
    );

    return rows;
}

function buildStaleSummaryContent(kind, validLines, staleLines) {
    const title = kind === 'forum'
        ? '現在のフォーラム通知設定一覧:'
        : '現在のロールメンション転載設定一覧:';

    return [
        title,
        `有効な設定: ${validLines.length} 行`,
        `削除候補: ${staleLines.length} 件`,
        '',
        '消えている転送先が見つかりました。',
        '「一括削除」または「個別削除」を選んでください。',
    ].join('\n');
}

function buildStaleSelectionContent(kind, staleLines, page = 0, pageSize = 10) {
    const title = kind === 'forum'
        ? 'フォーラム通知設定の個別削除'
        : 'ロールメンション転載設定の個別削除';

    const start = page * pageSize;
    const pageLines = staleLines.slice(start, start + pageSize);
    const numberedLines = pageLines.map((line, index) => `${start + index + 1}. ${line}`);
    const totalPages = Math.max(1, Math.ceil(staleLines.length / pageSize));

    return [
        title,
        `ページ ${page + 1}/${totalPages}`,
        '',
        ...numberedLines,
        '',
        '削除したい番号のボタンを押してください。',
    ].join('\n');
}

module.exports = {
    buildCleanupChoiceButtons,
    buildCleanupEntryButtons,
    buildStaleSummaryContent,
    buildStaleSelectionContent,
};
