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

function buildMusicMenuContent() {
    return [
        '## 🎵 Music',
        '',
        '操作を選んでください。',
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

async function execute(interaction, context) {
    await interaction.reply(
        ephemeralOptions({
            content: buildMusicMenuContent(),
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

            const player = getMusicPlayer(interaction.guildId);

            const result = await player.enqueue(
                interaction,
                url,
            );

            if (result.ok) {
                await addAuditLog(
                    interaction,
                    kv,
                    'Music 再生追加',
                    `URL: ${url}`,
                ).catch(() => null);
            }

            await interaction.editReply({
                content: result.message,
            });

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