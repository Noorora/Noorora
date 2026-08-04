const { createClient } = require('redis');

const SOURCE_REDIS_URL = process.env.SOURCE_REDIS_URL;
const TARGET_REDIS_URL = process.env.TARGET_REDIS_URL;

if (!SOURCE_REDIS_URL) {
    console.error('SOURCE_REDIS_URL が設定されていません');
    process.exit(1);
}

if (!TARGET_REDIS_URL) {
    console.error('TARGET_REDIS_URL が設定されていません');
    process.exit(1);
}

async function copyRedis() {
    const source = createClient({
        url: SOURCE_REDIS_URL,
    });

    const target = createClient({
        url: TARGET_REDIS_URL,
    });

    source.on('error', (error) => {
        console.error('Source Redis error:', error);
    });

    target.on('error', (error) => {
        console.error('Target Redis error:', error);
    });

    await source.connect();
    await target.connect();

    let cursor = '0';
    let copied = 0;
    let skipped = 0;

    do {
        const result = await source.scan(cursor, {
            COUNT: 100,
        });

        cursor = result.cursor;

        for (const key of result.keys) {
            const type = await source.type(key);

            await target.del(key);

            if (type === 'string') {
                const value = await source.get(key);

                if (value !== null) {
                    await target.set(key, value);
                }

                copied += 1;
                continue;
            }

            if (type === 'hash') {
                const value = await source.hGetAll(key);

                if (Object.keys(value).length > 0) {
                    await target.hSet(key, value);
                }

                copied += 1;
                continue;
            }

            if (type === 'set') {
                const values = await source.sMembers(key);

                if (values.length > 0) {
                    await target.sAdd(key, values);
                }

                copied += 1;
                continue;
            }

            if (type === 'list') {
                const values = await source.lRange(key, 0, -1);

                if (values.length > 0) {
                    await target.rPush(key, values);
                }

                copied += 1;
                continue;
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
                }

                copied += 1;
                continue;
            }

            console.warn(`未対応の型のためスキップ: ${key} (${type})`);
            skipped += 1;
        }
    } while (cursor !== '0');

    await source.quit();
    await target.quit();

    console.log(`コピー完了: ${copied} keys`);
    console.log(`スキップ: ${skipped} keys`);
}

copyRedis().catch((error) => {
    console.error('コピー中にエラー:', error);
    process.exit(1);
});