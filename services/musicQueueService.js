const crypto = require('crypto');

const {
    musicQueueKey,
    musicCurrentKey,
    musicQueueLockKey,
} = require('../keys/redisKeys');

const {
    createMusicJob,
    getMusicJob,
} = require('./musicJobService');

const {
    getOnlineMusicWorkers,
    getMusicWorker,
    setMusicWorkerStatus,
} = require('./musicWorkerService');

const MUSIC_QUEUE_TTL_SECONDS = 24 * 60 * 60;
const MUSIC_QUEUE_LOCK_SECONDS = 10;
const MAX_QUEUE_LENGTH = 100;

function createTrackId() {
    return crypto.randomBytes(24).toString('hex');
}

async function withGuildQueueLock(kv, guildId, action) {
    const lockKey = musicQueueLockKey(guildId);
    const lockValue = crypto.randomBytes(16).toString('hex');

    const acquired = await kv.set(
        lockKey,
        lockValue,
        {
            NX: true,
            EX: MUSIC_QUEUE_LOCK_SECONDS,
        },
    );

    if (!acquired) {
        throw new Error('music_queue_busy');
    }

    try {
        return await action();
    } finally {
        const currentLockValue = await kv.get(lockKey);

        if (currentLockValue === lockValue) {
            await kv.del(lockKey);
        }
    }
}

async function getCurrentMusicTrack(kv, guildId) {
    const raw = await kv.get(
        musicCurrentKey(guildId),
    );

    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        await kv.del(
            musicCurrentKey(guildId),
        );

        return null;
    }
}

async function getQueuedMusicTracks(kv, guildId) {
    const values = await kv.lRange(
        musicQueueKey(guildId),
        0,
        MAX_QUEUE_LENGTH - 1,
    );

    const tracks = [];

    for (const value of values) {
        try {
            tracks.push(JSON.parse(value));
        } catch {
            // 壊れた要素は表示から除外する。
        }
    }

    return tracks;
}

async function getGuildMusicQueue(kv, guildId) {
    const [current, queued] = await Promise.all([
        getCurrentMusicTrack(kv, guildId),
        getQueuedMusicTracks(kv, guildId),
    ]);

    return {
        current,
        queued,
    };
}

async function chooseWorker(
    kv,
    guildId,
    preferredWorkerId = null,
) {
    if (preferredWorkerId) {
        const preferredWorker = await getMusicWorker(
            kv,
            preferredWorkerId,
        );

        if (
            preferredWorker &&
            preferredWorker.guildId === guildId
        ) {
            return preferredWorker;
        }
    }

    const workers = await getOnlineMusicWorkers(
        kv,
        guildId,
    );

    return (
        workers.find(
            (worker) => worker.status === 'busy',
        ) ||
        workers.find(
            (worker) => worker.status === 'idle',
        ) ||
        workers[0] ||
        null
    );
}

async function dispatchNextMusicTrackUnlocked(
    kv,
    guildId,
    preferredWorkerId = null,
) {
    const existingCurrent = await getCurrentMusicTrack(
        kv,
        guildId,
    );

    if (existingCurrent) {
        const [currentWorker, currentJob] =
            await Promise.all([
                getMusicWorker(
                    kv,
                    existingCurrent.workerId,
                ),
                existingCurrent.jobId
                    ? getMusicJob(
                        kv,
                        existingCurrent.jobId,
                    )
                    : null,
            ]);

        const activeJobStatuses =
            new Set([
                'pending',
                'assigned',
                'received',
                'preparing',
                'playing',
            ]);

        const currentIsActive =
            Boolean(currentWorker) &&
            currentWorker.guildId === guildId &&
            currentWorker.status === 'busy' &&
            Boolean(currentJob) &&
            currentJob.type === 'play' &&
            activeJobStatuses.has(
                currentJob.status,
            );

        if (currentIsActive) {
            return {
                started: false,
                current: existingCurrent,
            };
        }

        console.warn(
            '[music-queue] stale current removed:',
            {
                guildId,
                workerId:
                    existingCurrent.workerId,
                jobId:
                    existingCurrent.jobId,
                workerStatus:
                    currentWorker?.status || null,
                jobStatus:
                    currentJob?.status || null,
            },
        );

        await kv.del(
            musicCurrentKey(guildId),
        );
    }


    const queueKey = musicQueueKey(guildId);
    let track = null;

    while (!track) {
        const raw = await kv.lPop(queueKey);

        if (!raw) {
            break;
        }

        try {
            track = JSON.parse(raw);
        } catch {
            track = null;
        }
    }

    if (!track) {
        if (preferredWorkerId) {
            await setMusicWorkerStatus(
                kv,
                preferredWorkerId,
                'idle',
            );
        }

        return {
            started: false,
            current: null,
        };
    }

    const worker = await chooseWorker(
        kv,
        guildId,
        preferredWorkerId || track.workerId,
    );

    if (!worker) {
        await kv.lPush(
            queueKey,
            JSON.stringify(track),
        );

        await kv.expire(
            queueKey,
            MUSIC_QUEUE_TTL_SECONDS,
        );

        return {
            started: false,
            current: null,
            reason: 'worker_not_found',
        };
    }

    const job = await createMusicJob(
        kv,
        {
            workerId: worker.workerId,
            guildId,
            voiceChannelId: track.voiceChannelId,
            textChannelId: track.textChannelId,
            requestedById: track.requestedById,
            url: track.url,
            volume: track.volume,
            type: 'play',
        },
    );

    const current = {
        ...track,
        workerId: worker.workerId,
        jobId: job.jobId,
        status: 'dispatching',
        startedAt: Date.now(),
    };

    await kv.set(
        musicCurrentKey(guildId),
        JSON.stringify(current),
        {
            EX: MUSIC_QUEUE_TTL_SECONDS,
        },
    );

    await setMusicWorkerStatus(
        kv,
        worker.workerId,
        'busy',
    );

    return {
        started: true,
        current,
        job,
    };
}

