const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

const {
    ephemeralOptions,
} = require('../utils/ephemeral');

const {
    addAuditLog,
} = require('../utils/auditLog');

const {
    getOnlineMusicWorkers,
} = require('../services/musicWorkerService');

const {
    createMusicJob,
} = require('../services/musicJobService');

const {
    enqueueMusicTrack,
    getGuildMusicQueue,
    clearGuildMusicQueue,
} = require('../services/musicQueueService');

const allowedMusicHosts = new Set([
    'www.nicovideo.jp',
    'nico.ms',
    'sp.nicovideo.jp',
    'www.youtube.com',
    'youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
]);

function isAllowedMusicUrl(url) {
    if (!/^https?:\/\//i.test(url)) {
        return false;
    }

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname
            .toLowerCase()
            .replace(/\.$/, '');

        return allowedMusicHosts.has(hostname);
    } catch {
        return false;
    }
}

async function canUseMusic(kv, guildId) {
    const workers = await getOnlineMusicWorkers(
        kv,
        guildId,
    );

    return workers.length > 0;
}

function musicDefaultVolumeKey(guildId) {
    return `music-option:default-volume:${guildId}`;
}

function formatVolumePercent(volume) {
    return `${Math.round(volume * 100)}%`;
}

async function getDefaultVolume(kv, guildId) {
    const raw = await kv.get(
        musicDefaultVolumeKey(guildId),
    );

    const value = Number(raw);

    if (!Number.isFinite(value)) {
        return 0.2;
    }

    return Math.min(
        2,
        Math.max(0.05, value),
    );
}

async function setDefaultVolume(kv, guildId, volume) {
    await kv.set(
        musicDefaultVolumeKey(guildId),
        String(volume),
    );
}

async function buildMusicMenuContent(kv, guildId) {
    const volume = await getDefaultVolume(
        kv,
        guildId,
    );

    return [
        '## 🎵 Music',
        '',
        '操作を選んでください。',
        '',
        `現在のデフォルト音量: **${formatVolumePercent(volume)}**`,
        '',
        '▶️ **再生**',
        'URLを入力して、Render上のキューへ追加します。',
        '',
        '⏭️ **スキップ**',
        '現在曲を終了し、次の曲へ進みます。',
        '',
        '⏹️ **停止**',
        '現在曲を停止し、待機キューも空にします。',
        '',
        '📋 **キュー**',
        'Render上の現在曲と待機曲を表示します。',
        '',
        '🔊 **音量設定**',
        '次回追加する曲のデフォルト音量を設定します。',
    ].join('\n');
}

function buildMusicMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('music_menu_play')
                .setLabel('再生')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('music_menu_skip')
                .setLabel('スキップ')
                .setEmoji('⏭️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('music_menu_stop')
                .setLabel('停止')
                .setEmoji('⏹️')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('music_menu_queue')
                .setLabel('キュー')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('music_menu_volume')
                .setLabel('音量設定')
                .setEmoji('🔊')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildMusicPlayModal() {
    return new ModalBuilder()
        .setCustomId('music_play_modal')
        .setTitle('Music 再生')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('url')
                    .setLabel('動画URL')
                    .setPlaceholder('https://www.nicovideo.jp/watch/smxxxxxxxx')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function buildMusicVolumeModal(currentVolume) {
    return new ModalBuilder()
        .setCustomId('music_volume_modal')
        .setTitle('Music 音量設定')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('volume_percent')
                    .setLabel(
                        `音量 5〜200 を入力。現在: ${formatVolumePercent(currentVolume)}`,
                    )
                    .setPlaceholder('例: 20 / 45 / 80 / 100')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function formatTrackLine(track, index = null) {
    const prefix = index == null
        ? '・'
        : `${index}. `;

    const displayName = track.title || track.url;

    return [
        `${prefix}${displayName}`,
        `   リクエスト: <@${track.requestedById}>`,
    ];
}

async function execute(interaction, context) {
    const { kv } = context;
    const musicAvailable = await canUseMusic(
        kv,
        interaction.guildId,
    );

    if (!musicAvailable) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    '現在、利用可能なMusic Workerがありません。\n' +
                    'AutoDetector Desktopで、このサーバーのMusic Workerを起動してください。',
            }),
        );

        return;
    }

    await interaction.reply(
        ephemeralOptions({
            content: await buildMusicMenuContent(
                kv,
                interaction.guildId,
            ),
            components: buildMusicMenuComponents(),
        }),
    );
}

