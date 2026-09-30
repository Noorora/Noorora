const {
    Client,
    GatewayIntentBits,
    Events,
} = require('discord.js');

const { createClient } = require('redis');
const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;

const DISABLE_DISCORD_LOGIN = process.env.DISABLE_DISCORD_LOGIN === 'true';

const { handleInteractionCreate } = require('./handlers/interactionCreate');
const { handleMessageCreate } = require('./handlers/messageCreate');
const { handleForwardEditRelay } = require('./events/forwardRelay');
const { handleForumThreadCreate } = require('./events/forumThreadCreate');
const { registerVoiceStateRelay } = require('./events/voiceStateRelay');

const {
    startRedisSyncService,
    syncRedisClientToUrl,
} = require('./services/redisSyncService');

if (process.env.RUN_ON_RENDER !== 'true') {
    console.log('ローカル実行は禁止されています。終了します。');
    process.exit(0);
}

const TOKEN = process.env.TOKEN;
const REDIS_URL = process.env.REDIS_URL;

if (!TOKEN) {
    console.error('TOKEN が設定されていません');
    process.exit(1);
}

if (!REDIS_URL) {
    console.error('REDIS_URL が設定されていません');
    process.exit(1);
}

const instanceMode =
    process.env.INSTANCE_MODE ||
    'render';

const isPcPrimary =
    instanceMode === 'pc';

const monitorPcPrimary =
    process.env.MONITOR_PC_PRIMARY ===
    'true';

const pcHeartbeatKey =
    process.env.PC_HEARTBEAT_KEY ||
    'autodetector:pc-primary';

const pcHeartbeatIntervalMs =
    Number(
        process.env
            .PC_HEARTBEAT_INTERVAL_MS ||
        10000,
    );

const pcHeartbeatTtlSeconds =
    Number(
        process.env
            .PC_HEARTBEAT_TTL_SECONDS ||
        30,
    );

const pcTakeoverDelayMs =
    Number(
        process.env
            .PC_TAKEOVER_DELAY_MS ||
        15000,
    );

let pcHeartbeatTimer = null;
let pcMonitorTimer = null;
let isShuttingDown = false;

const isFailoverSub = process.env.FAILOVER_SUB === 'true';
const primaryHealthUrl = process.env.PRIMARY_HEALTH_URL || '';

const failoverCheckIntervalMs = Number(
    process.env.FAILOVER_CHECK_INTERVAL_MS || 30000,
);

const failoverFailureThreshold = Number(
    process.env.FAILOVER_FAILURE_THRESHOLD || 2,
);

const syncFromMainRedis = process.env.SYNC_FROM_MAIN_REDIS === 'true';
const mainRedisUrl = process.env.MAIN_REDIS_URL || '';

const redisSyncIntervalMs = Number(
    process.env.REDIS_SYNC_INTERVAL_MS || 300000,
);

const redisSyncDeleteStaleKeys =
    process.env.REDIS_SYNC_DELETE_STALE_KEYS === 'true';

const syncSubToMainOnFailback =
    process.env.SYNC_SUB_TO_MAIN_ON_FAILBACK === 'true';

const kv = createClient({
    url: REDIS_URL,
});

kv.on('error', (error) => {
    console.error('Key Value 接続エラー:', error);
});

let client = null;
let context = null;
let botState = 'stopped';
let isStarting = false;
let isStopping = false;
let isFailbackSyncing = false;
let primaryFailureCount = 0;

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.get('/', (req, res) => {
    res.send('Bot is running');
});

app.get('/health', (req, res) => {
    if (isFailoverSub) {
        res.status(200).send('ok');
        return;
    }

    if (botState === 'running') {
        res.status(200).send('ok');
        return;
    }

    res.status(503).send(`not ready: ${botState}`);
});

app.get('/status', (req, res) => {
    res.status(200).json({
        ok: true,
        failoverSub: isFailoverSub,
        botState,
        primaryHealthUrl: primaryHealthUrl || null,
        primaryFailureCount,
        syncFromMainRedis,
        syncSubToMainOnFailback,
        mainRedisConfigured: Boolean(mainRedisUrl),
    });
});

function createDiscordClient() {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildExpressions,
            GatewayIntentBits.GuildVoiceStates,
        ],
    });
}

