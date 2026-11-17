const crypto = require('crypto');

const {
    musicWorkerKey,
    musicGuildWorkersKey,
} = require('../keys/redisKeys');


/*
 * Workerは10秒ごとのheartbeatを想定。
 * 30秒間応答がなければoffline扱い。
 */
const MUSIC_WORKER_TTL_SECONDS = 30;

function createWorkerId() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

async function registerMusicWorker(
    kv,
    {
        userId,
        guildId,
        name,
    },
) {
    const workerId =
        createWorkerId();

    const worker = {
        workerId,
        userId,
        guildId,
        name:
            name || 'AutoDetector Desktop',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    await kv.set(
        musicWorkerKey(workerId),
        JSON.stringify(worker),
        {
            EX: MUSIC_WORKER_TTL_SECONDS,
        },
    );

    /*
     * Guild側にはWorker IDだけを登録する。
     */
    await kv.sAdd(
        musicGuildWorkersKey(guildId),
        workerId,
    );

    return worker;
}

async function heartbeatMusicWorker(
    kv,
    workerId,
) {
    const key =
        musicWorkerKey(workerId);

    const raw =
        await kv.get(key);

    if (!raw) {
        return null;
    }

    let worker;

    try {
        worker =
            JSON.parse(raw);
    } catch {
        return null;
    }

    worker.updatedAt =
        Date.now();

    await kv.set(
        key,
        JSON.stringify(worker),
        {
            EX: MUSIC_WORKER_TTL_SECONDS,
        },
    );

    return worker;
}

async function getMusicWorker(
    kv,
    workerId,
) {
    const raw =
        await kv.get(
            musicWorkerKey(workerId),
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

async function setMusicWorkerStatus(
    kv,
    workerId,
    status,
) {
    const worker =
        await getMusicWorker(
            kv,
            workerId,
        );

    if (!worker) {
        return null;
    }

    worker.status =
        status;

    worker.updatedAt =
        Date.now();

    await kv.set(
        musicWorkerKey(workerId),
        JSON.stringify(worker),
        {
            EX: MUSIC_WORKER_TTL_SECONDS,
        },
    );

    return worker;
}

async function getOnlineMusicWorkers(
    kv,
    guildId,
) {
    const workerIds =
        await kv.sMembers(
            musicGuildWorkersKey(
                guildId,
            ),
        );

    const workers = [];

    for (const workerId of workerIds) {
        const worker =
            await getMusicWorker(
                kv,
                workerId,
            );

        /*
         * TTL切れならWorker本体は消えている。
         * GuildのSetから古いIDも掃除する。
         */
        if (!worker) {
            await kv.sRem(
                musicGuildWorkersKey(
                    guildId,
                ),
                workerId,
            );

            continue;
        }

        workers.push(worker);
    }

    return workers;
}

async function findAvailableMusicWorker(
    kv,
    guildId,
) {
    const workers =
        await getOnlineMusicWorkers(
            kv,
            guildId,
        );

    return (
        workers.find(
            (worker) =>
                worker.status === 'idle',
        ) || null
    );
}

async function unregisterMusicWorker(
    kv,
    workerId,
) {
    const worker =
        await getMusicWorker(
            kv,
            workerId,
        );

    if (!worker) {
        return false;
    }

    await Promise.all([
        kv.del(
            musicWorkerKey(
                workerId,
            ),
        ),

        kv.sRem(
            musicGuildWorkersKey(
                worker.guildId,
            ),
            workerId,
        ),
    ]);

    return true;
}

module.exports = {
    MUSIC_WORKER_TTL_SECONDS,
    registerMusicWorker,
    heartbeatMusicWorker,
    getMusicWorker,
    setMusicWorkerStatus,
    getOnlineMusicWorkers,
    findAvailableMusicWorker,
    unregisterMusicWorker,
};