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

const commands = [
    new SlashCommandBuilder()
        .setName('forum')
        .setDescription('フォーラム通知設定を管理します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('channel')
                .setDescription('通知先をチャンネルまたは既存スレッドに設定します')
                .addChannelOption((option) =>
                    option
                        .setName('target_channel')
                        .setDescription('通知先のチャンネルまたは既存スレッド')
                        .addChannelTypes(...textOrThreadTypes)
                        .setRequired(true),
                )
                .addChannelOption((option) =>
                    option
                        .setName('forum')
                        .setDescription('監視したいフォーラム（単体登録用）')
                        .addChannelTypes(ChannelType.GuildForum)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('forum_ids')
                        .setDescription('監視したいフォーラムIDをカンマ区切りで指定（一括登録用）')
                        .setRequired(false),
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
                .setName('placeholders')
                .setDescription('カスタムメッセージで使えるプレースホルダ一覧を表示します'),
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
                        .setDescription('対象フォーラム（省略可）')
                        .addChannelTypes(ChannelType.GuildForum)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName('target_channel')
                        .setDescription('対象通知先チャンネルまたはスレッド（省略可）')
                        .addChannelTypes(...textOrThreadTypes)
                        .setRequired(false),
                ),
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('reaction')
        .setDescription('特定チャンネル・特定ユーザーへの自動リアクション設定を管理します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('set')
                .setDescription('自動リアクション設定を追加または更新します')
                .addChannelOption((option) =>
                    option
                        .setName('target_channel')
                        .setDescription('対象チャンネルまたはスレッド')
                        .addChannelTypes(...textOrThreadTypes)
                        .setRequired(true),
                )
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('対象ユーザー')
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('emoji')
                        .setDescription('付けるリアクション（例: ✅ または カスタム絵文字ID）')
                        .setRequired(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('show')
                .setDescription('現在の自動リアクション設定一覧を表示します'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('unset')
                .setDescription('自動リアクション設定を削除します')
                .addChannelOption((option) =>
                    option
                        .setName('target_channel')
                        .setDescription('対象チャンネルまたはスレッド')
                        .addChannelTypes(...textOrThreadTypes)
                        .setRequired(true),
                )
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('対象ユーザー')
                        .setRequired(true),
                ),
        )
        .addSubcommandGroup((group) =>
            group
                .setName('allowbot')
                .setDescription('自動リアクション対象として許可する Bot を管理します')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('add')
                        .setDescription('自動リアクション対象として Bot を許可します')
                        .addUserOption((option) =>
                            option
                                .setName('user')
                                .setDescription('許可したい Bot アカウント')
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('show')
                        .setDescription('許可されている Bot 一覧を表示します'),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('remove')
                        .setDescription('自動リアクション対象から Bot を外します')
                        .addUserOption((option) =>
                            option
                                .setName('user')
                                .setDescription('外したい Bot アカウント')
                                .setRequired(true),
                        ),
                ),
        )
        .toJSON(),

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
                                .setName('source_channel')
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
                                .setName('source_channel')
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

    new SlashCommandBuilder()
        .setName('rolemention')
        .setDescription('ロールメンション転載設定を管理します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('set')
                .setDescription('ロールメンションの転載先を設定します')
                .addRoleOption((option) =>
                    option
                        .setName('role')
                        .setDescription('監視したいロール')
                        .setRequired(true),
                )
                .addChannelOption((option) =>
                    option
                        .setName('target_channel')
                        .setDescription('転載先のチャンネルまたはスレッド')
                        .addChannelTypes(...textOrThreadTypes)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('message')
                        .setDescription('転載メッセージのテンプレート（省略時はデフォルト）')
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('placeholders')
                .setDescription('ロールメンション転載で使えるプレースホルダ一覧を表示します'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('show')
                .setDescription('現在のロールメンション転載設定一覧を表示します'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('unset')
                .setDescription('ロールメンション転載設定を削除します')
                .addRoleOption((option) =>
                    option
                        .setName('role')
                        .setDescription('削除したいロール')
                        .setRequired(true),
                ),
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('hasrole')
        .setDescription('指定したロールを持っているメンバーを表示します')
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('指定したロールを持っているメンバー一覧を表示します')
                .addRoleOption((option) =>
                    option
                        .setName('role')
                        .setDescription('持っているメンバーを表示したいロール')
                        .setRequired(true),
                ),
        )
        .toJSON(),

    new SlashCommandBuilder()
        .setName('forward')
        .setDescription('特定チャンネルの書き込み転送設定を管理します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('set')
                .setDescription('転送設定を追加または更新します')
                .addChannelOption((option) =>
                    option
                        .setName('source_channel')
                        .setDescription('転送元チャンネル')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('target_webhook_url')
                        .setDescription('転送先チャンネルのWebhook URL')
                        .setRequired(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('show')
                .setDescription('現在の転送設定一覧を表示します'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('unset')
                .setDescription('転送設定を削除します')
                .addChannelOption((option) =>
                    option
                        .setName('source_channel')
                        .setDescription('転送元チャンネル')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName('target_webhook_url')
                        .setDescription('削除したいWebhook URL')
                        .setRequired(true),
                ),
    )
        .addSubcommandGroup((group) =>
            group
                .setName('allow')
                .setDescription('転送を許可するBotまたはWebhookを管理します')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('add')
                        .setDescription('転送許可対象を追加します')
                        .addChannelOption((option) =>
                            option
                                .setName('source_channel')
                                .setDescription('転送元チャンネル')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true),
                        )
                        .addStringOption((option) =>
                            option
                                .setName('type')
                                .setDescription('許可対象の種類')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'bot', value: 'bot' },
                                    { name: 'webhook', value: 'webhook' },
                                ),
                        )
                        .addStringOption((option) =>
                            option
                                .setName('id')
                                .setDescription('Bot ID または Webhook ID')
                                .setRequired(true),
                        ),
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('remove')
                        .setDescription('転送許可対象を削除します')
                        .addChannelOption((option) =>
                            option
                                .setName('source_channel')
                                .setDescription('転送元チャンネル')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true),
                        )
                        .addStringOption((option) =>
                            option
                                .setName('type')
                                .setDescription('許可対象の種類')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'bot', value: 'bot' },
                                    { name: 'webhook', value: 'webhook' },
                                ),
                        )
                        .addStringOption((option) =>
                            option
                                .setName('id')
                                .setDescription('Bot ID または Webhook ID')
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
        await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
        console.log('グローバルコマンド登録完了');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();