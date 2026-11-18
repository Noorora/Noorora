const express = require('express');
const crypto = require('crypto');

const {
    createManagementSession,
    getManagementSession,
    refreshManagementSession,
} = require('../services/managementSessionService');

const {
    validateOAuthConfig,
    createOAuthState,
    createDiscordAuthorizationUrl,
    exchangeCodeForTokens,
    getDiscordUser,
    getDiscordGuilds,
} = require('../services/discordOAuthService');

const {
    registerMusicWorker,
    heartbeatMusicWorker,
    getMusicWorker,
    setMusicWorkerStatus,
    unregisterMusicWorker,
} = require('../services/musicWorkerService');


const {
    createMusicJob,
    takeNextMusicJob,
    updateMusicJobStatus,
    getMusicJob,
} = require('../services/musicJobService');

const {
    getRemoteVoiceSession,
    clearRemoteVoiceSession,
    createRemoteVoiceBridge,
    getRemoteVoiceBridge,
    takeRemoteVoiceBridgeEvents,
} = require('../services/remoteVoiceCoordinator');

const {
    ChannelType,
    GatewayOpcodes,
} = require('discord.js');

const oauthStates = new Map();

/*
 * Windowsアプリの認証待機情報。
 *
 * requestId:
 * Windowsアプリが認証結果を受け取るための識別子。
 */
const desktopLoginRequests = new Map();

const DESKTOP_LOGIN_TTL_MS =
    10 * 60 * 1000;

/*
 * OAuth stateを長時間残さないための有効期限。
 * 10分。
 */
const OAUTH_STATE_TTL_MS =
    10 * 60 * 1000;

function cleanupExpiredStates() {
    const now = Date.now();

    for (
        const [
            state,
            stateData,
        ] of oauthStates
    ) {
        const createdAt =
            typeof stateData === 'number'
                ? stateData
                : stateData.createdAt;

        if (
            now - createdAt >
            OAUTH_STATE_TTL_MS
        ) {
            oauthStates.delete(state);
        }
    }

    for (
        const [
            requestId,
            request,
        ] of desktopLoginRequests
    ) {
        if (
            now - request.createdAt >
            DESKTOP_LOGIN_TTL_MS
        ) {
            desktopLoginRequests.delete(
                requestId,
            );
        }
    }
}

function isGuildManager(guild) {
    /*
     * DiscordのMANAGE_GUILD権限。
     * 0x20 = 32
     */
    const MANAGE_GUILD =
        BigInt(0x20);

    if (guild.owner === true) {
        return true;
    }

    try {
        const permissions =
            BigInt(guild.permissions);

        return (
            permissions &
            MANAGE_GUILD
        ) === MANAGE_GUILD;
    } catch {
        return false;
    }
}

function getBearerToken(req) {
    const authorization =
        req.get('authorization') || '';

    if (
        !authorization.startsWith(
            'Bearer ',
        )
    ) {
        return null;
    }

    const token =
        authorization
            .slice(
                'Bearer '.length,
            )
            .trim();

    return token || null;
}

