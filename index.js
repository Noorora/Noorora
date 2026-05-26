const { Client, GatewayIntentBits, ChannelType, Events } = require('discord.js');

// ===== 設定ここから =====
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('TOKEN が設定されていません');
  process.exit(1);
}

const forumToLogChannelMap = {
    '1508136701665611786': '1439856188111192125',
};

// ===== 設定ここまで =====

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`ログイン完了: ${readyClient.user.tag}`);
});

client.on(Events.ThreadCreate, async (thread) => {
  try {
      if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

      const logChannelId = forumToLogChannelMap[thread.parentId];
      if (!logChannelId) return;

      const logChannel = await client.channels.fetch(logChannelId);
      if (!logChannel || !logChannel.isTextBased()) return;

    const ownerMention = thread.ownerId ? `<@${thread.ownerId}>` : '不明';

    // discord.js の url が取れない場合に備えてフォールバックも用意
    const threadLink =
      thread.url ?? `https://discord.com/channels/${thread.guildId}/${thread.id}`;

    const message =
      `新しいスレが質問板に作成されました！\n` +
      `スレ主: ${ownerMention}\n` +
      `リンク: ${threadLink}`;

    await logChannel.send(message);
  } catch (error) {
    console.error('threadCreate でエラー:', error);
  }
});

client.login(TOKEN);