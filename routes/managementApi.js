const express = require('express');

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

const oauthStates = new Map();

/*
 * OAuth stateを長時間残さないための有効期限。
 * 10分。
 */
const OAUTH_STATE_TTL_MS =
    10 * 60 * 1000;

function cleanupExpiredStates() {
    const now = Date.now();

    for (const [state, createdAt] of oauthStates) {
        if (
            now - createdAt >
            OAUTH_STATE_TTL_MS
        ) {
            oauthStates.delete(state);
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
                Date.now(),
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
                typeof state !==
                    'string' ||
                !oauthStates.has(state)
            ) {
                res.status(400).json({
                    ok: false,
                    error:
                        'invalid_oauth_state',
                });

                return;
            }

            /*
             * stateは一回だけ使用可能。
             */
            oauthStates.delete(state);

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

                /*
                 * ユーザーが管理でき、
                 * なおかつAutoDetectorが
                 * 導入されているGuildだけを返す。
                 */
                const manageableGuilds =
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
                                id: guild.id,
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
        manageableGuilds,

    loginId,
    expiresIn,
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

            const manageableGuilds =
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
                    manageableGuilds,
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
    return router;
}

module.exports = {
    createManagementRouter,
};