function createManagementRouter({
    getDiscordClient,
    kv,
}) {
    const router =
        express.Router();

    /*
     * Management APIの簡易稼働確認。
     */
    router.get(
        '/status',
        (req, res) => {
            const config =
                validateOAuthConfig();

            res.status(
                config.ok ? 200 : 503,
            ).json({
                ok: config.ok,
                oauthConfigured:
                    config.ok,
                missing:
                    config.missing,
            });
        },
    );

    /*
     * Discord OAuth開始。
     *
     * ブラウザでここへアクセスすると
     * Discordの認可画面へ移動する。
     */
    router.get(
        '/auth/discord',
        (req, res) => {
            cleanupExpiredStates();

            const state =
                createOAuthState();

            oauthStates.set(
    state,
    {
        createdAt: Date.now(),
        requestId: null,
    },
);

            const authorizationUrl =
                createDiscordAuthorizationUrl(
                    state,
                );

            res.redirect(
                authorizationUrl,
            );
        },
    );

    /*
     * Discord OAuth callback。
     */
    router.get(
        '/auth/discord/callback',
        async (req, res) => {
            cleanupExpiredStates();

            const {
                code,
                state,
                error,
                error_description:
                    errorDescription,
            } = req.query;

            if (error) {
                res.status(400).json({
                    ok: false,
                    error,
                    errorDescription:
                        errorDescription ||
                        null,
                });

                return;
            }

            if (
    typeof state !== 'string' ||
    !oauthStates.has(state)
) {
    res.status(400).json({
        ok: false,
        error:
            'invalid_oauth_state',
    });

    return;
}

const stateData =
    oauthStates.get(state);

/*
 * stateは一回だけ使用可能。
 */
oauthStates.delete(state);

const desktopRequestId =
    typeof stateData === 'object'
        ? stateData.requestId
        : null;

            if (
                typeof code !==
                    'string' ||
                !code
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'missing_oauth_code',
                });

                return;
            }

            try {
                const tokens =
                    await exchangeCodeForTokens(
                        code,
                    );

                const [
                    user,
                    guilds,
                ] = await Promise.all([
                    getDiscordUser(
                        tokens.access_token,
                    ),
                    getDiscordGuilds(
                        tokens.access_token,
                    ),
                ]);

                const discordClient =
                    getDiscordClient();

                const availableGuilds =
    guilds
        /*
         * ログインユーザーが参加していて、
         * AutoDetectorも参加しているGuildを表示する。
         *
         * サーバー管理権限は要求しない。
         */
        .filter(
            (guild) =>
                Boolean(
                    discordClient
                        ?.guilds
                        ?.cache
                        ?.has(
                            guild.id,
                        ),
                ),
        )
        .map(
            (guild) => ({
                id:
                    guild.id,
                name:
                    guild.name,
                icon:
                    guild.icon,
                owner:
                    guild.owner,
            }),
        );


                        const {
    loginId,
    expiresIn,
} = await createManagementSession(
    kv,
    {
        user,
        accessToken:
            tokens.access_token,
    },
);

/*
 * ↓ STEP 14はここから
 */
if (desktopRequestId) {
    const desktopRequest =
        desktopLoginRequests.get(
            desktopRequestId,
        );

    if (desktopRequest) {
        desktopLoginRequests.set(
            desktopRequestId,
            {
                ...desktopRequest,
                status: 'completed',
                loginId,
                expiresIn,

                user: {
                    id: user.id,
                    username:
                        user.username,
                    globalName:
                        user.global_name ||
                        null,
                    avatar:
                        user.avatar ||
                        null,
                },

                guilds:
                    availableGuilds,
            },
        );

        res.status(200).send(`
<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <title>AutoDetector</title>
</head>
<body style="
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #0f1115;
    color: #ffffff;
    font-family: 'Segoe UI', sans-serif;
">
    <main style="
        width: min(460px, calc(100% - 40px));
        box-sizing: border-box;
        padding: 40px;
        text-align: center;
        background: #171a21;
        border: 1px solid #292e38;
        border-radius: 12px;
    ">
        <h1 style="margin-top: 0;">
            認証が完了しました
        </h1>

        <p style="
            color: #aab0bc;
            line-height: 1.7;
        ">
            AutoDetectorアプリへ戻ってください。
            このブラウザ画面は閉じて構いません。
        </p>
    </main>
</body>
</html>
        `);

        return;
    }
}
/*
 * ↑ STEP 14はここまで
 */

res.status(200).json({
    ok: true,

    user: {
        id: user.id,
        username:
            user.username,
        globalName:
            user.global_name ||
            null,
        avatar:
            user.avatar,
    },

    guilds:
        availableGuilds,

    loginId,
    expiresIn,
});
        } catch (error) {
            console.error(
                '[management-api] ' +
                'Discord OAuth error:',
                error,
            );

            if (desktopRequestId) {
                const desktopRequest =
                    desktopLoginRequests.get(
                        desktopRequestId,
                    );

                if (desktopRequest) {
                    desktopLoginRequests.set(
                        desktopRequestId,
                        {
                            ...desktopRequest,
                            status: 'failed',
                            error:
                                'discord_oauth_failed',
                        },
                    );
                }
            }

            res.status(500).json({
                ok: false,
                error:
                    'discord_oauth_failed',
            });
        }
    },
);

    /*
 * Windowsアプリからログイン状態を確認する。
 *
 * Authorization:
 * Bearer <loginId>
 */
