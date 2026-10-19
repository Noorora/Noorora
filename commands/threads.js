const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder,
} = require('discord.js');

const {
    ephemeralOptions,
} = require('../utils/ephemeral');

const {
    splitLinesToMessages,
} = require('../utils/messageSplit');

const ALL_TAGS_VALUE = '__all_tags__';
const NO_TAG_VALUE = '__no_tag__';

function buildThreadsMenuContent() {
    return [
        '## スレッド参加状況検索',
        '',
        '検索方法を選んでください。',
        '',
        '🔍 **自分を検索**',
        '自分が参加中・未参加のスレッドを調べます。',
        '',
        '👤 **ユーザーを指定**',
        '指定したユーザーが参加中・未参加のスレッドを調べます。',
        '',
        '📖 **説明**',
        '検索対象と注意事項を表示します。',
    ].join('\n');
}

function buildThreadsMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('threads_search_self')
                .setLabel('自分を検索')
                .setEmoji('🔍')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('threads_search_user')
                .setLabel('ユーザーを指定')
                .setEmoji('👤')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('threads_help')
                .setLabel('説明')
                .setEmoji('📖')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildHelpContent() {
    return [
        '## スレッド参加状況検索について',
        '',
        '1. 検索するユーザーを決めます。',
        '2. 対象フォーラムを選びます。',
        '3. 対象タグを選びます。',
        '4. 参加中・未参加のスレッドを一覧表示します。',
        '',
        '### 「参加中」の意味',
        'Discord上で、対象ユーザーがスレッドメンバーとして登録されている状態です。',
        '',
        '### タグ検索',
        '「すべてのタグ」「タグなし」、またはフォーラム内の個別タグを選択できます。',
        '',
        '### 注意',
        '・Botが閲覧できないスレッドは表示できません。',
        '・削除済みタグなど、フォーラム側で名前を取得できないタグはIDで表示します。',
        '・Discordクライアント上の通知レベルそのものを取得する機能ではありません。',
    ].join('\n');
}

function buildUserSelectComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId('threads_select_user')
                .setPlaceholder('検索するユーザーを選択してください')
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildForumSelectComponents(userId) {
    const forumTypes = [
        ChannelType.GuildForum,
    ];

    if (
        typeof ChannelType.GuildMedia !==
        'undefined'
    ) {
        forumTypes.push(
            ChannelType.GuildMedia,
        );
    }

    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(
                    `threads_select_forum:${userId}`,
                )
                .setPlaceholder('検索するフォーラムを選択してください')
                .setChannelTypes(...forumTypes)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildTagSelectComponents(
    userId,
    forum_channel,
) {
    const tagOptions = [
        {
            label: 'すべてのタグ',
            description: 'タグを指定せず、フォーラム内の全スレッドを検索します',
            value: ALL_TAGS_VALUE,
            emoji: '📚',
        },
        {
            label: 'タグなし',
            description: 'タグが1つも付いていないスレッドだけを検索します',
            value: NO_TAG_VALUE,
            emoji: '🏷️',
        },
    ];

    for (
        const tag of
        forum_channel.availableTags || []
    ) {
        if (tagOptions.length >= 25) {
            break;
        }

        const option = {
            label: tag.name.slice(0, 100),
            value: tag.id,
        };

        if (tag.moderated) {
            option.description =
                'モデレーター専用タグ';
        }

        if (tag.emoji) {
            option.emoji = tag.emoji.id
                ? {
                    id: tag.emoji.id,
                    name: tag.emoji.name || undefined,
                }
                : tag.emoji.name;
        }

        tagOptions.push(option);
    }

    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(
                    `threads_select_tag:${userId}:${forum_channel.id}`,
                )
                .setPlaceholder('検索するタグを選択してください')
                .addOptions(tagOptions)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildThreadUrl(thread) {
    return (
        `https://discord.com/channels/` +
        `${thread.guildId}/${thread.id}`
    );
}

function getThreadTimestamp(thread) {
    return (
        thread.archiveTimestamp ||
        thread.createdTimestamp ||
        0
    );
}

function sortThreadsNewestFirst(threads) {
    return [...threads].sort((left, right) => {
        return (
            getThreadTimestamp(right) -
            getThreadTimestamp(left)
        );
    });
}

function getTagName(
    forum_channel,
    tagId,
) {
    const tag = forum_channel.availableTags
        ?.find((item) => item.id === tagId);

    return tag?.name || `不明なタグ (${tagId})`;
}

function getThreadTagNames(
    forum_channel,
    thread,
) {
    const appliedTags =
        thread.appliedTags || [];

    if (appliedTags.length === 0) {
        return 'タグなし';
    }

    return appliedTags
        .map((tagId) => {
            return getTagName(
                forum_channel,
                tagId,
            );
        })
        .join('、');
}

function threadMatchesTag(
    thread,
    selectedTagId,
) {
    const appliedTags =
        thread.appliedTags || [];

    if (
        selectedTagId ===
        ALL_TAGS_VALUE
    ) {
        return true;
    }

    if (
        selectedTagId ===
        NO_TAG_VALUE
    ) {
        return appliedTags.length === 0;
    }

    return appliedTags.includes(
        selectedTagId,
    );
}

function getSelectedTagLabel(
    forum_channel,
    selectedTagId,
) {
    if (
        selectedTagId ===
        ALL_TAGS_VALUE
    ) {
        return 'すべてのタグ';
    }

    if (
        selectedTagId ===
        NO_TAG_VALUE
    ) {
        return 'タグなし';
    }

    return getTagName(
        forum_channel,
        selectedTagId,
    );
}

async function fetchArchivedForumThreads(
    forum_channel,
) {
    const threads = new Map();
    let before;

    while (true) {
        const options = {
            type: 'public',
            limit: 100,
        };

        if (before) {
            options.before = before;
        }

        const result =
            await forum_channel.threads
                .fetchArchived(options)
                .catch((error) => {
                    console.error(
                        '[threads] ' +
                        'アーカイブ済みスレッド取得エラー:',
                        error,
                    );

                    return null;
                });

        if (
            !result ||
            result.threads.size === 0
        ) {
            break;
        }

        for (
            const thread of
            result.threads.values()
        ) {
            threads.set(
                thread.id,
                thread,
            );
        }

        const oldestThread = [
            ...result.threads.values(),
        ].sort((left, right) => {
            return (
                (left.archiveTimestamp || 0) -
                (right.archiveTimestamp || 0)
            );
        })[0];

        if (
            !oldestThread ||
            result.threads.size < 100 ||
            result.hasMore === false
        ) {
            break;
        }

        before = oldestThread.archiveTimestamp
            ? new Date(
                oldestThread.archiveTimestamp,
            )
            : oldestThread.id;
    }

    return threads;
}

async function collectForumThreads(
    forum_channel,
    selectedTagId,
) {
    const threads = new Map();

    const activeResult =
        await forum_channel.threads
            .fetchActive()
            .catch((error) => {
                console.error(
                    '[threads] ' +
                    'アクティブスレッド取得エラー:',
                    error,
                );

                return null;
            });

    if (activeResult?.threads) {
        for (
            const thread of
            activeResult.threads.values()
        ) {
            threads.set(
                thread.id,
                thread,
            );
        }
    }

    const archivedThreads =
        await fetchArchivedForumThreads(
            forum_channel,
        );

    for (
        const thread of
        archivedThreads.values()
    ) {
        threads.set(
            thread.id,
            thread,
        );
    }

    return sortThreadsNewestFirst(
        [...threads.values()].filter(
            (thread) => {
                return threadMatchesTag(
                    thread,
                    selectedTagId,
                );
            },
        ),
    );
}

async function getThreadMembershipState(
    thread,
    userId,
) {
    if (
        thread.members.cache.has(userId)
    ) {
        return 'joined';
    }

    try {
        const result =
            await thread.members.fetch({
                member: userId,
                force: true,
            });

        return result
            ? 'joined'
            : 'not_joined';
    } catch (error) {
        const errorCode =
            error?.code ||
            error?.rawError?.code;

        /*
         * Discordの「Unknown Member」は、
         * 対象ユーザーがそのスレッドの
         * メンバーではない場合に返される。
         */
        if (
            errorCode === 10007 ||
            error?.status === 404
        ) {
            return 'not_joined';
        }

        console.error(
            '[threads] ' +
            'スレッド参加状態取得エラー:',
            {
                threadId: thread.id,
                userId,
                error,
            },
        );

        return 'unknown';
    }
}

async function classifyThreads(
    threads,
    userId,
) {
    const result = {
        joined: [],
        notJoined: [],
        unknown: [],
    };

    for (const thread of threads) {
        const state =
            await getThreadMembershipState(
                thread,
                userId,
            );

        if (state === 'joined') {
            result.joined.push(thread);
        } else if (
            state === 'not_joined'
        ) {
            result.notJoined.push(thread);
        } else {
            result.unknown.push(thread);
        }
    }

    return result;
}

function buildThreadLines(
    forum_channel,
    threads,
) {
    const lines = [];

    threads.forEach((thread, index) => {
        lines.push(
            `${index + 1}. **${thread.name}**`,
            `   タグ: ${getThreadTagNames(forum_channel, thread)}`,
            `   状態: ${thread.archived ? 'アーカイブ済み' : 'アクティブ'}`,
            `   リンク: ${buildThreadUrl(thread)}`,
            '',
        );
    });

    return lines;
}

function buildResultLines(
    targetUser,
    forum_channel,
    selectedTagId,
    result,
) {
    const selectedTagLabel =
        getSelectedTagLabel(
            forum_channel,
            selectedTagId,
        );

    const lines = [
        '# スレッド参加状況検索結果',
        '',
        `対象ユーザー: <@${targetUser.id}>`,
        `対象フォーラム: <#${forum_channel.id}>`,
        `対象タグ: **${selectedTagLabel}**`,
        '',
        `## 参加中のスレッド (${result.joined.length}件)`,
        '',
    ];

    if (result.joined.length === 0) {
        lines.push(
            '該当するスレッドはありません。',
            '',
        );
    } else {
        lines.push(
            ...buildThreadLines(
                forum_channel,
                result.joined,
            ),
        );
    }

    lines.push(
        `## 未参加のスレッド (${result.notJoined.length}件)`,
        '',
    );

    if (result.notJoined.length === 0) {
        lines.push(
            '該当するスレッドはありません。',
            '',
        );
    } else {
        lines.push(
            ...buildThreadLines(
                forum_channel,
                result.notJoined,
            ),
        );
    }

    if (result.unknown.length > 0) {
        lines.push(
            `## 判定できなかったスレッド (${result.unknown.length}件)`,
            '',
            ...buildThreadLines(
                forum_channel,
                result.unknown,
            ),
        );
    }

    lines.push(
        '※ 「参加中」は、対象ユーザーがスレッドメンバーとして登録されている状態です。',
    );

    return lines;
}

async function sendThreadSearchResult(
    interaction,
    userId,
    forumId,
    selectedTagId,
) {
    const forum_channel =
        await interaction.guild.channels
            .fetch(forumId)
            .catch(() => null);

    if (
        !forum_channel ||
        (
            forum_channel.type !==
            ChannelType.GuildForum &&
            forum_channel.type !==
            ChannelType.GuildMedia
        )
    ) {
        await interaction.editReply({
            content:
                '対象フォーラムが見つからないか、フォーラムではありません。',
            components: [],
        });

        return;
    }

    const targetUser =
        await interaction.client.users
            .fetch(userId)
            .catch(() => null);

    if (!targetUser) {
        await interaction.editReply({
            content:
                '対象ユーザーが見つかりませんでした。',
            components: [],
        });

        return;
    }

    const threads =
        await collectForumThreads(
            forum_channel,
            selectedTagId,
        );

    const result =
        await classifyThreads(
            threads,
            userId,
        );

    const chunks = splitLinesToMessages(
        '',
        buildResultLines(
            targetUser,
            forum_channel,
            selectedTagId,
            result,
        ),
    );

    await interaction.editReply({
        content: chunks[0],
        components: [],
    });

    for (
        let index = 1;
        index < chunks.length;
        index++
    ) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[index],
            }),
        );
    }
}

