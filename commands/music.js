const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

function isMusicEnabled() {
    return (
        process.env.MUSIC_ENABLED ===
        'true'
    );
}

async function canUseMusic(
    kv,
    guildId,
) {
    /*
     * 従来のPC版AutoDetectorが有効なら使用可能。
     */
    if (isMusicEnabled()) {
        return true;
    }

    /*
     * または、このGuildに
     * Desktop Music Workerがいれば使用可能。
     */
    const worker =
        await findAvailableMusicWorker(
            kv,
            guildId,
        );

    return Boolean(worker);
}

const { ephemeralOptions } = require('../utils/ephemeral');
const { addAuditLog } = require('../utils/auditLog');
const { getMusicPlayer } = require('../services/musicPlayer');

const {
    findAvailableMusicWorker,
    setMusicWorkerStatus,
} = require('../services/musicWorkerService');

const {
    createMusicJob,
} = require('../services/musicJobService');

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
        return 0.45;
    }

    return Math.min(
        2,
        Math.max(
            0.05,
            value,
        ),
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
        'ニコニコ動画またはYouTubeのURLを入力して、音声を再生またはキューに追加します。',
        '',
        '⏭️ **スキップ**',
        '現在再生中の曲をスキップします。',
        '',
        '⏹️ **停止**',
        '再生を停止し、キューを空にしてVCから退出します。',
        '',
        '📋 **キュー**',
        '現在再生中の曲と待機中の曲を表示します。',
        '',
        '🔊 **音量設定**',
        'このサーバーでのMusicデフォルト音量を設定します。',
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
                    .setLabel(`音量 5〜200 を入力。現在: ${formatVolumePercent(currentVolume)}`)
                    .setPlaceholder('例: 45 / 80 / 100 / 150')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

async function execute(
    interaction,
    context,
) {
    const { kv } =
        context;

    const musicAvailable =
        await canUseMusic(
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
            content:
                await buildMusicMenuContent(
                    kv,
                    interaction.guildId,
                ),

            components:
                buildMusicMenuComponents(),
        }),
    );
}