router.get(
    '/me',
    async (req, res) => {
        try {
            const authorization =
                req.get('authorization') || '';

            if (
                !authorization.startsWith(
                    'Bearer ',
                )
            ) {
                res.status(401).json({
                    ok: false,
                    error:
                        'missing_session',
                });

                return;
            }

            const loginId =
                authorization
                    .slice(
                        'Bearer '.length,
                    )
                    .trim();

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error:
                        'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            /*
             * 使用中なら有効期限を延長。
             * 現在は1時間。
             */
            await refreshManagementSession(
                kv,
                loginId,
            );

            res.status(200).json({
                ok: true,

                user: {
                    id:
                        session.userId,
                    username:
                        session.username,
                    globalName:
                        session.globalName,
                    avatar:
                        session.avatar,
                },
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                '/me error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'internal_error',
            });
        }
    },
);

/*
 * ログインユーザーが管理でき、
 * AutoDetectorが導入されているGuild一覧を返す。
 */
router.get(
    '/guilds',
    async (req, res) => {
        try {
            const authorization =
                req.get('authorization') || '';

            if (
                !authorization.startsWith(
                    'Bearer ',
                )
            ) {
                res.status(401).json({
                    ok: false,
                    error:
                        'missing_session',
                });

                return;
            }

            const loginId =
                authorization
                    .slice(
                        'Bearer '.length,
                    )
                    .trim();

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error:
                        'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            /*
             * Discordから最新のGuild一覧を取得する。
             * ログイン時の一覧を使い回さない。
             */
            const guilds =
                await getDiscordGuilds(
                    session.accessToken,
                );

            const discordClient =
                getDiscordClient();

            const availableGuilds =
    guilds
        /*
         * ログインユーザーが参加していて、
         * AutoDetectorも参加しているGuildを表示する。
         *
         * サーバー管理権限は要求しない。
         */
        .filter(
            (guild) =>
                Boolean(
                    discordClient
                        ?.guilds
                        ?.cache
                        ?.has(
                            guild.id,
                        ),
                ),
        )
        .map(
            (guild) => ({
                id:
                    guild.id,
                name:
                    guild.name,
                icon:
                    guild.icon,
                owner:
                    guild.owner,
            }),
        );

            await refreshManagementSession(
                kv,
                loginId,
            );

            res.status(200).json({
    ok: true,
    guilds:
        availableGuilds,
});
        } catch (error) {
            console.error(
                '[management-api] ' +
                '/guilds error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'guild_fetch_failed',
            });
        }
    },
);

/*
 * Windowsアプリ用のOAuth認証開始。
 *
 * WindowsアプリはこのAPIから
 * requestIdとauthorizationUrlを受け取る。
 */
router.post(
    '/desktop-auth/start',
    (req, res) => {
        try {
            cleanupExpiredStates();

            const requestId =
                crypto
                    .randomBytes(32)
                    .toString('hex');

            const state =
                createOAuthState();

            const createdAt =
                Date.now();

            desktopLoginRequests.set(
                requestId,
                {
                    createdAt,
                    status: 'pending',
                    loginId: null,
                    expiresIn: null,
                    user: null,
                    guilds: null,
                },
            );

            oauthStates.set(
                state,
                {
                    createdAt,
                    requestId,
                },
            );

            const authorizationUrl =
                createDiscordAuthorizationUrl(
                    state,
                );

            res.status(200).json({
                ok: true,
                requestId,
                authorizationUrl,
                expiresIn:
                    DESKTOP_LOGIN_TTL_MS /
                    1000,
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'desktop auth start error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'desktop_auth_start_failed',
            });
        }
    },
);

/*
 * WindowsアプリがOAuth結果を確認する。
 */