async function execute(interaction) {
    await interaction.reply(
        ephemeralOptions({
            content:
                buildThreadsMenuContent(),
            components:
                buildThreadsMenuComponents(),
        }),
    );
}

async function handleComponent(
    interaction,
) {
    const customId =
        interaction.customId || '';

    if (!customId.startsWith('threads_')) {
        return false;
    }

    if (interaction.isButton()) {
        if (
            customId ===
            'threads_search_self'
        ) {
            await interaction.update({
                content:
                    `対象ユーザー: <@${interaction.user.id}>\n` +
                    '検索するフォーラムを選択してください。',
                components:
                    buildForumSelectComponents(
                        interaction.user.id,
                    ),
            });

            return true;
        }

        if (
            customId ===
            'threads_search_user'
        ) {
            await interaction.update({
                content:
                    '検索するユーザーを選択してください。',
                components:
                    buildUserSelectComponents(),
            });

            return true;
        }

        if (customId === 'threads_help') {
            await interaction.update({
                content: buildHelpContent(),
                components:
                    buildThreadsMenuComponents(),
            });

            return true;
        }

        return false;
    }

    if (interaction.isUserSelectMenu()) {
        if (
            customId ===
            'threads_select_user'
        ) {
            const userId =
                interaction.values[0];

            await interaction.update({
                content:
                    `対象ユーザー: <@${userId}>\n` +
                    '検索するフォーラムを選択してください。',
                components:
                    buildForumSelectComponents(
                        userId,
                    ),
            });

            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (
            customId.startsWith(
                'threads_select_forum:',
            )
        ) {
            const userId =
                customId.split(':')[1];

            const forumId =
                interaction.values[0];

            const forum_channel =
                await interaction.guild.channels
                    .fetch(forumId)
                    .catch(() => null);

            if (!forum_channel) {
                await interaction.update({
                    content:
                        '選択したフォーラムを取得できませんでした。',
                    components: [],
                });

                return true;
            }

            await interaction.update({
                content:
                    `対象ユーザー: <@${userId}>\n` +
                    `対象フォーラム: <#${forumId}>\n` +
                    '検索するタグを選択してください。',
                components:
                    buildTagSelectComponents(
                        userId,
                        forum_channel,
                    ),
            });

            return true;
        }

        return false;
    }

    if (interaction.isStringSelectMenu()) {
        if (
            customId.startsWith(
                'threads_select_tag:',
            )
        ) {
            const [
                ,
                userId,
                forumId,
            ] = customId.split(':');

            const selectedTagId =
                interaction.values[0];

            await interaction.update({
                content:
                    'スレッド参加状況を検索しています。',
                components: [],
            });

            try {
                await sendThreadSearchResult(
                    interaction,
                    userId,
                    forumId,
                    selectedTagId,
                );
            } catch (error) {
                console.error(
                    'スレッド参加状況検索エラー:',
                    error,
                );

                await interaction.editReply({
                    content:
                        'スレッド参加状況の検索に失敗しました。Botの権限と起動ログを確認してください。',
                    components: [],
                });
            }

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'threads',
    execute,
    handleComponent,
};
