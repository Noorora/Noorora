const { spawn } = require('child_process');

const {
    AudioPlayerStatus,
    StreamType,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
    VoiceConnectionStatus,
} = require('@discordjs/voice');

const ffmpegStatic = require('ffmpeg-static');

const guildPlayers = new Map();

function getYtDlpPath() {
    return process.env.YTDLP_PATH || 'yt-dlp';
}

function getFfmpegPath() {
    return process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
}

function formatDuration(seconds) {
    if (!seconds || Number.isNaN(Number(seconds))) {
        return '不明';
    }

    const total = Number(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;

    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function isAllowedUrl(url) {
    if (!/^https?:\/\//i.test(url)) {
        return false;
    }

    try {
        const parsed = new URL(url);

        return [
            'www.nicovideo.jp',
            'nico.ms',
            'sp.nicovideo.jp',
        ].includes(parsed.hostname);
    } catch {
        return false;
    }
}

async function getVideoInfo(url) {
    const ytDlpPath = getYtDlpPath();

    return new Promise((resolve, reject) => {
        const child = spawn(
            ytDlpPath,
            [
                '--no-playlist',
                '--dump-json',
                '--no-warnings',
                url,
            ],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        stderr || `yt-dlp が終了コード ${code} で終了しました。`,
                    ),
                );
                return;
            }

            try {
                const data = JSON.parse(stdout);

                resolve({
                    title: data.title || 'タイトル不明',
                    webpageUrl: data.webpage_url || url,
                    duration: data.duration || null,
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

function createAudioStream(url) {
    const ytDlpPath = getYtDlpPath();
    const ffmpegPath = getFfmpegPath();

    const ytdlp = spawn(
        ytDlpPath,
        [
            '--no-playlist',
            '-f',
            'bestaudio/best',
            '-o',
            '-',
            url,
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );

    ytdlp.on('error', (error) => {
        console.error('[music yt-dlp spawn error]', error);
    });

    ytdlp.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();

        if (text) {
            console.warn('[music yt-dlp]', text);
        }
    });

    const ffmpeg = spawn(
        ffmpegPath,
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            'pipe:0',
            '-f',
            's16le',
            '-ar',
            '48000',
            '-ac',
            '2',
            'pipe:1',
        ],
        {
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    );

    ffmpeg.on('error', (error) => {
        console.error('[music ffmpeg spawn error]', error);
    });

    ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();

        if (text) {
            console.warn('[music ffmpeg]', text);
        }
    });

    ytdlp.stdout.on('error', (error) => {
        console.error('[music yt-dlp stdout error]', error);
    });

    ffmpeg.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') {
            console.error('[music ffmpeg stdin error]', error);
        }
    });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.on('close', (code) => {
        if (code !== 0) {
            console.warn(`[music yt-dlp] exited with code ${code}`);
        }

        if (!ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.end();
        }
    });

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
    });

    if (resource.volume) {
        resource.volume.setVolume(0.45);
    }

    return {
        resource,
        ytdlp,
        ffmpeg,
    };
}