router.get(
    '/desktop-auth/result/:requestId',
    (req, res) => {
        cleanupExpiredStates();

        const {
            requestId,
        } = req.params;

        const request =
            desktopLoginRequests.get(
                requestId,
            );

        if (!request) {
            res.status(404).json({
                ok: false,
                error:
                    'login_request_not_found',
            });

            return;
        }

        if (
            request.status !==
            'completed'
        ) {
            res.status(200).json({
                ok: true,
                status:
                    'pending',
            });

            return;
        }

        /*
         * loginIdは一度だけ返す。
         * 取得後は認証要求自体を削除する。
         */
        desktopLoginRequests.delete(
            requestId,
        );

        res.status(200).json({
            ok: true,
            status:
                'completed',
            loginId:
                request.loginId,
            expiresIn:
                request.expiresIn,
            user:
                request.user,
            guilds:
                request.guilds,
        });
    },
);

/*
 * このWindows PCを
 * GuildのMusic Workerとして登録する。
 */
router.post(
    '/music-workers/register',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                guildId,
                name,
                desktopId,
            } = req.body || {};

            if (
                typeof guildId !== 'string' ||
                !guildId
            ) {
                res.status(400).json({
                    ok: false,
                    error: 'missing_guild_id',
                });

                return;
            }

            if (
                typeof desktopId !== 'string' ||
                !desktopId.trim()
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'missing_desktop_id',
                });

                return;
            }

            /*
             * Discordから現在のGuild情報を取得し、
             * ログインユーザーが管理可能か確認する。
             */
            const guilds =
                await getDiscordGuilds(
                    session.accessToken,
                );

            const guild =
                guilds.find(
                    (item) =>
                        item.id === guildId,
                );

            if (!guild) {
    res.status(403).json({
        ok: false,
        error:
            'guild_membership_required',
    });

    return;
}

            /*
             * AutoDetector自身が対象Guildに
             * 入っていることも確認。
             */
            const discordClient =
                getDiscordClient();

            if (
                !discordClient
                    ?.guilds
                    ?.cache
                    ?.has(guildId)
            ) {
                res.status(404).json({
                    ok: false,
                    error:
                        'bot_not_in_guild',
                });

                return;
            }

            const worker =
                await registerMusicWorker(
                    kv,
                    {
                        userId:
                            session.userId,

                        guildId,

                        name:
                            typeof name ===
                                'string'
                                ? name.trim()
                                : null,

                        desktopId:
                            desktopId.trim(),
                    },
                );

            await refreshManagementSession(
                kv,
                loginId,
            );

            res.status(201).json({
                ok: true,
                worker: {
                    workerId:
                        worker.workerId,
                    guildId:
                        worker.guildId,
                    name:
                        worker.name,
                    status:
                        worker.status,
                },
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'music worker register error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'worker_register_failed',
            });
        }
    },
);

/*
 * Workerの生存通知。
 */
router.post(
    '/music-workers/:workerId/heartbeat',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                workerId,
            } = req.params;

            const worker =
                await getMusicWorker(
                    kv,
                    workerId,
                );

            if (!worker) {
                res.status(404).json({
                    ok: false,
                    error:
                        'worker_not_found',
                });

                return;
            }

            /*
             * 他人が登録したWorkerの
             * heartbeatは更新できない。
             */
            if (
                worker.userId !==
                session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'worker_owner_mismatch',
                });

                return;
            }

            const updatedWorker =
                await heartbeatMusicWorker(
                    kv,
                    workerId,
                );

            await refreshManagementSession(
                kv,
                loginId,
            );

            res.status(200).json({
                ok: true,
                worker: {
                    workerId:
                        updatedWorker.workerId,
                    guildId:
                        updatedWorker.guildId,
                    status:
                        updatedWorker.status,
                },
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'music worker heartbeat error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'worker_heartbeat_failed',
            });
        }
    },
);

/*
 * このPCのWorker登録を解除する。
 */
router.delete(
    '/music-workers/:workerId',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                workerId,
            } = req.params;

            const worker =
                await getMusicWorker(
                    kv,
                    workerId,
                );

            if (!worker) {
                res.status(404).json({
                    ok: false,
                    error:
                        'worker_not_found',
                });

                return;
            }

            if (
                worker.userId !==
                session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'worker_owner_mismatch',
                });

                return;
            }

            await unregisterMusicWorker(
                kv,
                workerId,
            );

            res.status(200).json({
                ok: true,
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'music worker unregister error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'worker_unregister_failed',
            });
        }
    },
);