async function resumeGuildMusicQueue(
    kv,
    guildId,
    workerId,
) {
    return withGuildQueueLock(
        kv,
        guildId,
        async () =>
            dispatchNextMusicTrackUnlocked(
                kv,
                guildId,
                workerId,
            ),
    );
}

async function enqueueMusicTrack(
    kv,
    {
        guildId,
        voiceChannelId,
        textChannelId,
        requestedById,
        url,
        volume,
        title = null,
    },
) {
    return withGuildQueueLock(
        kv,
        guildId,
        async () => {
            const workers = await getOnlineMusicWorkers(
                kv,
                guildId,
            );

            if (workers.length === 0) {
                return {
                    ok: false,
                    reason: 'worker_not_found',
                };
            }

            const queueKey = musicQueueKey(guildId);
            const queuedCount = await kv.lLen(queueKey);

            if (queuedCount >= MAX_QUEUE_LENGTH) {
                return {
                    ok: false,
                    reason: 'queue_full',
                };
            }

            const current = await getCurrentMusicTrack(
                kv,
                guildId,
            );

            const preferredWorker =
                (current?.workerId &&
                    workers.find(
                        (worker) =>
                            worker.workerId ===
                            current.workerId,
                    )) ||
                workers.find(
                    (worker) =>
                        worker.status === 'busy',
                ) ||
                workers.find(
                    (worker) =>
                        worker.status === 'idle',
                ) ||
                workers[0];

            const track = {
                trackId: createTrackId(),
                guildId,
                workerId: preferredWorker.workerId,
                voiceChannelId,
                textChannelId,
                requestedById,
                url,
                title,
                volume,
                enqueuedAt: Date.now(),
            };

            await kv.rPush(
                queueKey,
                JSON.stringify(track),
            );

            await kv.expire(
                queueKey,
                MUSIC_QUEUE_TTL_SECONDS,
            );

            const dispatchResult =
                await dispatchNextMusicTrackUnlocked(
                    kv,
                    guildId,
                    preferredWorker.workerId,
                );

            const remainingCount = await kv.lLen(
                queueKey,
            );

            return {
                ok: true,
                track,
                started: dispatchResult.started,
                position: dispatchResult.started
                    ? 0
                    : remainingCount,
                worker: preferredWorker,
                current: dispatchResult.current,
            };
        },
    );
}

