const FORUM_PLACEHOLDER_LINES = [
    '・`{forum}` → フォーラムメンション',
    '・`{forumName}` → フォーラム名',
    '・`{thread}` → スレッド名',
    '・`{author}` → スレ主メンション',
    '・`{newcomerMark}` → ご新規さんの場合だけ 🔰 を表示',
    '・`{link}` → スレッドURL',
];

const DEFAULT_FORUM_MESSAGE_TEMPLATE =
    '{forum} に、新しいスレッドが作成されました！\\n' +
    'スレ主: {author}{newcomerMark}\\n' +
    'スレタイ: {thread}\\n'+
    '[スレッドへ]({link})';

function renderForumMessage(template, data) {
    return template
        .replaceAll('\\r\\n', '\n')
        .replaceAll('\\n', '\n')
        .replaceAll('{forum}', data.forumMention)
        .replaceAll('{forumName}', data.forumName)
        .replaceAll('{thread}', data.threadName)
        .replaceAll('{author}', data.authorMention)
        .replaceAll('{newcomerMark}', data.newcomerMark)
        .replaceAll('{link}', data.threadLink);
}

function buildForumPlaceholdersHelp() {
    return [
        '## カスタムメッセージで使えるプレースホルダ一覧',
        ...FORUM_PLACEHOLDER_LINES,
        '',
        '## 改行の書き方',
        '改行したい場合は `\\n` を使ってください。',
        '',
        '## 例',
        '```txt',
        DEFAULT_FORUM_MESSAGE_TEMPLATE.replaceAll('\\n', '\n'),
        '```',
    ].join('\n');
}

module.exports = {
    FORUM_PLACEHOLDER_LINES,
    DEFAULT_FORUM_MESSAGE_TEMPLATE,
    renderForumMessage,
    buildForumPlaceholdersHelp,
};