class GuildMusicPlayer {
    constructor(guildId) {
        this.guildId = guildId;
        this.queue = [];
        this.current = null;
        this.connection = null;
        this.audioPlayer = createAudioPlayer();
        this.textChannel = null;

        this.audioPlayer.on('stateChange', (oldState, newState) => {
            console.log(
                `[music] audio player state: ${oldState.status} -> ${newState.status}`,
            );
        });

        this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            this.cleanupCurrentProcesses();
            this.playNext().catch((error) => {
                console.error('[music] playNext error:', error);
                this.notifyTextChannel('次の曲の再生中にエラーが発生しました。');
            });
        });

        this.audioPlayer.on('error', (error) => {
            console.error('[music] audio player error:', error);
            this.notifyTextChannel('再生中にエラーが発生しました。次の曲へ進みます。');
            this.cleanupCurrentProcesses();
            this.playNext().catch((nextError) => {
                console.error('[music] playNext after error:', nextError);
            });
        });
    }

    async notifyTextChannel(content) {
        if (!this.textChannel) {
            return;
        }

        await this.textChannel.send({
            content,
            allowedMentions: {
                parse: [],
            },
        }).catch(() => null);
    }

    async ensureConnection(voiceChannel) {
        const existingConnection = getVoiceConnection(this.guildId);

        if (existingConnection) {
            this.connection = existingConnection;
            this.connection.subscribe(this.audioPlayer);
            return;
        }

        this.connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: true,
        });

        this.connection.on('stateChange', (oldState, newState) => {
            console.log(
                `[music] voice connection state: ${oldState.status} -> ${newState.status}`,
            );
        });

        this.connection.subscribe(this.audioPlayer);

        await entersState(
            this.connection,
            VoiceConnectionStatus.Ready,
            20_000,
        );
    }

    async enqueue(interaction, url) {
        if (!isAllowedUrl(url)) {
            return {
                ok: false,
                message:
                    '対応しているURLは、今のところニコニコ動画のURLのみです。\n' +
                    '例: https://www.nicovideo.jp/watch/smxxxxxxxx',
            };
        }

        const member = await interaction.guild.members
            .fetch(interaction.user.id)
            .catch(() => interaction.member ?? null);

        const voiceChannel = member?.voice?.channel;

        if (!voiceChannel) {
            return {
                ok: false,
                message: '先にボイスチャンネルに参加してください。',
            };
        }

        const info = await getVideoInfo(url).catch((error) => {
            console.error('[music] getVideoInfo error:', error);
            return null;
        });

        if (!info) {
            return {
                ok: false,
                message:
                    '動画情報の取得に失敗しました。\n' +
                    'Render 環境で yt-dlp が使えるか確認してください。\n' +
                    'Build Command と YTDLP_PATH を確認してください。',
            };
        }

        const track = {
            url,
            title: info.title,
            webpageUrl: info.webpageUrl,
            duration: info.duration,
            requestedById: interaction.user.id,
            ytdlp: null,
            ffmpeg: null,
        };

        this.textChannel = interaction.channel;

        await this.ensureConnection(voiceChannel);

        this.queue.push(track);

        const shouldStart =
            !this.current &&
            this.audioPlayer.state.status !== AudioPlayerStatus.Playing &&
            this.audioPlayer.state.status !== AudioPlayerStatus.Buffering;

        if (shouldStart) {
            await this.playNext();
        }

        return {
            ok: true,
            message:
                `キューに追加しました。\n` +
                `曲: ${track.title}\n` +
                `長さ: ${formatDuration(track.duration)}\n` +
                `リクエスト: <@${track.requestedById}>`,
        };
    }

    async playNext() {
        this.cleanupCurrentProcesses();

        const next = this.queue.shift();

        if (!next) {
            this.current = null;

            await this.notifyTextChannel('キューが空になりました。再生を終了します。');

            this.destroyConnection();
            return;
        }

        this.current = next;

        const {
            resource,
            ytdlp,
            ffmpeg,
        } = createAudioStream(next.url);

        next.ytdlp = ytdlp;
        next.ffmpeg = ffmpeg;

        this.audioPlayer.play(resource);

        await this.notifyTextChannel(
            `▶️ 再生開始: ${next.title}\n` +
            `URL: ${next.webpageUrl}\n` +
            `リクエスト: <@${next.requestedById}>`,
        );
    }

    skip() {
        if (!this.current) {
            return {
                ok: false,
                message: '現在再生中の曲はありません。',
            };
        }

        const skippedTitle = this.current.title;

        this.audioPlayer.stop(true);

        return {
            ok: true,
            message: `⏭️ スキップしました: ${skippedTitle}`,
        };
    }

    stop() {
        const hadCurrent = Boolean(this.current);
        const queuedCount = this.queue.length;

        this.queue = [];
        this.current = null;

        this.cleanupCurrentProcesses();
        this.audioPlayer.stop(true);
        this.destroyConnection();

        if (!hadCurrent && queuedCount === 0) {
            return {
                ok: false,
                message: '現在再生中の曲もキューもありません。',
            };
        }

        return {
            ok: true,
            message: '⏹️ 再生を停止し、キューを空にしました。',
        };
    }

    getQueueText() {
        const lines = [];

        lines.push('## 📋 Music キュー');
        lines.push('');

        if (this.current) {
            lines.push('### 再生中');
            lines.push(`・${this.current.title}`);
            lines.push(`  リクエスト: <@${this.current.requestedById}>`);
            lines.push('');
        } else {
            lines.push('### 再生中');
            lines.push('・なし');
            lines.push('');
        }

        if (this.queue.length === 0) {
            lines.push('### 待機中');
            lines.push('・なし');
            return lines.join('\n');
        }

        lines.push('### 待機中');

        this.queue.slice(0, 10).forEach((track, index) => {
            lines.push(`${index + 1}. ${track.title}`);
            lines.push(`   リクエスト: <@${track.requestedById}>`);
        });

        if (this.queue.length > 10) {
            lines.push('');
            lines.push(`ほか ${this.queue.length - 10} 件`);
        }

        return lines.join('\n');
    }

    cleanupCurrentProcesses() {
        if (!this.current) {
            return;
        }

        if (this.current.ytdlp && !this.current.ytdlp.killed) {
            this.current.ytdlp.kill('SIGKILL');
        }

        if (this.current.ffmpeg && !this.current.ffmpeg.killed) {
            this.current.ffmpeg.kill('SIGKILL');
        }
    }

    destroyConnection() {
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }
    }
}

function getMusicPlayer(guildId) {
    if (!guildPlayers.has(guildId)) {
        guildPlayers.set(
            guildId,
            new GuildMusicPlayer(guildId),
        );
    }

    return guildPlayers.get(guildId);
}

module.exports = {
    getMusicPlayer,
};