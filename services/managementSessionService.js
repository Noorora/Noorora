const crypto = require('crypto');

const {
    managementSessionKey,
} = require('../keys/redisKeys');

/*
 * Windowsアプリのログインセッション有効期限。
 * まずは1時間。
 */
const SESSION_TTL_SECONDS = 60 * 60;

function createLoginId() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

async function createManagementSession(
    kv,
    {
        user,
        accessToken,
    },
) {
    const loginId =
        createLoginId();

    const session = {
        userId: user.id,
        username: user.username,
        globalName:
            user.global_name || null,
        avatar:
            user.avatar || null,

        /*
         * Discord OAuthのAccess Token。
         * Windowsアプリには返さず、
         * Redis側だけに保存する。
         */
        accessToken,

        createdAt:
            Date.now(),
    };

    await kv.set(
        managementSessionKey(loginId),
        JSON.stringify(session),
        {
            EX: SESSION_TTL_SECONDS,
        },
    );

    return {
        loginId,
        expiresIn:
            SESSION_TTL_SECONDS,
    };
}

async function getManagementSession(
    kv,
    loginId,
) {
    if (!loginId) {
        return null;
    }

    const raw =
        await kv.get(
            managementSessionKey(loginId),
        );

    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function deleteManagementSession(
    kv,
    loginId,
) {
    if (!loginId) {
        return false;
    }

    const deleted =
        await kv.del(
            managementSessionKey(loginId),
        );

    return deleted > 0;
}

async function refreshManagementSession(
    kv,
    loginId,
) {
    if (!loginId) {
        return false;
    }

    const key =
        managementSessionKey(loginId);

    const exists =
        await kv.exists(key);

    if (exists !== 1) {
        return false;
    }

    await kv.expire(
        key,
        SESSION_TTL_SECONDS,
    );

    return true;
}

module.exports = {
    SESSION_TTL_SECONDS,
    createManagementSession,
    getManagementSession,
    deleteManagementSession,
    refreshManagementSession,
};