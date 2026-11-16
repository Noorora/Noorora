const crypto = require('crypto');

const DISCORD_API_BASE =
    'https://discord.com/api/v10';

const discordClientId =
    process.env.DISCORD_CLIENT_ID || '';

const discordClientSecret =
    process.env.DISCORD_CLIENT_SECRET || '';

const discordRedirectUri =
    process.env.DISCORD_OAUTH_REDIRECT_URI || '';

function validateOAuthConfig() {
    const missing = [];

    if (!discordClientId) {
        missing.push('DISCORD_CLIENT_ID');
    }

    if (!discordClientSecret) {
        missing.push('DISCORD_CLIENT_SECRET');
    }

    if (!discordRedirectUri) {
        missing.push(
            'DISCORD_OAUTH_REDIRECT_URI',
        );
    }

    return {
        ok: missing.length === 0,
        missing,
    };
}

function createOAuthState() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

function createDiscordAuthorizationUrl(state) {
    const config =
        validateOAuthConfig();

    if (!config.ok) {
        throw new Error(
            'Discord OAuth設定が不足しています: ' +
            config.missing.join(', '),
        );
    }

    /*
     * Windowsアプリで必要なのは、
     * ユーザー本人と所属Guildの確認。
     *
     * Bot追加用の "bot" scope は
     * ここでは要求しない。
     */
    const params =
        new URLSearchParams({
            client_id: discordClientId,
            response_type: 'code',
            redirect_uri:
                discordRedirectUri,
            scope: 'identify guilds',
            state,
            prompt: 'consent',
        });

    return (
        'https://discord.com/oauth2/authorize?' +
        params.toString()
    );
}

async function exchangeCodeForTokens(code) {
    const config =
        validateOAuthConfig();

    if (!config.ok) {
        throw new Error(
            'Discord OAuth設定が不足しています: ' +
            config.missing.join(', '),
        );
    }

    if (!code) {
        throw new Error(
            'OAuth codeが指定されていません。',
        );
    }

    const body =
        new URLSearchParams({
            client_id:
                discordClientId,
            client_secret:
                discordClientSecret,
            grant_type:
                'authorization_code',
            code,
            redirect_uri:
                discordRedirectUri,
        });

    const response =
        await fetch(
            `${DISCORD_API_BASE}/oauth2/token`,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded',
                },
                body,
            },
        );

    if (!response.ok) {
        const responseText =
            await response.text();

        throw new Error(
            'Discord OAuth token取得失敗: ' +
            `${response.status} ` +
            responseText,
        );
    }

    return response.json();
}

async function getDiscordUser(
    accessToken,
) {
    return fetchDiscordApi(
        '/users/@me',
        accessToken,
    );
}

async function getDiscordGuilds(
    accessToken,
) {
    return fetchDiscordApi(
        '/users/@me/guilds',
        accessToken,
    );
}

async function fetchDiscordApi(
    path,
    accessToken,
) {
    if (!accessToken) {
        throw new Error(
            'Discord Access Tokenがありません。',
        );
    }

    const response =
        await fetch(
            `${DISCORD_API_BASE}${path}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${accessToken}`,
                },
            },
        );

    if (!response.ok) {
        const responseText =
            await response.text();

        throw new Error(
            'Discord APIリクエスト失敗: ' +
            `${response.status} ` +
            responseText,
        );
    }

    return response.json();
}

module.exports = {
    validateOAuthConfig,
    createOAuthState,
    createDiscordAuthorizationUrl,
    exchangeCodeForTokens,
    getDiscordUser,
    getDiscordGuilds,
};