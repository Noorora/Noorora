const {
    GatewayDispatchEvents,
} = require('discord.js');

/*
 * GuildごとのRemote Voice接続情報。
 *
 * これは実験用のメモリ保持。
 * Discord公式仕様上、Voice Server情報は
 * キャッシュ・永続保存しない。
 */
const sessions =
    new Map();

function getOrCreateSession(guildId) {
    let session =
        sessions.get(guildId);

    if (!session) {
        session = {
            guildId,
            voiceStateUpdate:
                null,
            voiceServerUpdate:
                null,
            updatedAt:
                Date.now(),
        };

        sessions.set(
            guildId,
            session,
        );
    }

    return session;
}

function registerRemoteVoiceCoordinator(
    client,
) {
    /*
     * Bot自身のVOICE_STATE_UPDATE。
     *
     * session_idがここに入る。
     */
    client.ws.on(
        GatewayDispatchEvents.VoiceStateUpdate,
        (payload) => {
            if (
                !payload.guild_id ||
                !payload.session_id ||
                payload.user_id !==
                    client.user?.id
            ) {
                return;
            }

            const session =
                getOrCreateSession(
                    payload.guild_id,
                );

            session.voiceStateUpdate =
                payload;

            session.updatedAt =
                Date.now();

            console.log(
                '[remote-voice] ' +
                'VOICE_STATE_UPDATE received ' +
                `guild=${payload.guild_id}`,
            );
        },
    );

    /*
     * Voice Server情報。
     *
     * endpointと短命tokenがここに入る。
     */
    client.ws.on(
        GatewayDispatchEvents.VoiceServerUpdate,
        (payload) => {
            if (!payload.guild_id) {
                return;
            }

            const session =
                getOrCreateSession(
                    payload.guild_id,
                );

            session.voiceServerUpdate =
                payload;

            session.updatedAt =
                Date.now();

            /*
             * token自体はログへ出さない。
             */
            console.log(
                '[remote-voice] ' +
                'VOICE_SERVER_UPDATE received ' +
                `guild=${payload.guild_id} ` +
                `endpoint=${payload.endpoint || 'none'}`,
            );
        },
    );

    console.log(
        '[remote-voice] ' +
        'Discord Gateway監視を開始しました。',
    );
}

function getRemoteVoiceSession(
    guildId,
) {
    const session =
        sessions.get(guildId);

    if (!session) {
        return null;
    }

    return {
        guildId:
            session.guildId,

        ready:
            Boolean(
                session.voiceStateUpdate &&
                session.voiceServerUpdate,
            ),

        voiceStateUpdate:
            session.voiceStateUpdate,

        voiceServerUpdate:
            session.voiceServerUpdate,

        updatedAt:
            session.updatedAt,
    };
}

function clearRemoteVoiceSession(
    guildId,
) {
    sessions.delete(
        guildId,
    );
}

module.exports = {
    registerRemoteVoiceCoordinator,
    getRemoteVoiceSession,
    clearRemoteVoiceSession,
};