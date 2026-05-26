const {
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const APP_ID = process.env.APP_ID;
// 開発中は guild 登録の方が反映が速いので、必要なら使う
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !APP_ID) {
    console.error('TOKEN または APP_ID が設定されていません');
    process.exit(1);
}

const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('フォーラムと通知先チャンネルの対応を登録します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption((option) =>
            option
                .setName('forum')
                .setDescription('監視したいフォーラム')
                .addChannelTypes(ChannelType.GuildForum)
                .setRequired(true),
        )
        .addChannelOption((option) =>
            option
                .setName('log')
                .setDescription('通知を送るテキストチャンネル')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true),
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('showsetup')
        .setDescription('このサーバーの現在の設定一覧を表示します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .toJSON(),

    new SlashCommandBuilder()
        .setName('unset')
        .setDescription('フォーラムの設定を削除します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption((option) =>
            option
                .setName('forum')
                .setDescription('設定を削除したいフォーラム')
                .addChannelTypes(ChannelType.GuildForum)
                .setRequired(true),
        )
        .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        if (GUILD_ID) {
            console.log('ギルドコマンドとして登録中...');
            await rest.put(
                Routes.applicationGuildCommands(APP_ID, GUILD_ID),
                { body: commands },
            );
            console.log('ギルドコマンド登録完了');
        } else {
            console.log('グローバルコマンドとして登録中...');
            await rest.put(
                Routes.applicationCommands(APP_ID),
                { body: commands },
            );
            console.log('グローバルコマンド登録完了');
        }
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();