async function handleSkip(
    interaction,
    kv,
) {
    await interaction.deferReply({
        ephemeral: true,
    });

    const guildId = interaction.guildId;

    if (!guildId) {
        await interaction.editReply(
            'サーバー内で実行してください。',
        );
        return;
    }

    const queue =
        await getGuildMusicQueue(
            kv,
            guildId,
        );

    if (!queue.current) {
        await interaction.editReply(
            '現在再生中の曲はありません。',
        );
        return;
    }

    /*
     * current.workerIdだけを信用しない。
     *
     * Desktop再登録などでWorker IDが変わっている場合、
     * 古いWorker用Redis Listへskipを送ると
     * 現在のDesktopが永久に受信できない。
     */
    const workers =
        await getOnlineMusicWorkers(
            kv,
            guildId,
        );

    const worker =
        workers.find(
            (item) =>
                item.status === 'busy',
        ) ||
        workers.find(
            (item) =>
                item.workerId ===
                queue.current.workerId,
        ) ||
        workers[0] ||
        null;

    if (!worker) {
        console.warn(
            '[music-skip] online worker not found:',
            {
                guildId,
                currentWorkerId:
                    queue.current.workerId || null,
            },
        );

        await interaction.editReply(
            '再生を担当しているMusic Workerが見つかりません。',
        );
        return;
    }

    /*
     * 現在onlineになっているWorkerへskipを送る。
     */
    const controlJob =
        await createMusicJob(
            kv,
            {
                workerId:
                    worker.workerId,

                guildId,

                voiceChannelId:
                    queue.current.voiceChannelId ||
                    null,

                textChannelId:
                    queue.current.textChannelId ||
                    interaction.channelId ||
                    null,

                requestedById:
                    interaction.user.id,

                url: null,

                type: 'skip',
            },
        );

    console.log(
        '[music-skip] control job created:',
        {
            guildId,

            controlJobId:
                controlJob.jobId,

            targetWorkerId:
                worker.workerId,

            currentWorkerId:
                queue.current.workerId ||
                null,

            workerStatus:
                worker.status ||
                null,

            onlineWorkers:
                workers.map(
                    (item) => ({
                        workerId:
                            item.workerId,
                        status:
                            item.status,
                    }),
                ),
        },
    );

    await interaction.editReply(
        '⏭️ スキップします。',
    );
}

async function handleStop(
    interaction,
    kv,
) {
    await interaction.deferReply({
        flags:
            MessageFlags.Ephemeral,
    });

    /*
     * キューを消す前に、現在稼働中のWorkerを確定する。
     */
    const workers =
        await getOnlineMusicWorkers(
            kv,
            interaction.guildId,
        );

    const worker =
        workers.find(
            (item) =>
                item.status === 'busy',
        ) ||
        workers[0] ||
        null;

    const cleared =
        await clearGuildMusicQueue(
            kv,
            interaction.guildId,
        );

    if (
        !cleared.current &&
        cleared.queuedCount === 0
    ) {
        await interaction.editReply({
            content:
                '現在再生中の曲も待機中の曲もありません。',
        });

        return true;
    }

    /*
     * busy Workerが見つからない場合だけ、
     * clear前のcurrentに記録されたWorkerを使う。
     */
    const targetWorkerId =
        worker?.workerId ||
        cleared.current?.workerId ||
        null;

    if (
        cleared.current &&
        targetWorkerId
    ) {
        const stopJob =
            await createMusicJob(
                kv,
                {
                    workerId:
                        targetWorkerId,

                    guildId:
                        interaction.guildId,

                    voiceChannelId:
                        cleared.current.voiceChannelId,

                    textChannelId:
                        interaction.channelId,

                    requestedById:
                        interaction.user.id,

                    url:
                        null,

                    type:
                        'stop',
                },
            );

        console.log(
            '[music-stop] control job created:',
            {
                guildId:
                    interaction.guildId,

                workerId:
                    targetWorkerId,

                currentPlayJobId:
                    cleared.current.jobId,

                stopJobId:
                    stopJob.jobId,

                removedQueuedCount:
                    cleared.queuedCount,
            },
        );
    }

    await interaction.editReply({
        content:
            '⏹️ 再生を停止し、待機中の曲を ' +
            `${cleared.queuedCount} 件削除しました。`,
    });

    return true;
}


async function handleQueue(
    interaction,
    kv,
) {
    await interaction.deferReply({
        flags:
            MessageFlags.Ephemeral,
    });

    const queue =
        await getGuildMusicQueue(
            kv,
            interaction.guildId,
        );

    const lines = [
        '## 📋 Music キュー',
        '',
        '### 再生中',
    ];

    if (queue.current) {
        lines.push(
            ...formatTrackLine(
                queue.current,
            ),
        );
    } else {
        lines.push(
            '・なし',
        );
    }

    lines.push(
        '',
        '### 待機中',
    );

    if (
        queue.queued.length === 0
    ) {
        lines.push(
            '・なし',
        );
    } else {
        queue.queued
            .slice(0, 10)
            .forEach(
                (track, index) => {
                    lines.push(
                        ...formatTrackLine(
                            track,
                            index + 1,
                        ),
                    );
                },
            );

        if (
            queue.queued.length > 10
        ) {
            lines.push(
                '',
                `ほか ${queue.queued.length - 10} 件`,
            );
        }
    }

    await interaction.editReply({
        content:
            lines.join('\n'),
    });

    return true;
}

