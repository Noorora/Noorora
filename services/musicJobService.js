const crypto = require('crypto');

const {
    musicWorkerJobsKey,
    musicJobKey,
} = require('../keys/redisKeys');

/* 長い曲でも完了通知までJob本体を保持する。 */
const MUSIC_JOB_TTL_SECONDS = 6 * 60 * 60;

function createMusicJobId() {
    return crypto.randomBytes(32).toString('hex');
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
    const jobId = createMusicJobId();
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

    await kv.rPush(
        musicWorkerJobsKey(workerId),
        jobId,
    );

    await kv.expire(
        musicWorkerJobsKey(workerId),
        MUSIC_JOB_TTL_SECONDS,
    );

    return job;
}

async function takeNextMusicJob(kv, workerId) {
    while (true) {
        const jobId = await kv.lPop(
            musicWorkerJobsKey(workerId),
        );

        if (!jobId) {
            return null;
        }

        const raw = await kv.get(
            musicJobKey(jobId),
        );

        if (!raw) {
            continue;
        }

        let job;

        try {
            job = JSON.parse(raw);
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
    const key = musicJobKey(jobId);
    const raw = await kv.get(key);

    if (!raw) {
        return null;
    }

    let job;

    try {
        job = JSON.parse(raw);
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

async function getMusicJob(kv, jobId) {
    const raw = await kv.get(
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

module.exports = {
    MUSIC_JOB_TTL_SECONDS,
    createMusicJob,
    takeNextMusicJob,
    updateMusicJobStatus,
    getMusicJob,
};
