const crypto = require('crypto');

const {
    musicWorkerJobsKey,
    musicJobKey,
} = require('../keys/redisKeys');

const MUSIC_JOB_TTL_SECONDS =
    5 * 60;

function createMusicJobId() {
    return crypto
        .randomBytes(32)
        .toString('hex');
}

async function createMusicJob(
    kv,
    {
        workerId,
        guildId,
        voiceChannelId,
        textChannelId,
        requestedById,
        url,
        volume = 0.2,
        type = 'play',
    },
) {
    const jobId =
        createMusicJobId();

    const job = {
        jobId,
        workerId,
        guildId,
        voiceChannelId,
        textChannelId,
        requestedById,
        url,
        volume,
        type,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    await kv.set(
        musicJobKey(jobId),
        JSON.stringify(job),
        {
            EX: MUSIC_JOB_TTL_SECONDS,
        },
    );

    /*
     * Workerごとの待機キュー。
     * rPushしてlPopするためFIFOになる。
     */
    await kv.rPush(
        musicWorkerJobsKey(workerId),
        jobId,
    );

    /*
     * キュー自体も古い状態で残さない。
     */
    await kv.expire(
        musicWorkerJobsKey(workerId),
        MUSIC_JOB_TTL_SECONDS,
    );

    return job;
}

async function takeNextMusicJob(
    kv,
    workerId,
) {
    while (true) {
        const jobId =
            await kv.lPop(
                musicWorkerJobsKey(workerId),
            );

        if (!jobId) {
            return null;
        }

        const raw =
            await kv.get(
                musicJobKey(jobId),
            );

        /*
         * TTL切れなどで本体が無ければ、
         * 次のジョブを確認する。
         */
        if (!raw) {
            continue;
        }

        let job;

        try {
            job =
                JSON.parse(raw);
        } catch {
            await kv.del(
                musicJobKey(jobId),
            );

            continue;
        }

        job.status = 'assigned';
        job.updatedAt = Date.now();

        await kv.set(
            musicJobKey(jobId),
            JSON.stringify(job),
            {
                EX: MUSIC_JOB_TTL_SECONDS,
            },
        );

        return job;
    }
}

async function updateMusicJobStatus(
    kv,
    jobId,
    status,
    detail = null,
) {
    const key =
        musicJobKey(jobId);

    const raw =
        await kv.get(key);

    if (!raw) {
        return null;
    }

    let job;

    try {
        job =
            JSON.parse(raw);
    } catch {
        return null;
    }

    job.status = status;
    job.detail = detail;
    job.updatedAt = Date.now();

    await kv.set(
        key,
        JSON.stringify(job),
        {
            EX: MUSIC_JOB_TTL_SECONDS,
        },
    );

    return job;
}

async function getMusicJob(
    kv,
    jobId,
) {
    const raw =
        await kv.get(
            musicJobKey(jobId),
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

async function getGuildMusicJobs(
    kv,
    guildId,
) {
    const keys =
        await kv.keys(
            'music-job:*',
        );

    console.log(
        '[music queue] guildId:',
        guildId,
        'keys:',
        keys,
    );

    const jobs = [];

    for (const key of keys) {
        const raw =
            await kv.get(key);

        if (!raw) {
            continue;
        }

        let job;

        try {
            job =
                JSON.parse(raw);
        } catch {
            continue;
        }

        console.log(
            '[music queue] inspecting job:',
            {
                jobId:
                    job.jobId,
                guildId:
                    job.guildId,
                guildIdType:
                    typeof job.guildId,
                requestedGuildId:
                    guildId,
                requestedGuildIdType:
                    typeof guildId,
                type:
                    job.type,
                status:
                    job.status,
                url:
                    job.url,
            },
        );

        if (
            job.guildId !==
            guildId
        ) {
            continue;
        }

        if (
            job.type !== 'play'
        ) {
            continue;
        }

        if (
            job.status !== 'pending' &&
            job.status !== 'assigned'
        ) {
            continue;
        }

        jobs.push(job);
    }

    jobs.sort(
        (a, b) =>
            a.createdAt -
            b.createdAt,
    );

    console.log(
        '[music queue] matched jobs:',
        jobs,
    );

    return jobs;
}

module.exports = {
    MUSIC_JOB_TTL_SECONDS,
    createMusicJob,
    takeNextMusicJob,
    updateMusicJobStatus,
    getMusicJob,
    getGuildMusicJobs,
};
