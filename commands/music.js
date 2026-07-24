const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { addAuditLog } = require('../utils/auditLog');
const { getMusicPlayer } = require('../services/musicPlayer');

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
        'ニコニコ動画のURLを入力して音声を再生またはキューに追加します。',
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
        '',
        '注意:',
        '権利的に問題のない動画だけを再生してください。',
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
                    .setLabel('ニコニコ動画URL')
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

async function execute(interaction, context) {
    const { kv } = context;

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

async function handleComponent(interaction, context) {
    const { kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'music_menu_play') {
            await interaction.showModal(
                buildMusicPlayModal(),
            );

            return true;
        }

        if (interaction.customId === 'music_menu_skip') {
            const player = getMusicPlayer(interaction.guildId);
            const result = player.skip();

            if (result.ok) {
                await addAuditLog(
                    interaction,
                    kv,
                    'Music スキップ',
                    result.message,
                ).catch(() => null);
            }

            await interaction.reply(
                ephemeralOptions({
                    content: result.message,
                }),
            );

            return true;
        }

        if (interaction.customId === 'music_menu_stop') {
            const player = getMusicPlayer(interaction.guildId);
            const result = player.stop();

            if (result.ok) {
                await addAuditLog(
                    interaction,
                    kv,
                    'Music 停止',
                    result.message,
                ).catch(() => null);
            }

            await interaction.reply(
                ephemeralOptions({
                    content: result.message,
                }),
            );

            return true;
        }

        if (interaction.customId === 'music_menu_queue') {
            const player = getMusicPlayer(interaction.guildId);

            await interaction.reply(
                ephemeralOptions({
                    content: player.getQueueText(),
                }),
            );

            return true;
        }

        if (interaction.customId === 'music_menu_volume') {
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
        if (interaction.customId === 'music_play_modal') {
            const url = interaction.fields
                .getTextInputValue('url')
                .trim();

            await interaction.deferReply(
                ephemeralOptions(),
            );

            const volume = await getDefaultVolume(
                kv,
                interaction.guildId,
            );

            const player = getMusicPlayer(interaction.guildId);

            const result = await player.enqueue(
                interaction,
                url,
                volume,
            );

            if (result.ok) {
                await addAuditLog(
                    interaction,
                    kv,
                    'Music 再生追加',
                    `URL: ${url} / 音量: ${formatVolumePercent(volume)}`,
                ).catch(() => null);
            }

            await interaction.editReply({
                content: result.message,
            });

            return true;
        }

        if (interaction.customId === 'music_volume_modal') {
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
                        content: '音量は 5〜200 の数字で入力してください。例: 45 / 80 / 100 / 150',
                    }),
                );

                return true;
            }

            const volume = percent / 100;

            await setDefaultVolume(
                kv,
                interaction.guildId,
                volume,
            );

            const player = getMusicPlayer(interaction.guildId);

            player.setVolume(volume);

            await addAuditLog(
                interaction,
                kv,
                'Music 音量設定',
                `Music のデフォルト音量を ${percent}% に設定しました。`,
            ).catch(() => null);

            await interaction.reply(
                ephemeralOptions({
                    content:
                        `Music のデフォルト音量を **${percent}%** に設定しました。\n` +
                        '現在再生中の曲がある場合は、その曲にも反映します。',
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