/*
 * Workerが次の再生ジョブを取得する。
 *
 * ジョブが無い場合も正常なため、
 * HTTP 204ではなくJSONで待機状態を返す。
 */
router.get(
    '/music-workers/:workerId/jobs/next',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                workerId,
            } = req.params;

            const worker =
                await getMusicWorker(
                    kv,
                    workerId,
                );

            if (!worker) {
                res.status(404).json({
                    ok: false,
                    error:
                        'worker_not_found',
                });

                return;
            }

            /*
             * Worker登録者以外には
             * ジョブを渡さない。
             */
            if (
                worker.userId !==
                session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'worker_owner_mismatch',
                });

                return;
            }

            const job =
                await takeNextMusicJob(
                    kv,
                    workerId,
                );

            await refreshManagementSession(
                kv,
                loginId,
            );

            if (!job) {
                res.status(200).json({
                    ok: true,
                    status: 'waiting',
                    job: null,
                });

                return;
            }

            res.status(200).json({
                ok: true,
                status: 'assigned',

                job: {
                    jobId:
                        job.jobId,

                    type:
                        job.type,

                    guildId:
                        job.guildId,

                    voiceChannelId:
                        job.voiceChannelId,

                    textChannelId:
                        job.textChannelId,

                    requestedById:
                        job.requestedById,

                    url:
                        job.url,

                    volume:
                        job.volume ?? 0.2,
                },
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'music job next error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'music_job_receive_failed',
            });
        }
    },
);
/*
 * Workerがジョブの進行状態を報告する。
 */
router.post(
    '/music-jobs/:jobId/status',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                jobId,
            } = req.params;

            const {
                status,
                detail,
            } = req.body || {};

            const allowedStatuses =
                new Set([
                    'received',
                    'preparing',
                    'playing',
                    'completed',
                    'failed',
                    'cancelled',
                ]);

            if (
                typeof status !== 'string' ||
                !allowedStatuses.has(status)
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'invalid_job_status',
                });

                return;
            }

            const currentJob =
    await getMusicJob(
        kv,
        jobId,
    );

if (!currentJob) {
    res.status(404).json({
        ok: false,
        error:
            'music_job_not_found',
    });

    return;
}

const worker =
    await getMusicWorker(
        kv,
        currentJob.workerId,
    );

if (
    !worker ||
    worker.userId !==
        session.userId
) {
    res.status(403).json({
        ok: false,
        error:
            'music_job_owner_mismatch',
    });

    return;
}

            const updatedJob =
                await updateMusicJobStatus(
                    kv,
                    jobId,
                    status,
                    typeof detail === 'string'
                        ? detail.slice(0, 500)
                        : null,
                );

            if (!updatedJob) {
                res.status(404).json({
                    ok: false,
                    error:
                        'music_job_not_found',
                });

                return;
            }

            /*
             * ジョブを担当するWorkerの
             * 所有者だけが状態を変更できる。
             */
            
            res.status(200).json({
                ok: true,

                job: {
                    jobId:
                        updatedJob.jobId,
                    status:
                        updatedJob.status,
                    detail:
                        updatedJob.detail,
                },
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'music job status error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'music_job_status_failed',
            });
        }
    },
);

/*
 * 開発用:
 * 自分のWorkerへテストジョブを作成する。
 *
 * 本番の/music接続後は削除する。
 */