async function checkDiscordConnectivity(token) {
    console.log('[discord preflight] start');

    try {
        const discordCom = await dns.lookup('discord.com');
        console.log('[discord preflight] discord.com dns:', discordCom.address, discordCom.family);
    } catch (error) {
        console.error('[discord preflight] discord.com dns error:', error);
    }

    try {
        const gatewayHost = await dns.lookup('gateway.discord.gg');
        console.log('[discord preflight] gateway.discord.gg dns:', gatewayHost.address, gatewayHost.family);
    } catch (error) {
        console.error('[discord preflight] gateway.discord.gg dns error:', error);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch('https://discord.com/api/v10/gateway/bot', {
            method: 'GET',
            headers: {
                Authorization: `Bot ${token}`,
            },
            signal: controller.signal,
        });

        console.log('[discord preflight] gateway/bot status:', response.status);

        const text = await response.text();
        console.log('[discord preflight] gateway/bot body:', text.slice(0, 500));
    } catch (error) {
        console.error('[discord preflight] gateway/bot error:', error);
    } finally {
        clearTimeout(timeout);
    }

    console.log('[discord preflight] end');
}

async function startDiscordBot(reason = 'start requested') {
    if (client || isStarting) {
        return;
    }

    isStarting = true;
    botState = 'starting';

    if (DISABLE_DISCORD_LOGIN) {
        console.log('Discord login is disabled by DISABLE_DISCORD_LOGIN=true');
        botState = 'stopped';
        return;
    }

    try {
        client = createDiscordClient();

        context = {
            client,
            kv,
        };

        client.on('debug', (message) => {
            console.log('[discord.js debug]', message);
        });

        client.on('shardError', (error, shardId) => {
            console.error('[discord.js shardError]', shardId, error);
        });

        client.on('warn', (message) => {
            console.warn('[discord.js warn]', message);
        });

        client.once(Events.ClientReady, (readyClient) => {
            botState = 'running';
            console.log(`ログイン完了: ${readyClient.user.tag}`);
        });

        client.on('error', (error) => {
            console.error('Discord client error:', error);
        });

        client.on('warn', (message) => {
            console.warn('Discord client warn:', message);
        });

        client.on('shardError', (error) => {
            console.error('Discord shard error:', error);
        });

        client.on('shardDisconnect', (event, shardId) => {
            console.warn('Discord shard disconnect:', {
                shardId,
                code: event.code,
                reason: event.reason,
            });
        });

        client.on('shardReconnecting', (shardId) => {
            console.warn('Discord shard reconnecting:', shardId);
        });

        client.on('shardReady', (shardId) => {
            console.log('Discord shard ready:', shardId);
        });

        client.on(
            Events.InteractionCreate,
            (interaction) => handleInteractionCreate(interaction, context),
        );

        client.on(
            Events.MessageCreate,
            (message) => handleMessageCreate(message, context),
        );

        client.on(
            Events.MessageUpdate,
            (oldMessage, newMessage) => handleForwardEditRelay(
                oldMessage,
                newMessage,
                context,
            ),
        );

        client.on(
            Events.ThreadCreate,
            (thread) => handleForumThreadCreate(thread, context),
        );

        registerVoiceStateRelay(client, kv);

        console.log(`Discord Bot を起動します: ${reason}`);

        console.log('DISCORD_TOKEN exists:', !!process.env.DISCORD_TOKEN);
        console.log('TOKEN exists:', !!process.env.TOKEN);
        console.log('TOKEN variable exists:', !!TOKEN);
        console.log('TOKEN length:', TOKEN ? TOKEN.length : 0);
        console.log(
            'TOKEN fingerprint:',
            TOKEN ? crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 12) : 'none'
        );

        await checkDiscordConnectivity(TOKEN);

        await Promise.race([
            client.login(TOKEN),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error('Discord login timeout'));
                }, 30000);
            }),
        ]);
    } catch (error) {
        console.error('Discord Bot 起動エラー:', error);

        if (client) {
            client.destroy();
        }

        client = null;
        context = null;
        botState = 'stopped';
    } finally {
        isStarting = false;
    }
}

async function stopDiscordBot(reason = 'stop requested') {
    if (!client || isStopping) {
        return;
    }

    isStopping = true;
    botState = 'stopping';

    try {
        console.log(`Discord Bot を停止します: ${reason}`);

        client.destroy();

        client = null;
        context = null;
        botState = 'standby';
    } catch (error) {
        console.error('Discord Bot 停止エラー:', error);

        client = null;
        context = null;
        botState = 'standby';
    } finally {
        isStopping = false;
    }
}

