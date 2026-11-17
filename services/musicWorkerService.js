const crypto = require('crypto');

const {
    musicWorkerKey,
    musicGuildWorkersKey,
    musicDesktopWorkerKey,
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
        desktopId,
    },
) {
    if (!desktopId) {
        throw new Error(
            'desktopId が指定されていません。',
        );
    }

    const desktopWorkerKey =
        musicDesktopWorkerKey(
            desktopId,
            guildId,
        );

    /*
     * 同じPC + 同じGuildの古いWorkerを探す。
     */
    const oldWorkerId =
        await kv.get(
            desktopWorkerKey,
        );

    if (oldWorkerId) {
        const oldWorkerRaw =
            await kv.get(
                musicWorkerKey(
                    oldWorkerId,
                ),
            );

        if (oldWorkerRaw) {
            try {
                const oldWorker =
                    JSON.parse(
                        oldWorkerRaw,
                    );

                /*
                 * 同じユーザーのDesktop登録だけ
                 * 置き換える。
                 */
                if (
                    oldWorker.userId ===
                    userId
                ) {
                    await Promise.all([
                        kv.del(
                            musicWorkerKey(
                                oldWorkerId,
                            ),
                        ),

                        kv.sRem(
                            musicGuildWorkersKey(
                                guildId,
                            ),
                            oldWorkerId,
                        ),
                    ]);
                }
            } catch {
                /*
                 * 壊れた古いWorker情報なら
                 * Guild一覧からだけ掃除する。
                 */
                await kv.sRem(
                    musicGuildWorkersKey(
                        guildId,
                    ),
                    oldWorkerId,
                );
            }
        } else {
            /*
             * Worker本体はTTL切れ済み。
             */
            await kv.sRem(
                musicGuildWorkersKey(
                    guildId,
                ),
                oldWorkerId,
            );
        }
    }

    const workerId =
        createWorkerId();

    const worker = {
        workerId,
        desktopId,
        userId,
        guildId,

        name:
            name ||
            'AutoDetector Desktop',

        status:
            'idle',

        createdAt:
            Date.now(),

        updatedAt:
            Date.now(),
    };

    /*
     * Worker本体。
     * HeartbeatでTTLを延長する。
     */
    await kv.set(
        musicWorkerKey(
            workerId,
        ),
        JSON.stringify(
            worker,
        ),
        {
            EX:
                MUSIC_WORKER_TTL_SECONDS,
        },
    );

    /*
     * Guild → Worker一覧。
     */
    await kv.sAdd(
        musicGuildWorkersKey(
            guildId,
        ),
        workerId,
    );

    /*
     * Desktop + Guild → 現在のWorker。
     *
     * Worker本体より少し長く保持。
     * 再起動直後の置換に利用する。
     */
    await kv.set(
        desktopWorkerKey,
        workerId,
        {
            EX:
                MUSIC_WORKER_TTL_SECONDS *
                3,
        },
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

    const deleteOperations = [
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
    ];

    if (worker.desktopId) {
        deleteOperations.push(
            kv.del(
                musicDesktopWorkerKey(
                    worker.desktopId,
                    worker.guildId,
                ),
            ),
        );
    }

    await Promise.all(
        deleteOperations,
    );

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