router.post(
    '/music-workers/:workerId/test-job',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                workerId,
            } = req.params;

            const worker =
                await getMusicWorker(
                    kv,
                    workerId,
                );

            if (!worker) {
                res.status(404).json({
                    ok: false,
                    error:
                        'worker_not_found',
                });

                return;
            }

            if (
                worker.userId !==
                session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'worker_owner_mismatch',
                });

                return;
            }

            const {
                url,
            } = req.body || {};

            if (
                typeof url !== 'string' ||
                !url.trim()
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'missing_music_url',
                });

                return;
            }

            const normalizedUrl =
                url.trim();

            if (
                !normalizedUrl.startsWith(
                    'https://www.nicovideo.jp/',
                ) &&
                !normalizedUrl.startsWith(
                    'https://nico.ms/',
                )
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'unsupported_music_url',
                });

                return;
            }

            const job =
                await createMusicJob(
                    kv,
                    {
                        workerId:
                            worker.workerId,
                        guildId:
                            worker.guildId,

                        /*
                         * このAPIは通信試験用なので、
                         * VC/Text Channelはまだ渡さない。
                         */
                        voiceChannelId:
                            null,
                        textChannelId:
                            null,

                        requestedById:
                            session.userId,

                        url:
                            normalizedUrl,

                        type:
                            'test',
                    },
                );

            res.status(201).json({
                ok: true,

                job: {
                    jobId:
                        job.jobId,
                    status:
                        job.status,
                    url:
                        job.url,
                },
            });
        } catch (error) {
            console.error(
                '[management-api] ' +
                'music test job error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'music_test_job_failed',
            });
        }
    },
);

/*
 * Remote Voice接続の最小実験。
 *
 * Render側のDiscord Gatewayから
 * Voice State Updateを送信し、
 * Discordから返ってくる一時接続情報を
 * Windows Workerへ返す。
 */
router.post(
    '/remote-voice/test/join',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const {
                workerId,
                guildId,
                voiceChannelId,
            } = req.body || {};

            if (
                typeof workerId !== 'string' ||
                typeof guildId !== 'string' ||
                typeof voiceChannelId !== 'string'
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'missing_remote_voice_fields',
                });

                return;
            }

            const worker =
                await getMusicWorker(
                    kv,
                    workerId,
                );

            if (!worker) {
                res.status(404).json({
                    ok: false,
                    error:
                        'worker_not_found',
                });

                return;
            }

            if (
                worker.userId !==
                session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'worker_owner_mismatch',
                });

                return;
            }

            if (
    worker.guildId !==
    guildId
) {
    res.status(400).json({
        ok: false,
        error:
            'worker_guild_mismatch',
    });

    return;
}

/*
 * GuildとWorkerの対応確認が成功した後に
 * Bridgeを作成する。
 */
const bridge =
    createRemoteVoiceBridge({
        guildId,
        workerId,
    });

const discordClient =
    getDiscordClient();

            if (
                !discordClient ||
                !discordClient.user
            ) {
                res.status(503).json({
                    ok: false,
                    error:
                        'discord_client_not_ready',
                });

                return;
            }

            const guild =
                await discordClient.guilds
                    .fetch(guildId)
                    .catch(() => null);

            if (!guild) {
                res.status(404).json({
                    ok: false,
                    error:
                        'guild_not_found',
                });

                return;
            }

            const voiceChannel =
                await guild.channels
                    .fetch(voiceChannelId)
                    .catch(() => null);

            if (
                !voiceChannel ||
                (
                    voiceChannel.type !==
                        ChannelType.GuildVoice &&
                    voiceChannel.type !==
                        ChannelType.GuildStageVoice
                )
            ) {
                res.status(404).json({
                    ok: false,
                    error:
                        'voice_channel_not_found',
                });

                return;
            }

            const botMember =
                guild.members.me;

            if (!botMember) {
                res.status(503).json({
                    ok: false,
                    error:
                        'bot_member_not_ready',
                });

                return;
            }

            const permissions =
                voiceChannel.permissionsFor(
                    botMember,
                );

            if (
                !permissions?.has(
                    'Connect',
                ) ||
                !permissions.has(
                    'Speak',
                )
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'bot_voice_permission_denied',
                });

                return;
            }

            /*
 * Botが既に同じVCへ入っている場合、
 * Discordから新しいVoice Server情報が
 * 届かないことがある。
 *
 * 一度退出してから接続し直し、
 * 新しいVoice Sessionを取得する。
 */
guild.shard.send({
    op:
        GatewayOpcodes.VoiceStateUpdate,

    d: {
        guild_id:
            guildId,

        channel_id:
            null,

        self_mute:
            false,

        self_deaf:
            true,
    },
});