async function checkPrimaryHealth() {
    if (!primaryHealthUrl) {
        return false;
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 8000);

    try {
        const response = await fetch(primaryHealthUrl, {
            method: 'GET',
            signal: controller.signal,
        });

        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(
            resolve,
            milliseconds,
        );
    });
}

async function writePcHeartbeat() {
    const heartbeatValue =
        JSON.stringify({
            instance: 'pc',
            processId: process.pid,
            updatedAt:
                new Date().toISOString(),
        });

    await kv.set(
        pcHeartbeatKey,
        heartbeatValue,
        {
            EX:
                pcHeartbeatTtlSeconds,
        },
    );
}

async function startPcHeartbeat() {
    if (pcHeartbeatTimer) {
        return;
    }

    await writePcHeartbeat();

    console.log(
        `[pc-primary] ` +
        `ハートビートを開始しました。` +
        `key=${pcHeartbeatKey} / ` +
        `ttl=${pcHeartbeatTtlSeconds}秒`,
    );

    pcHeartbeatTimer =
        setInterval(() => {
            writePcHeartbeat()
                .catch((error) => {
                    console.error(
                        '[pc-primary] ' +
                        'ハートビート更新エラー:',
                        error,
                    );
                });
        }, pcHeartbeatIntervalMs);
}

async function stopPcHeartbeat() {
    if (pcHeartbeatTimer) {
        clearInterval(
            pcHeartbeatTimer,
        );

        pcHeartbeatTimer = null;
    }

    await kv.del(
        pcHeartbeatKey,
    ).catch(() => null);

    console.log(
        '[pc-primary] ' +
        'ハートビートを停止しました。',
    );
}

async function isPcPrimaryAlive() {
    const exists =
        await kv.exists(
            pcHeartbeatKey,
        );

    return exists === 1;
}

async function evaluatePcPrimary() {
    if (
        !monitorPcPrimary ||
        isPcPrimary ||
        isShuttingDown
    ) {
        return;
    }

    const pcIsAlive =
        await isPcPrimaryAlive();

    if (pcIsAlive) {
        if (client) {
            await stopDiscordBot(
                'PC版AutoDetectorが起動したため',
            );
        } else {
            botState = 'standby';
        }

        return;
    }

    if (!client) {
        await startDiscordBot(
            'PC版AutoDetectorが停止しているため',
        );
    }
}

function startPcPrimaryMonitor() {
    if (
        !monitorPcPrimary ||
        isPcPrimary ||
        pcMonitorTimer
    ) {
        return;
    }

    console.log(
        '[pc-monitor] ' +
        'PC版AutoDetectorの監視を開始します。',
    );

    pcMonitorTimer =
        setInterval(() => {
            evaluatePcPrimary()
                .catch((error) => {
                    console.error(
                        '[pc-monitor] ' +
                        '監視エラー:',
                        error,
                    );
                });
        }, 5000);
}

async function syncSubRedisToMainRedis() {
    if (!syncSubToMainOnFailback) {
        return true;
    }

    if (!mainRedisUrl) {
        console.warn(
            '[redis-failback] SYNC_SUB_TO_MAIN_ON_FAILBACK=true ですが MAIN_REDIS_URL が設定されていません。',
        );

        return false;
    }

    if (isFailbackSyncing) {
        return false;
    }

    isFailbackSyncing = true;

    try {
        console.log('[redis-failback] Sub Redis から Main Redis へ書き戻します。');

        const result = await syncRedisClientToUrl({
            sourceRedisClient: kv,
            targetRedisUrl: mainRedisUrl,
            deleteStaleKeys: redisSyncDeleteStaleKeys,
            label: 'redis-failback',
        });

        if (!result.ok) {
            console.warn(
                `[redis-failback] 書き戻しを完了できませんでした。reason=${result.reason}`,
            );

            return false;
        }

        console.log(
            `[redis-failback] 書き戻し完了 copied=${result.copied}, deleted=${result.deleted}, skipped=${result.skipped}`,
        );

        return true;
    } catch (error) {
        console.warn(
            '[redis-failback] 書き戻し失敗:',
            error.message,
        );

        return false;
    } finally {
        isFailbackSyncing = false;
    }
}

