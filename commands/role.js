const { ChannelType } = require('discord.js');
const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages, splitBySpaceToMessages } = require('../utils/messageSplit');

async function collectSpeakerIdsFromChannel(channel) {
    const speakerIds = new Set();
    let before;
    let fetchedCount = 0;

    while (true) {
        const options = { limit: 100 };
        if (before) options.before = before;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        for (const message of batch.values()) {
            if (!message.author.bot) speakerIds.add(message.author.id);
        }

        fetchedCount += batch.size;
        const lastMessage = batch.last();
        if (!lastMessage) break;
        before = lastMessage.id;
        if (batch.size < 100) break;
    }

    return { speakerIds, fetchedCount };
}

async function replyLines(interaction, header, lines) {
    const chunks = splitLinesToMessages(header, lines);
    await interaction.reply(ephemeralOptions({ content: chunks[0] }));
    for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
}

async function replyMentionChunks(interaction, header, rawMentions) {
    const chunks = splitBySpaceToMessages('', rawMentions);
    await interaction.reply(ephemeralOptions({
        content: `${header}\n下のコードブロックをコピーして使ってください。\n\n\`\`\`txt\n${chunks[0]}\n\`\`\``,
    }));
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(ephemeralOptions({ content: `\`\`\`txt\n${chunks[i]}\n\`\`\`` }));
    }
}

async function execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    if (group === 'missing') {
        const targetRole = interaction.options.getRole('role', true);
        await interaction.guild.members.fetch();
        const members = interaction.guild.members.cache.filter((member) => !member.user.bot && !member.roles.cache.has(targetRole.id));

        if (members.size === 0) {
            await interaction.reply(ephemeralOptions({ content: `ロール <@&${targetRole.id}> を持っていないメンバーはいません。` }));
            return;
        }

        if (sub === 'list') {
            await replyLines(interaction, `ロール <@&${targetRole.id}> を持っていないメンバー一覧:\n`, members.map((member) => `・${member.user.tag} (<@${member.id}>)`));
            return;
        }

        if (sub === 'mention') {
            await replyMentionChunks(interaction, `ロール <@&${targetRole.id}> を持っていないメンバーのコピペ用メンションです。`, members.map((member) => `<@${member.id}>`));
            return;
        }
    }

    if (group === 'channelnever') {
        const targetRole = interaction.options.getRole('role', true);
        const sourceChannel = interaction.options.getChannel('source_channel', true);

        if (sourceChannel.type !== ChannelType.GuildText) {
            await interaction.reply(ephemeralOptions({ content: 'source_channel には通常のテキストチャンネルを指定してください。' }));
            return;
        }

        await interaction.deferReply(ephemeralOptions());
        const { speakerIds, fetchedCount } = await collectSpeakerIdsFromChannel(sourceChannel);
        await interaction.guild.members.fetch();
        const members = interaction.guild.members.cache.filter(
            (member) => !member.user.bot && !member.roles.cache.has(targetRole.id) && !speakerIds.has(member.id),
        );

        if (members.size === 0) {
            await interaction.editReply({
                content: `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーはいません。`,
            });
            return;
        }

        if (sub === 'list') {
            const lines = members.map((member) => `・${member.user.tag} (<@${member.id}>)`);
            const chunks = splitLinesToMessages(`ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバー一覧:\n`, lines);
            await interaction.editReply({ content: chunks[0] });
            for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
            return;
        }

        if (sub === 'mention') {
            const rawMentions = members.map((member) => `<@${member.id}>`);
            const chunks = splitBySpaceToMessages('', rawMentions);
            await interaction.editReply({
                content:
                    `ロール <@&${targetRole.id}> を持っておらず、チャンネル <#${sourceChannel.id}> の取得できた履歴（${fetchedCount}件）で一度も発言していないメンバーのコピペ用メンションです。\n` +
                    `下のコードブロックをコピーして使ってください。\n\n` +
                    `\`\`\`txt\n${chunks[0]}\n\`\`\``,
            });
            for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: `\`\`\`txt\n${chunks[i]}\n\`\`\`` }));
            return;
        }
    }

    if (group === 'filter') {
        const hasRole = interaction.options.getRole('has', true);
        const notRole = interaction.options.getRole('not', true);
        await interaction.guild.members.fetch();
        const members = interaction.guild.members.cache.filter(
            (member) => !member.user.bot && member.roles.cache.has(hasRole.id) && !member.roles.cache.has(notRole.id),
        );

        if (members.size === 0) {
            await interaction.reply(ephemeralOptions({ content: `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーはいません。` }));
            return;
        }

        if (sub === 'list') {
            await replyLines(interaction, `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバー一覧:\n`, members.map((member) => `・${member.user.tag} (<@${member.id}>)`));
            return;
        }

        if (sub === 'mention') {
            await replyMentionChunks(interaction, `ロール <@&${hasRole.id}> を持ち、ロール <@&${notRole.id}> を持っていないメンバーのコピペ用メンションです。`, members.map((member) => `<@${member.id}>`));
        }
    }
}

module.exports = {
    name: 'role',
    execute,
};
