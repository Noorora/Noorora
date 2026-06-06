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

const commands = [
    // =========================================================
    // /forum
    // =========================================================
    new SlashCommandBuilder()
        .setName('forum')
        .setDescription('フォーラム通知設定を管理します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addSubcommand((subcommand) =>
            subcommand
                .setName('channel')
                .setDescription('通知先をテキストチャンネルに設定します')
                .addChannelOption((option) =>
                    option
                        .setName('forum')
                        .setDescription('監視したいフォーラム')
                        .addChannelTypes(ChannelType.GuildForum)
                        .setRequired(true),
                )
                .addChannelOption((option) =>
                    option
                        .setName('log_channel')
                        .setDescription('通知先のテキストチャンネル')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('message')
                        .setDescription('通知メッセージのテンプレート（省略時はデフォルト）')
                        .setRequired(false),
                ),
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName('thread')
                .setDescription('通知先を既存スレッドに設定します')
                .addChannelOption((option) =>
                    option
                        .setName('forum')
                        .setDescription('監視したいフォーラム')
                        .addChannelTypes(ChannelType.GuildForum)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('thread_id')
                        .setDescription('通知先の既存スレッドID')
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('message')
                        .setDescription('通知メッセージのテンプレート（省略時はデフォルト）')
                        .setRequired(false),
                ),
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName('show')
                .setDescription('現在のフォーラム通知設定一覧を表示します'),
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName('unset')
                .setDescription('フォーラム通知設定を削除します')
                .addChannelOption((option) =>
                    option
                        .setName('forum')
                        .setDescription('設定を削除したいフォーラム')
                        .addChannelTypes(ChannelType.GuildForum)
                        .setRequired(true),
                ),
        )
        .toJSON(),

    // =========================================================
    // /role
    // =========================================================
    new SlashCommandBuilder()
        .setName('role')
        .setDescription('ロール条件でメンバー一覧を表示します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addSubcommandGroup((group) =>
            group
                .setName('missing')
                .setDescription('指定したロールを持っていないメンバーを表示します')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('list')
                        .setDescription('指定したロールを持っていないメンバー一覧を表示します')
                        .addRoleOption((option) =>
                            option
                                .setName('role')
                                .setDescription('持っていないか確認したいロール')
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('mention')
                        .setDescription('指定したロールを持っていないメンバーのコピペ用メンションを表示します')
                        .addRoleOption((option) =>
                            option
                                .setName('role')
                                .setDescription('持っていないか確認したいロール')
                                .setRequired(true),
                        ),
                ),
        )

        .addSubcommandGroup((group) =>
            group
                .setName('channelnever')
                .setDescription('指定したロールを持っておらず、指定したチャンネルで一度も発言していないメンバーを表示します')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('list')
                        .setDescription('一覧表示します')
                        .addRoleOption((option) =>
                            option
                                .setName('role')
                                .setDescription('持っていないか確認したいロール')
                                .setRequired(true),
                        )
                        .addChannelOption((option) =>
                            option
                                .setName('channel')
                                .setDescription('確認したい通常テキストチャンネル')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('mention')
                        .setDescription('コピペ用メンションを表示します')
                        .addRoleOption((option) =>
                            option
                                .setName('role')
                                .setDescription('持っていないか確認したいロール')
                                .setRequired(true),
                        )
                        .addChannelOption((option) =>
                            option
                                .setName('channel')
                                .setDescription('確認したい通常テキストチャンネル')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true),
                        ),
                ),
        )

        .addSubcommandGroup((group) =>
            group
                .setName('filter')
                .setDescription('特定ロールを持ち、別の特定ロールを持っていないメンバーを表示します')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('list')
                        .setDescription('一覧表示します')
                        .addRoleOption((option) =>
                            option
                                .setName('has')
                                .setDescription('持っている必要があるロール')
                                .setRequired(true),
                        )
                        .addRoleOption((option) =>
                            option
                                .setName('not')
                                .setDescription('持っていてはいけないロール')
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('mention')
                        .setDescription('コピペ用メンションを表示します')
                        .addRoleOption((option) =>
                            option
                                .setName('has')
                                .setDescription('持っている必要があるロール')
                                .setRequired(true),
                        )
                        .addRoleOption((option) =>
                            option
                                .setName('not')
                                .setDescription('持っていてはいけないロール')
                                .setRequired(true),
                        ),
                ),
        )
        .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('グローバルコマンドとして登録中...');
        await rest.put(
            Routes.applicationCommands(APP_ID),
            { body: commands },
        );
        console.log('グローバルコマンド登録完了');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();