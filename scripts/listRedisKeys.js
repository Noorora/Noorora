const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;

async function main() {
    const client = createClient({
        url: REDIS_URL,
    });

    await client.connect();

    let cursor = '0';

    do {
        const result = await client.scan(cursor, {
            COUNT: 100,
        });

        cursor = result.cursor;

        for (const key of result.keys) {
            const type = await client.type(key);

            console.log(`${type} ${key}`);
        }
    } while (cursor !== '0');

    await client.quit();
}

main().catch(console.error);