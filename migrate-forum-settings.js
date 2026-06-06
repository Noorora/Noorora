const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
const DELETE_OLD = process.env.DELETE_OLD === 'true';

if (!REDIS_URL) {
  console.error('REDIS_URL が設定されていません');
  process.exit(1);
}

function oldForumMapKeyPrefix() {
  return 'forum-log-map:';
}

function forumTargetsKey(guildId, forumId) {
  return `forum-targets:${guildId}:${forumId}`;
}

function forumIndexKey(guildId) {
  return `forum-index:${guildId}`;
}

async function main() {
  const kv = createClient({ url: REDIS_URL });

  kv.on('error', (error) => {
    console.error('Key Value 接続エラー:', error);
  });

  await kv.connect();

  let guildCount = 0;
  let mappingCount = 0;
  let oldKeyCount = 0;

  try {
    console.log('旧形式のフォーラム通知設定を検索中...');

    for await (const key of kv.scanIterator({ MATCH: `${oldForumMapKeyPrefix()}*`, COUNT: 100 })) {
      oldKeyCount += 1;

      if (!key.startsWith(oldForumMapKeyPrefix())) {
        continue;
      }

      const guildId = key.slice(oldForumMapKeyPrefix().length);
      if (!guildId) {
        console.warn(`guildId を取り出せなかったためスキップ: ${key}`);
        continue;
      }

      const oldMappings = await kv.hGetAll(key);
      const entries = Object.entries(oldMappings);

      if (entries.length === 0) {
        console.log(`設定が空のためスキップ: ${key}`);
        continue;
      }

      guildCount += 1;
      console.log(`\n[Guild ${guildId}] ${entries.length} 件の旧設定を移行します`);

      for (const [forumId, targetId] of entries) {
        await kv.sAdd(forumTargetsKey(guildId, forumId), targetId);
        await kv.sAdd(forumIndexKey(guildId), forumId);
        mappingCount += 1;
        console.log(`  - forum ${forumId} -> target ${targetId}`);
      }

      if (DELETE_OLD) {
        await kv.del(key);
        console.log(`旧キーを削除しました: ${key}`);
      }
    }

    console.log('\n===== 移行完了 =====');
    console.log(`見つかった旧キー数: ${oldKeyCount}`);
    console.log(`移行した guild 数: ${guildCount}`);
    console.log(`移行した設定数: ${mappingCount}`);

    if (!DELETE_OLD) {
      console.log('旧キーは削除していません。削除したい場合は DELETE_OLD=true を付けて再実行してください。');
    }
  } catch (error) {
    console.error('移行中にエラーが発生しました:', error);
    process.exitCode = 1;
  } finally {
    await kv.quit().catch(() => null);
  }
}

main();