async function handleComponent(
    interaction,
    context,
) {
    const customId =
        interaction.customId || '';

    if (
        !customId.startsWith(
            'music_',
        )
    ) {
        return false;
    }

    /*
     * 先にRedis Clientを取得する。
     */
    const { kv } =
        context;

    /*
     * 従来PC版、
     * またはDesktop Music Workerの
     * どちらかが利用可能ならMusicを使える。
     */
    const musicAvailable =
        await canUseMusic(
            kv,
            interaction.guildId,
        );

    if (!musicAvailable) {
        const options =
            ephemeralOptions({
                content:
                    '現在、利用可能なMusic Workerがありません。\n' +
                    '従来のPC版AutoDetector、または' +
                    'AutoDetector DesktopのMusic Workerを起動してください。',
            });

        if (
            interaction.deferred ||
            interaction.replied
        ) {
            await interaction.followUp(
                options,
            );
        } else {
            await interaction.reply(
                options,
            );
        }

        return true;
    }

    /*
     * ボタン操作
     */
    if (interaction.isButton()) {
        if (
            interaction.customId ===
            'music_menu_play'
        ) {
            await interaction.showModal(
                buildMusicPlayModal(),
            );

            return true;
        }

        if (
            interaction.customId ===
            'music_menu_skip'
        ) {
            const player =
                getMusicPlayer(
                    interaction.guildId,
                );

            const result =
                player.skip();

            if (result.ok) {
                await addAuditLog(
                    interaction,
                    kv,
                    'Music スキップ',
                    result.message,
                ).catch(
                    () => null,
                );
            }

            await interaction.reply(
                ephemeralOptions({
                    content:
                        result.message,
                }),
            );

            return true;
        }

        if (
            interaction.customId ===
            'music_menu_stop'
        ) {
            const player =
                getMusicPlayer(
                    interaction.guildId,
                );

            const result =
                player.stop();

            if (result.ok) {
                await addAuditLog(
                    interaction,
                    kv,
                    'Music 停止',
                    result.message,
                ).catch(
                    () => null,
                );
            }

            await interaction.reply(
                ephemeralOptions({
                    content:
                        result.message,
                }),
            );

            return true;
        }

        if (
            interaction.customId ===
            'music_menu_queue'
        ) {
            const player =
                getMusicPlayer(
                    interaction.guildId,
                );

            await interaction.reply(
                ephemeralOptions({
                    content:
                        player.getQueueText(),
                }),
            );

            return true;
        }

        if (
            interaction.customId ===
            'music_menu_volume'
        ) {
            const currentVolume =
                await getDefaultVolume(
                    kv,
                    interaction.guildId,
                );

            await interaction.showModal(
                buildMusicVolumeModal(
                    currentVolume,
                ),
            );

            return true;
        }

        return false;
    }

    /*
     * Modal処理
     */
    if (interaction.isModalSubmit()) {
        /*
         * 再生URL
         */
        if (
            interaction.customId ===
            'music_play_modal'
        ) {
            const url =
                interaction.fields
                    .getTextInputValue(
                        'url',
                    )
                    .trim();

            await interaction.deferReply(
                ephemeralOptions(),
            );

            /*
             * コマンド実行者が現在いるVC。
             */
            const member =
                await interaction.guild.members
                    .fetch(
                        interaction.user.id,
                    )
                    .catch(
                        () =>
                            interaction.member ??
                            null,
                    );

            const voiceChannel =
                member?.voice?.channel;

            if (!voiceChannel) {
                await interaction.editReply({
                    content:
                        '先にボイスチャンネルに参加してください。',
                });

                return true;
            }

            /*
             * このGuildで利用できる
             * idle Music Workerを取得。
             */
            const worker =
                await findAvailableMusicWorker(
                    kv,
                    interaction.guildId,
                );

            if (!worker) {
                await interaction.editReply({
                    content:
                        '現在、このサーバーで利用可能なMusic Workerがありません。\n' +
                        'AutoDetector Desktopを起動して、' +
                        'このサーバーのMusic Workerを開始してください。',
                });

                return true;
            }

            const volume =
                await getDefaultVolume(
                    kv,
                    interaction.guildId,
                );

            /*
             * Renderでは音源取得しない。
             *
             * Desktop Workerへ渡すJobだけ作成。
             */
            const job =
                await createMusicJob(
                    kv,
                    {
                        workerId:
                            worker.workerId,

                        guildId:
                            interaction.guildId,

                        voiceChannelId:
                            voiceChannel.id,

                        textChannelId:
                            interaction.channelId,

                        requestedById:
                            interaction.user.id,

                        url,

                        volume,

                        type:
                            'play',
                    },
                );

            /*
             * 同じWorkerを別の再生へ
             * 同時割当しないためbusyにする。
             */
            await setMusicWorkerStatus(
                kv,
                worker.workerId,
                'busy',
            );

            await addAuditLog(
                interaction,
                kv,
                'Music Worker再生要求',
                `URL: ${url} / ` +
                `Worker: ${worker.name} / ` +
                `VC: ${voiceChannel.id} / ` +
                `音量: ${formatVolumePercent(volume)} / ` +
                `Job: ${job.jobId}`,
            ).catch(
                () => null,
            );

            await interaction.editReply({
                content:
                    '🎵 Music Workerへ再生要求を送信しました。\n' +
                    `VC: <#${voiceChannel.id}>\n` +
                    `Worker: ${worker.name}\n` +
                    `URL: ${url}`,
            });

            return true;
        }

        /*
         * 音量設定
         */
        if (
            interaction.customId ===
            'music_volume_modal'
        ) {
            const raw =
                interaction.fields
                    .getTextInputValue(
                        'volume_percent',
                    )
                    .trim();

            const percent =
                Number(raw);

            if (
                !Number.isFinite(
                    percent,
                ) ||
                percent < 5 ||
                percent > 200
            ) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            '音量は 5〜200 の数字で入力してください。' +
                            '例: 20 / 45 / 80 / 100',
                    }),
                );

                return true;
            }

            const volume =
                percent / 100;

            await setDefaultVolume(
                kv,
                interaction.guildId,
                volume,
            );

            /*
             * 従来PC版Music Playerが動いている場合にも
             * これまでどおり反映。
             */
            const player =
                getMusicPlayer(
                    interaction.guildId,
                );

            player.setVolume(
                volume,
            );

            await addAuditLog(
                interaction,
                kv,
                'Music 音量設定',
                `Music のデフォルト音量を ${percent}% に設定しました。`,
            ).catch(
                () => null,
            );

            await interaction.reply(
                ephemeralOptions({
                    content:
                        `Music のデフォルト音量を **${percent}%** に設定しました。\n` +
                        '次回のDesktop Worker再生にも反映されます。',
                }),
            );

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'music',
    execute,
    handleComponent,
};