/*
 * 退出イベントを処理する時間を確保する。
 */
await new Promise(
    (resolve) => {
        setTimeout(
            resolve,
            1000,
        );
    },
);

/*
 * 退出後に古いVoice情報を破棄する。
 */
clearRemoteVoiceSession(
    guildId,
);

/*
 * 対象VCへ改めて参加する。
 */
guild.shard.send({
    op:
        GatewayOpcodes.VoiceStateUpdate,

    d: {
        guild_id:
            guildId,

        channel_id:
            voiceChannelId,

        self_mute:
            false,

        self_deaf:
            true,
    },
});

            /*
             * VOICE_STATE_UPDATEと
             * VOICE_SERVER_UPDATEが揃うまで、
             * 最大8秒待つ。
             */
            let remoteSession =
                null;

            for (
                let attempt = 0;
                attempt < 150;
                attempt += 1
            ) {
                await new Promise(
                    (resolve) => {
                        setTimeout(
                            resolve,
                            200,
                        );
                    },
                );

                remoteSession =
                    getRemoteVoiceSession(
                        guildId,
                    );

                if (remoteSession?.ready) {
                    break;
                }
            }

            if (!remoteSession?.ready) {
    console.warn(
        '[remote-voice] session timeout',
        {
            guildId,
            hasVoiceState:
                Boolean(
                    remoteSession
                        ?.voiceStateUpdate,
                ),
            hasVoiceServer:
                Boolean(
                    remoteSession
                        ?.voiceServerUpdate,
                ),
        },
    );

    res.status(504).json({
        ok: false,
        error:
            'remote_voice_session_timeout',

        diagnostic: {
            hasVoiceState:
                Boolean(
                    remoteSession
                        ?.voiceStateUpdate,
                ),

            hasVoiceServer:
                Boolean(
                    remoteSession
                        ?.voiceServerUpdate,
                ),
        },
    });

    return;
}

            /*
             * Bot Tokenは返さない。
             *
             * DiscordがこのVoice接続のために発行した
             * session_id、endpoint、一時tokenだけを返す。
             */
           res.status(200).json({
    ok: true,

    bridgeId:
        bridge.bridgeId,

    voice: {
        guildId,
        channelId:
            voiceChannelId,

        userId:
            discordClient.user.id,

        sessionId:
            remoteSession
                .voiceStateUpdate
                .session_id,

        endpoint:
            remoteSession
                .voiceServerUpdate
                .endpoint,

        token:
            remoteSession
                .voiceServerUpdate
                .token,
    },
});
        } catch (error) {
            console.error(
                '[management-api] ' +
                'remote voice test join error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'remote_voice_test_join_failed',
            });
        }
    },
);

/*
 * Voice Workerが要求したGateway payloadを
 * Render上のDiscord Gatewayへ中継する。
 */
router.post(
    '/remote-voice/bridge/:bridgeId/gateway',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const bridge =
                getRemoteVoiceBridge(
                    req.params.bridgeId,
                );

            if (!bridge) {
                res.status(404).json({
                    ok: false,
                    error:
                        'voice_bridge_not_found',
                });

                return;
            }

            const worker =
                await getMusicWorker(
                    kv,
                    bridge.workerId,
                );

            if (
                !worker ||
                worker.userId !==
                    session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'voice_bridge_owner_mismatch',
                });

                return;
            }

            const payload =
                req.body?.payload;

            if (
                !payload ||
                typeof payload !== 'object'
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'missing_gateway_payload',
                });

                return;
            }

            /*
             * Voice Workerから通常Gatewayへ送れるのは
             * Voice State Updateだけに限定する。
             */
            if (
                payload.op !==
                GatewayOpcodes.VoiceStateUpdate
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'unsupported_gateway_opcode',
                });

                return;
            }

            const discordClient =
                getDiscordClient();

            const guild =
                discordClient
                    ?.guilds
                    ?.cache
                    ?.get(
                        bridge.guildId,
                    );

            if (!guild) {
                res.status(404).json({
                    ok: false,
                    error:
                        'guild_not_found',
                });

                return;
            }

            guild.shard.send(
                payload,
            );

            await refreshManagementSession(
                kv,
                loginId,
            );

            res.status(200).json({
                ok: true,
            });
        } catch (error) {
            console.error(
                '[remote-voice] ' +
                'gateway bridge error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'voice_bridge_gateway_failed',
            });
        }
    },
);

