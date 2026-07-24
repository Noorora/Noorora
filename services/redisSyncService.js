const { createClient } = require('redis');

function normalizeIntervalMs(value) {
    const intervalMs = Number(value);

    if (!Number.isFinite(intervalMs) || intervalMs < 60000) {
        return 300000;
    }

    return intervalMs;
}

async function applyExpiry(source, target, key) {
    const ttlMs = await source.pTTL(key);

    if (ttlMs > 0) {
        await target.pExpire(key, ttlMs);
    }
}

async function copyKey(source, target, key) {
    const type = await source.type(key);

    await target.del(key);

    if (type === 'string') {
        const value = await source.get(key);

        if (value !== null) {
            await target.set(key, value);
            await applyExpiry(source, target, key);
        }

        return true;
    }

    if (type === 'hash') {
        const value = await source.hGetAll(key);

        if (Object.keys(value).length > 0) {
            await target.hSet(key, value);
            await applyExpiry(source, target, key);
        }

        return true;
    }

    if (type === 'set') {
        const values = await source.sMembers(key);

        if (values.length > 0) {
            await target.sAdd(key, values);
            await applyExpiry(source, target, key);
        }

        return true;
    }

    if (type === 'list') {
        const values = await source.lRange(key, 0, -1);

        if (values.length > 0) {
            await target.rPush(key, values);
            await applyExpiry(source, target, key);
        }

        return true;
    }

    if (type === 'zset') {
        const values = await source.zRangeWithScores(key, 0, -1);

        if (values.length > 0) {
            await target.zAdd(
                key,
                values.map((item) => ({
                    score: item.score,
                    value: item.value,
                })),
            );

            await applyExpiry(source, target, key);
        }

        return true;
    }

    return false;
}

async function scanKeys(client) {
    let cursor = '0';
    const keys = [];

    do {
        const result = await client.scan(cursor, {
            COUNT: 100,
        });

        cursor = result.cursor;
        keys.push(...result.keys);
    } while (cursor !== '0');

    return keys;
}

async function copyAllKeys(options) {
    const {
        sourceClient,
        targetClient,
        deleteStaleKeys,
        skipEmptySource = true,
        label = 'redis-sync',
    } = options;

    const sourceKeys = await scanKeys(sourceClient);

    if (sourceKeys.length === 0 && skipEmptySource) {
        console.warn(
            `[${label}] Source Redis にキーが無いため、同期をスキップしました。`,
        );

        return {
            ok: false,
            copied: 0,
            deleted: 0,
            skipped: 0,
            reason: 'source_empty',
        };
    }

    let copied = 0;
    let skipped = 0;

    for (const key of sourceKeys) {
        const copiedKey = await copyKey(
            sourceClient,
            targetClient,
            key,
        );

        if (copiedKey) {
            copied += 1;
        } else {
            skipped += 1;
        }
    }

    let deleted = 0;

    if (deleteStaleKeys) {
        const sourceKeySet = new Set(sourceKeys);
        const targetKeys = await scanKeys(targetClient);

        for (const key of targetKeys) {
            if (!sourceKeySet.has(key)) {
                await targetClient.del(key);
                deleted += 1;
            }
        }
    }

    console.log(
        `[${label}] 同期完了 copied=${copied}, deleted=${deleted}, skipped=${skipped}`,
    );

    return {
        ok: true,
        copied,
        deleted,
        skipped,
        reason: null,
    };
}

async function syncRedisUrlToClient(options) {
    const {
        sourceRedisUrl,
        targetRedisClient,
        deleteStaleKeys,
        label = 'redis-sync',
    } = options;

    const source = createClient({
        url: sourceRedisUrl,
    });

    source.on('error', () => { });

    try {
        await source.connect();

        return await copyAllKeys({
            sourceClient: source,
            targetClient: targetRedisClient,
            deleteStaleKeys,
            skipEmptySource: true,
            label,
        });
    } finally {
        await source.quit().catch(() => null);
    }
}

async function syncRedisClientToUrl(options) {
    const {
        sourceRedisClient,
        targetRedisUrl,
        deleteStaleKeys,
        label = 'redis-failback',
    } = options;

    const target = createClient({
        url: targetRedisUrl,
    });

    target.on('error', () => { });

    try {
        await target.connect();

        return await copyAllKeys({
            sourceClient: sourceRedisClient,
            targetClient: target,
            deleteStaleKeys,
            skipEmptySource: true,
            label,
        });
    } finally {
        await target.quit().catch(() => null);
    }
}

function startRedisSyncService(options) {
    const {
        enabled,
        sourceRedisUrl,
        targetRedisClient,
        getBotState,
        intervalMs,
        deleteStaleKeys,
    } = options;

    if (!enabled) {
        return;
    }

    if (!sourceRedisUrl) {
        console.warn(
            '[redis-sync] SYNC_FROM_MAIN_REDIS=true ですが MAIN_REDIS_URL が設定されていません。',
        );

        return;
    }

    const actualIntervalMs = normalizeIntervalMs(intervalMs);
    let syncing = false;

    async function runSync(reason) {
        if (syncing) {
            return;
        }

        const botState = getBotState();

        if (botState === 'running' || botState === 'starting') {
            return;
        }

        syncing = true;

        try {
            await syncRedisUrlToClient({
                sourceRedisUrl,
                targetRedisClient,
                deleteStaleKeys,
                label: 'redis-sync',
            });
        } catch (error) {
            console.warn(
                `[redis-sync] 同期失敗: ${reason}`,
                error.message,
            );
        } finally {
            syncing = false;
        }
    }

    console.log(
        `[redis-sync] Main Redis 同期を開始します。interval=${actualIntervalMs}ms`,
    );

    setTimeout(() => {
        runSync('initial').catch(() => null);
    }, 10000);

    setInterval(() => {
        runSync('interval').catch(() => null);
    }, actualIntervalMs);
}

module.exports = {
    startRedisSyncService,
    syncRedisUrlToClient,
    syncRedisClientToUrl,
};