async function handleComponent(interaction, context) {
    const customId = interaction.customId || '';

    if (!customId.startsWith('music_')) {
        return false;
    }

    const { kv } = context;
    const musicAvailable = await canUseMusic(
        kv,
        interaction.guildId,
    );

    if (!musicAvailable) {
        const options = ephemeralOptions({
            content:
                '現在、利用可能なMusic Workerがありません。\n' +
                'AutoDetector Desktopで、このサーバーのMusic Workerを起動してください。',
        });

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(options);
        } else {
            await interaction.reply(options);
        }

        return true;
    }

    if (interaction.isButton()) {
        if (customId === 'music_menu_play') {
            await interaction.showModal(
                buildMusicPlayModal(),
            );
            return true;
        }

        if (customId === 'music_menu_skip') {
            return handleSkip(interaction, kv);
        }

        if (customId === 'music_menu_stop') {
            return handleStop(interaction, kv);
        }

        if (customId === 'music_menu_queue') {
            return handleQueue(interaction, kv);
        }

        if (customId === 'music_menu_volume') {
            const currentVolume = await getDefaultVolume(
                kv,
                interaction.guildId,
            );

            await interaction.showModal(
                buildMusicVolumeModal(currentVolume),
            );

            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (customId === 'music_play_modal') {
            const url = interaction.fields
                .getTextInputValue('url')
                .trim();

            await interaction.deferReply(
                ephemeralOptions(),
            );

            if (!isAllowedMusicUrl(url)) {
                await interaction.editReply({
                    content:
                        '対応しているURLではありません。\n' +
                        'ニコニコ動画、YouTube、YouTube MusicのURLを入力してください。',
                });
                return true;
            }

            const member = await interaction.guild.members
                .fetch(interaction.user.id)
                .catch(
                    () => interaction.member ?? null,
                );

            const voiceChannel = member?.voice?.channel;

            if (!voiceChannel) {
                await interaction.editReply({
                    content:
                        '先にボイスチャンネルに参加してください。',
                });
                return true;
            }

            const volume = await getDefaultVolume(
                kv,
                interaction.guildId,
            );

            let result;

            try {
                result = await enqueueMusicTrack(
                    kv,
                    {
                        guildId: interaction.guildId,
                        voiceChannelId: voiceChannel.id,
                        textChannelId: interaction.channelId,
                        requestedById: interaction.user.id,
                        url,
                        volume,
                    },
                );
            } catch (error) {
                if (error.message === 'music_queue_busy') {
                    await interaction.editReply({
                        content:
                            'キューを更新中です。数秒後にもう一度お試しください。',
                    });
                    return true;
                }
                throw error;
            }

            if (!result.ok) {
                const message =
                    result.reason === 'queue_full'
                        ? 'キューが100曲に達しています。'
                        : 'このサーバーで利用可能なMusic Workerがありません。';

                await interaction.editReply({
                    content: message,
                });
                return true;
            }

            await addAuditLog(
                interaction,
                kv,
                result.started
                    ? 'Music再生開始'
                    : 'Musicキュー追加',
                `URL: ${url} / ` +
                `Worker: ${result.worker.name} / ` +
                `VC: ${voiceChannel.id} / ` +
                `音量: ${formatVolumePercent(volume)}`,
            ).catch(() => null);

            await interaction.editReply({
                content: result.started
                    ? [
                        '🎵 再生要求を送信しました。',
                        `VC: <#${voiceChannel.id}>`,
                        `Worker: ${result.worker.name}`,
                        `URL: ${url}`,
                    ].join('\n')
                    : [
                        '📥 キューに追加しました。',
                        `待機位置: ${result.position}`,
                        `URL: ${url}`,
                    ].join('\n'),
            });

            return true;
        }

        if (customId === 'music_volume_modal') {
            const raw = interaction.fields
                .getTextInputValue('volume_percent')
                .trim();

            const percent = Number(raw);

            if (
                !Number.isFinite(percent) ||
                percent < 5 ||
                percent > 200
            ) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            '音量は 5〜200 の数字で入力してください。',
                    }),
                );
                return true;
            }

            await setDefaultVolume(
                kv,
                interaction.guildId,
                percent / 100,
            );

            await addAuditLog(
                interaction,
                kv,
                'Music 音量設定',
                `Music のデフォルト音量を ${percent}% に設定しました。`,
            ).catch(() => null);

            await interaction.reply(
                ephemeralOptions({
                    content:
                        `Music のデフォルト音量を **${percent}%** に設定しました。`,
                }),
            );

            return true;
        }
    }

    return false;
}

module.exports = {
    name: 'music',
    execute,
    handleComponent,
};
