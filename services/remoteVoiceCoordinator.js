const crypto = require('crypto');

const {
    GatewayDispatchEvents,
} = require('discord.js');

const bridgeSessions =
    new Map();

const BRIDGE_SESSION_TTL_MS =
    2 * 60 * 1000;

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

            pushBridgeEvent(
    payload.guild_id,
    'VOICE_STATE_UPDATE',
    payload,
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

            pushBridgeEvent(
    payload.guild_id,
    'VOICE_SERVER_UPDATE',
    payload,
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

function createRemoteVoiceBridge({
    guildId,
    workerId,
}) {
    cleanupRemoteVoiceBridges();

    const bridgeId =
        crypto
            .randomBytes(32)
            .toString('hex');

    const bridge = {
        bridgeId,
        guildId,
        workerId,
        events: [],
        createdAt:
            Date.now(),
        updatedAt:
            Date.now(),
    };

    bridgeSessions.set(
        bridgeId,
        bridge,
    );

    return bridge;
}

function pushBridgeEvent(
    guildId,
    type,
    payload,
) {
    const now =
        Date.now();

    for (
        const bridge
        of bridgeSessions.values()
    ) {
        if (
            bridge.guildId !==
            guildId
        ) {
            continue;
        }

        bridge.events.push({
            type,
            payload,
        });

        /*
         * 暴走防止。
         * AudioデータではなくGatewayイベントだけ。
         */
        if (
            bridge.events.length >
            20
        ) {
            bridge.events.shift();
        }

        bridge.updatedAt =
            now;
    }
}

function takeRemoteVoiceBridgeEvents(
    bridgeId,
) {
    const bridge =
        bridgeSessions.get(
            bridgeId,
        );

    if (!bridge) {
        return null;
    }

    bridge.updatedAt =
        Date.now();

    return bridge.events.splice(
        0,
        bridge.events.length,
    );
}

function getRemoteVoiceBridge(
    bridgeId,
) {
    return (
        bridgeSessions.get(
            bridgeId,
        ) || null
    );
}

function cleanupRemoteVoiceBridges() {
    const now =
        Date.now();

    for (
        const [
            bridgeId,
            bridge,
        ] of bridgeSessions
    ) {
        if (
            now - bridge.updatedAt >
            BRIDGE_SESSION_TTL_MS
        ) {
            bridgeSessions.delete(
                bridgeId,
            );
        }
    }
}


module.exports = {
    registerRemoteVoiceCoordinator,
    getRemoteVoiceSession,
    clearRemoteVoiceSession,
    createRemoteVoiceBridge,
    getRemoteVoiceBridge,
    takeRemoteVoiceBridgeEvents,
};