async function evaluateFailover() {
    const primaryIsHealthy = await checkPrimaryHealth();

    if (primaryIsHealthy) {
        primaryFailureCount = 0;

        if (client) {
            const synced = await syncSubRedisToMainRedis();

            if (!synced && syncSubToMainOnFailback) {
                console.warn(
                    '[failover] Main復旧を検知しましたが、Sub RedisからMain Redisへの書き戻しに失敗したため、Sub Botを停止しません。',
                );

                return;
            }

            await stopDiscordBot('メインBotが復旧したため');
        } else {
            botState = 'standby';
        }

        return;
    }

    primaryFailureCount += 1;

    if (primaryFailureCount < failoverFailureThreshold) {
        botState = client ? 'running' : 'standby';
        return;
    }

    if (!client) {
        await startDiscordBot('メインBotが停止しているためサブBotが起動');
    }
}

async function startMainProcess() {
    await kv.connect();

    startRedisSyncService({
        enabled: syncFromMainRedis,
        sourceRedisUrl: mainRedisUrl,
        targetRedisClient: kv,
        getBotState: () => botState,
        intervalMs: redisSyncIntervalMs,
        deleteStaleKeys: redisSyncDeleteStaleKeys,
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`HTTP server listening on ${PORT}`);
    });

    if (isPcPrimary) {
        console.log(
            '[pc-primary] ' +
            'PC版として起動します。',
        );

        await startPcHeartbeat();

        console.log(
            '[pc-primary] ' +
            'Render版の待機切り替えを待ちます。',
        );

        await sleep(
            pcTakeoverDelayMs,
        );

        await startDiscordBot(
            'PC版AutoDetectorとして起動',
        );

        return;
    }

    if (monitorPcPrimary) {
        console.log(
            '[pc-monitor] ' +
            'Render待機版として起動します。',
        );

        await evaluatePcPrimary();

        startPcPrimaryMonitor();

        return;
    }

    if (!isFailoverSub) {
        await startDiscordBot('通常起動');
        return;
    }

    if (!primaryHealthUrl) {
        console.error('FAILOVER_SUB=true ですが PRIMARY_HEALTH_URL が設定されていません。');
        botState = 'standby';
        return;
    }

    console.log('フェイルオーバーサブとして起動しました。');
    console.log(`監視対象: ${primaryHealthUrl}`);

    await evaluateFailover();

    setInterval(() => {
        evaluateFailover().catch((error) => {
            console.error('フェイルオーバー確認エラー:', error);
        });
    }, failoverCheckIntervalMs);
}

async function shutdownProcess(
    signal,
) {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;

    console.log(
        `終了処理を開始します: ${signal}`,
    );

    /*
     * Render版のPC監視タイマーを停止する。
     */
    if (pcMonitorTimer) {
        clearInterval(
            pcMonitorTimer,
        );

        pcMonitorTimer = null;
    }

    /*
     * PC版のハートビート更新タイマーを停止する。
     */
    if (pcHeartbeatTimer) {
        clearInterval(
            pcHeartbeatTimer,
        );

        pcHeartbeatTimer = null;
    }

    /*
     * Discordへ接続中なら、
     * Discordクライアントを停止する。
     */
    if (client) {
        await stopDiscordBot(
            `${signal}を受信したため`,
        );
    }

    /*
     * PC版の場合はRedis上の
     * ハートビートを削除する。
     *
     * このキーが消えると、
     * Render版がDiscordへ復帰する。
     */
    if (isPcPrimary) {
        await stopPcHeartbeat();
    }

    /*
     * Redisへの接続を正常終了する。
     */
    if (kv.isOpen) {
        await kv.quit()
            .catch((error) => {
                console.error(
                    'Key Value終了処理エラー:',
                    error,
                );
            });
    }

    console.log(
        'AutoDetectorの終了処理が完了しました。',
    );

    process.exit(0);
}

process.once(
    'SIGINT',
    () => {
        shutdownProcess(
            'SIGINT',
        ).catch((error) => {
            console.error(
                'SIGINT終了処理エラー:',
                error,
            );

            process.exit(1);
        });
    },
);

process.once(
    'SIGTERM',
    () => {
        shutdownProcess(
            'SIGTERM',
        ).catch((error) => {
            console.error(
                'SIGTERM終了処理エラー:',
                error,
            );

            process.exit(1);
        });
    },
);

startMainProcess().catch((error) => {
    console.error('起動時エラー:', error);
    process.exit(1);
});