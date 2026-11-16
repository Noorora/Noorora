const express = require('express');
const crypto = require('crypto');

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

                /*
                 * 開発途中なので、現段階では
                 * Access Tokenそのものを
                 * Browserへ返さない。
                 *
                 * 後でWindowsアプリ用の
                 * セッションIDに交換する。
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
                        manageableGuilds,

                    /*
                     * 次段階でサーバー側
                     * セッションを作成するための
                     * 一時識別子。
                     */
                    loginId:
                        crypto
                            .randomBytes(32)
                            .toString(
                                'hex',
                            ),
                });
            } catch (error) {
                console.error(
                    '[management-api] ' +
                    'Discord OAuth error:',
                    error,
                );

                res.status(500).json({
                    ok: false,
                    error:
                        'discord_oauth_failed',
                });
            }
        },
    );

    return router;
}

module.exports = {
    createManagementRouter,
};
