const ROLE_MENTION_PLACEHOLDER_LINES = [
    '・`{author}` → 送信者メンション',
    '・`{roles}` → メンションされたロール一覧',
    '・`{channel}` → 元チャンネルメンション',
    '・`{link}` → 元メッセージリンク',
    '・`{body}` → 本文そのまま',
    '・`{body_quote}` → 引用形式の本文',
];

const DEFAULT_ROLE_MENTION_MESSAGE_TEMPLATE =
    '送信主：{author}\\n' +
    '{body_quote}\\n' +
    '{link}';

function renderRoleMentionMessage(template, data) {
    return template
        .replaceAll('\\r\\n', '\n')
        .replaceAll('\\n', '\n')
        .replaceAll('{author}', data.authorMention)
        .replaceAll('{roles}', data.roleMentions)
        .replaceAll('{channel}', data.channelMention)
        .replaceAll('{link}', data.messageLink)
        .replaceAll('{body}', data.body)
        .replaceAll('{body_quote}', data.bodyQuote);
}

function buildRoleMentionPlaceholdersHelp() {
    return [
        '## ロールメンション転載で使えるプレースホルダ一覧',
        ...ROLE_MENTION_PLACEHOLDER_LINES,
        '',
        '## 改行の書き方',
        '改行したい場合は `\\n` を使ってください。',
        '',
        '## 例',
        '```txt',
        DEFAULT_ROLE_MENTION_MESSAGE_TEMPLATE.replaceAll('\\n', '\n'),
        '```',
    ].join('\n');
}

module.exports = {
    ROLE_MENTION_PLACEHOLDER_LINES,
    DEFAULT_ROLE_MENTION_MESSAGE_TEMPLATE,
    renderRoleMentionMessage,
    buildRoleMentionPlaceholdersHelp,
};