async function finishCurrentMusicTrack(
    kv,
    {
        guildId,
        jobId,
        workerId,
    },
) {
    return withGuildQueueLock(
        kv,
        guildId,
        async () => {
            const current =
                await getCurrentMusicTrack(
                    kv,
                    guildId,
                );

            /*
             * 現在曲が存在しない場合。
             *
             * 同じ完了通知が複数回来た可能性があるため、
             * 次曲配送やdisconnectは行わない。
             */
            if (!current) {
                console.warn(
                    '[music-queue] ' +
                    'finish ignored - no current track:',
                    {
                        guildId,
                        jobId,
                        workerId,
                    },
                );

                return {
                    started: false,
                    current: null,
                    ignored: true,
                    reason: 'current_not_found',
                };
            }

            /*
             * 完了通知のjobIdと現在曲のjobIdが違う場合。
             *
             * 古い曲の重複完了通知である可能性が高い。
             * 現在再生中の曲を保護するため、
             * 次曲配送もdisconnectも行わない。
             */
            if (
                !jobId ||
                current.jobId !== jobId
            ) {
                console.warn(
                    '[music-queue] ' +
                    'stale finish ignored:',
                    {
                        guildId,
                        receivedJobId:
                            jobId || null,
                        currentJobId:
                            current.jobId || null,
                        receivedWorkerId:
                            workerId || null,
                        currentWorkerId:
                            current.workerId || null,
                    },
                );

                return {
                    started: false,
                    current,
                    ignored: true,
                    reason: 'job_mismatch',
                };
            }

            /*
             * このWorkerが担当している現在曲だけを
             * 完了扱いにする。
             */
            if (
                workerId &&
                current.workerId &&
                current.workerId !== workerId
            ) {
                console.warn(
                    '[music-queue] ' +
                    'finish ignored - worker mismatch:',
                    {
                        guildId,
                        jobId,
                        receivedWorkerId:
                            workerId,
                        currentWorkerId:
                            current.workerId,
                    },
                );

                return {
                    started: false,
                    current,
                    ignored: true,
                    reason: 'worker_mismatch',
                };
            }

            /*
             * 正しい現在曲の完了通知なので削除する。
             */
            await kv.del(
                musicCurrentKey(guildId),
            );

            /*
             * 同じWorkerを優先して次曲を配送する。
             * 次曲がある場合、VC接続は維持する。
             */
            const nextResult =
                await dispatchNextMusicTrackUnlocked(
                    kv,
                    guildId,
                    current.workerId || workerId,
                );

            if (nextResult.started) {
                console.log(
                    '[music-queue] ' +
                    'next track dispatched - keep voice connected:',
                    {
                        guildId,
                        previousJobId:
                            jobId,
                        nextJobId:
                            nextResult.job?.jobId ||
                            null,
                        workerId:
                            nextResult.current
                                ?.workerId ||
                            current.workerId ||
                            workerId ||
                            null,
                    },
                );

                return nextResult;
            }

            /*
             * started === falseでも、何らかの理由で
             * 待機曲が残っている可能性がある。
             */
            const remainingTracks =
                await getQueuedMusicTracks(
                    kv,
                    guildId,
                );

            if (remainingTracks.length > 0) {
                console.log(
                    '[music-queue] ' +
                    'tracks remain - keep voice connected:',
                    {
                        guildId,
                        remaining:
                            remainingTracks.length,
                        reason:
                            nextResult.reason || null,
                    },
                );

                return nextResult;
            }

            /*
             * 正しい現在曲が終了し、
             * 次曲も待機曲も本当に存在しない場合だけ
             * VCから退出させる。
             */
            const disconnectWorkerId =
                current.workerId || workerId;

            if (disconnectWorkerId) {
                await createMusicJob(
                    kv,
                    {
                        workerId:
                            disconnectWorkerId,
                        guildId,
                        voiceChannelId:
                            current.voiceChannelId ||
                            null,
                        textChannelId:
                            current.textChannelId ||
                            null,
                        requestedById:
                            current.requestedById ||
                            null,
                        url: null,
                        type: 'disconnect',
                    },
                );

                console.log(
                    '[music-queue] ' +
                    'queue empty - disconnect:',
                    {
                        guildId,
                        workerId:
                            disconnectWorkerId,
                    },
                );
            }

            return nextResult;
        },
    );
}

async function releaseCurrentMusicTrack(
    kv,
    {
        guildId,
        jobId,
        workerId,
    },
) {
    return withGuildQueueLock(
        kv,
        guildId,
        async () => {
            const current = await getCurrentMusicTrack(
                kv,
                guildId,
            );

            if (
                current &&
                (!jobId || current.jobId === jobId)
            ) {
                await kv.del(
                    musicCurrentKey(guildId),
                );
            }

            if (workerId) {
                await setMusicWorkerStatus(
                    kv,
                    workerId,
                    'idle',
                );
            }

            return {
                current,
                queued:
                    await getQueuedMusicTracks(
                        kv,
                        guildId,
                    ),
            };
        },
    );
}

async function clearGuildMusicQueue(kv, guildId) {
    return withGuildQueueLock(
        kv,
        guildId,
        async () => {
            const current = await getCurrentMusicTrack(
                kv,
                guildId,
            );

            const queuedCount = await kv.lLen(
                musicQueueKey(guildId),
            );

            await Promise.all([
                kv.del(musicQueueKey(guildId)),
                kv.del(musicCurrentKey(guildId)),
            ]);

            return {
                current,
                queuedCount,
            };
        },
    );
}

module.exports = {
    MUSIC_QUEUE_TTL_SECONDS,
    MAX_QUEUE_LENGTH,
    enqueueMusicTrack,
    resumeGuildMusicQueue,
    getCurrentMusicTrack,
    getQueuedMusicTracks,
    getGuildMusicQueue,
    finishCurrentMusicTrack,
    releaseCurrentMusicTrack,
    clearGuildMusicQueue,
};