/*
 * Discord Gatewayから受信したVoiceイベントを
 * Voice Workerへ返す。
 */
router.get(
    '/remote-voice/bridge/:bridgeId/events',
    async (req, res) => {
        try {
            const loginId =
                getBearerToken(req);

            if (!loginId) {
                res.status(401).json({
                    ok: false,
                    error: 'missing_session',
                });

                return;
            }

            const session =
                await getManagementSession(
                    kv,
                    loginId,
                );

            if (!session) {
                res.status(401).json({
                    ok: false,
                    error:
                        'invalid_or_expired_session',
                });

                return;
            }

            const bridge =
                getRemoteVoiceBridge(
                    req.params.bridgeId,
                );

            if (!bridge) {
                res.status(404).json({
                    ok: false,
                    error:
                        'voice_bridge_not_found',
                });

                return;
            }

            const worker =
                await getMusicWorker(
                    kv,
                    bridge.workerId,
                );

            if (
                !worker ||
                worker.userId !==
                    session.userId
            ) {
                res.status(403).json({
                    ok: false,
                    error:
                        'voice_bridge_owner_mismatch',
                });

                return;
            }

            const events =
                takeRemoteVoiceBridgeEvents(
                    bridge.bridgeId,
                );

            await refreshManagementSession(
                kv,
                loginId,
            );

            res.status(200).json({
                ok: true,
                events:
                    events || [],
            });
        } catch (error) {
            console.error(
                '[remote-voice] ' +
                'event bridge error:',
                error,
            );

            res.status(500).json({
                ok: false,
                error:
                    'voice_bridge_events_failed',
            });
        }
    },
    );

    /*
 * Music Workerの状態を更新する。
 *
 * 現在は再生完了後に
 * busy -> idle へ戻す用途。
 */
    router.post(
        '/music-workers/:workerId/status',
        async (req, res) => {
            try {
                const loginId =
                    getBearerToken(req);

                if (!loginId) {
                    res.status(401).json({
                        ok: false,
                        error:
                            'missing_session',
                    });

                    return;
                }

                const session =
                    await getManagementSession(
                        kv,
                        loginId,
                    );

                if (!session) {
                    res.status(401).json({
                        ok: false,
                        error:
                            'invalid_or_expired_session',
                    });

                    return;
                }

                const {
                    workerId,
                } = req.params;

                const worker =
                    await getMusicWorker(
                        kv,
                        workerId,
                    );

                if (!worker) {
                    res.status(404).json({
                        ok: false,
                        error:
                            'worker_not_found',
                    });

                    return;
                }

                if (
                    worker.userId !==
                    session.userId
                ) {
                    res.status(403).json({
                        ok: false,
                        error:
                            'worker_owner_mismatch',
                    });

                    return;
                }

                const {
                    status,
                } = req.body || {};

                if (
                    status !== 'idle' &&
                    status !== 'busy'
                ) {
                    res.status(400).json({
                        ok: false,
                        error:
                            'invalid_worker_status',
                    });

                    return;
                }

                const updatedWorker =
                    await setMusicWorkerStatus(
                        kv,
                        workerId,
                        status,
                    );

                if (!updatedWorker) {
                    res.status(404).json({
                        ok: false,
                        error:
                            'worker_not_found',
                    });

                    return;
                }

                await refreshManagementSession(
                    kv,
                    loginId,
                );

                res.status(200).json({
                    ok: true,

                    worker: {
                        workerId:
                            updatedWorker.workerId,

                        status:
                            updatedWorker.status,
                    },
                });
            } catch (error) {
                console.error(
                    '[management-api] ' +
                    'music worker status error:',
                    error,
                );

                res.status(500).json({
                    ok: false,
                    error:
                        'worker_status_failed',
                });
            }
        },
    );
    return router;
}

module.exports = {
    createManagementRouter,
};
