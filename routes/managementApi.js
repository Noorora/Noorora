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
    unregisterMusicWorker,
} = require('../services/musicWorkerService');

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
                    .filter(
                        isGuildManager,
                    )
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
    return router;
}

module.exports = {
    createManagementRouter,
};
