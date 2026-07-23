const {
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const APP_ID = process.env.APP_ID;

if (!TOKEN || !APP_ID) {
    console.error('TOKEN または APP_ID が設定されていません');
    process.exit(1);
}

const textOrThreadTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

const forwardSourceChannelTypes = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
];

const commands = [
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('このBotの使い方マニュアルを表示します')
        .toJSON(),

    new SlashCommandBuilder()
        .setName('forum')
        .setDescription('フォーラム通知設定メニューを表示します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .toJSON(),

    new SlashCommandBuilder()
        .setName('forumlog')
        .setDescription('フォーラムログ出力メニューを表示します')
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageGuild,
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('reaction')
        .setDescription('自動リアクション設定メニューを表示します')
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageGuild,
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('role')
        .setDescription('ロール分析メニューを表示します')
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageGuild,
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('rolemention')
        .setDescription('ロールメンション転載設定メニューを表示します')
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageGuild,
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('forward')
        .setDescription('転送設定メニューを表示します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .toJSON(),

    new SlashCommandBuilder()
        .setName('pins')
        .setDescription('ピン留め一覧メニューを表示します')
        .toJSON(),

    new SlashCommandBuilder()
        .setName('hasrole')
        .setDescription('ロール所持者確認メニューを表示します')
        .toJSON(),

    new SlashCommandBuilder()
        .setName('joined')
        .setDescription('自分がこのサーバーに参加してからの日数を表示します')
        .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('グローバルコマンドとして登録中...');
        await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
        console.log('グローバルコマンド登録完了');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
