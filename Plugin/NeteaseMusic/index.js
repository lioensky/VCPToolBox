const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const api = require('NeteaseCloudMusicApi');

function downloadFile(url, targetPath) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            return reject(new Error(`Invalid download URL: ${url}`));
        }

        const client = parsed.protocol === 'http:' ? http : https;
        const req = client.get(parsed, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, parsed.origin).toString();
                return downloadFile(redirectUrl, targetPath).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
            }

            const fileStream = fs.createWriteStream(targetPath);
            res.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve(targetPath);
            });

            fileStream.on('error', err => {
                fs.unlink(targetPath, () => {});
                reject(err);
            });
        });

        req.on('error', reject);
    });
}

function compressAudio(inputPath, outputPath, durationSeconds = 60) {
    return new Promise((resolve, reject) => {
        const ffmpegPath = 'D:\\327AI-VCP\\VCPToolBox\\Plugin\\VideoAnalyzer\\yt-dlp\\ffmpeg.exe';
        const args = [
            '-y',
            '-i', inputPath,
            '-t', String(durationSeconds),
            '-ac', '1',
            '-b:a', '48k',
            outputPath
        ];
        execFile(ffmpegPath, args, (error, stdout, stderr) => {
            if (error) {
                return reject(error);
            }
            resolve(outputPath);
        });
    });
}

function loadMainConfig() {
    const mainConfig = {
        API_Key: process.env.API_Key,
        API_URL: process.env.API_URL,
        MultiModalModel: process.env.MultiModalModel,
        MultiModalModelChain: process.env.MultiModalModelChain
    };

    if (!mainConfig.API_Key || !mainConfig.API_URL) {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf8');
                content.split(/\r?\n/).forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return;
                    const index = trimmed.indexOf('=');
                    if (index > 0) {
                        const key = trimmed.substring(0, index).trim();
                        const val = trimmed.substring(index + 1).trim();
                        const cleanVal = val.replace(/^["']|["']$/g, '');
                        if (['API_Key', 'API_URL', 'MultiModalModel', 'MultiModalModelChain'].includes(key)) {
                            mainConfig[key] = cleanVal;
                        }
                    }
                });
            }
        } catch (e) {
            log('warn', `Failed to parse main config.env: ${e.message}`);
        }
    }

    if (!mainConfig.MultiModalModel) {
        mainConfig.MultiModalModel = 'gemini-2.5-flash-lite';
    }

    return mainConfig;
}

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    keepAliveMsecs: 10000
});

function log(level, message, data = null) {
    const logObj = { timestamp: new Date().toISOString(), level, message, data };
    console.error(JSON.stringify(logObj));
}

function clampNumber(value, fallback, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function pickArg(args, names) {
    for (const name of names) {
        if (args[name] !== undefined && args[name] !== null && args[name] !== '') {
            return args[name];
        }
    }
    return undefined;
}

function normalizePicUrl(url) {
    if (!url) return null;
    return String(url).replace(/^http:\/\//i, 'https://');
}

function formatLocalDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function toSongIdList(value) {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) {
        return value.flatMap(toSongIdList);
    }
    const text = String(value);
    if (/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(text)) {
        return text.split(',').map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function extractUrls(text) {
    if (!text) return [];
    const matches = String(text).match(/https?:\/\/[^\s<>"'，。；、）)]+/gi);
    return matches ? matches.map(url => url.replace(/[)\]）】。,.，]+$/g, '')) : [];
}

function extractSongIdsFromText(text) {
    if (!text) return [];
    const ids = new Set();
    const raw = String(text);
    const candidates = [raw];
    try {
        candidates.push(decodeURIComponent(raw));
    } catch (_) {
        // Some shared text is not valid URI-encoded content.
    }

    for (const candidate of candidates) {
        for (const pattern of [
            /music\.163\.com\/(?:#\/)?(?:m\/)?song\?[^#\s]*?\bid=(\d{5,})/gi,
            /\/song\/(\d{5,})/gi,
            /\bsongId["'=:\s]+(\d{5,})/gi,
            /\btrackId["'=:\s]+(\d{5,})/gi
        ]) {
            let match;
            while ((match = pattern.exec(candidate)) !== null) {
                ids.add(match[1]);
            }
        }
    }

    return [...ids];
}

function resolveHttpUrl(url, maxRedirects = 6) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        const client = parsed.protocol === 'http:' ? http : https;
        const req = client.request(parsed, {
            method: 'GET',
            timeout: 12000,
            headers: {
                'User-Agent': 'Mozilla/5.0 VCPToolBox NeteaseMusic/1.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        }, res => {
            const location = res.headers.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && location) {
                res.resume();
                if (maxRedirects <= 0) {
                    reject(new Error(`Too many redirects while resolving ${url}`));
                    return;
                }
                const nextUrl = new URL(location, parsed).toString();
                resolve(resolveHttpUrl(nextUrl, maxRedirects - 1));
                return;
            }

            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (body.length < 30000) body += chunk;
            });
            res.on('end', () => {
                resolve({ finalUrl: parsed.toString(), statusCode: res.statusCode, body });
            });
        });

        req.on('timeout', () => req.destroy(new Error(`Timed out resolving ${url}`)));
        req.on('error', reject);
        req.end();
    });
}

async function callApi(method, params, timeoutMs = 90000) {
    let timer;
    const apiParams = {
        ...params,
        httpAgent: httpsAgent,
        httpsAgent: httpsAgent
    };

    try {
        return await Promise.race([
            method(apiParams),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`API call timed out after ${timeoutMs}ms`)), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function loadCookie(config) {
    let cookie = config.NETEASE_COOKIE || process.env.NETEASE_COOKIE || '';
    if (cookie) return cookie;

    const cookieFiles = ['music.163.com_cookies.txt', 'cookies.txt'];
    for (const file of cookieFiles) {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) continue;

        try {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (!content) continue;

            if (content.includes('=') && !content.includes('\t')) {
                log('info', `Loaded raw cookie from ${file}`);
                return content.replace(/\r?\n/g, '; ');
            }

            const cookies = [];
            content.split(/\r?\n/).forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;
                const parts = trimmed.split('\t');
                if (parts.length >= 7) {
                    cookies.push(`${parts[5]}=${parts[6]}`);
                }
            });

            if (cookies.length > 0) {
                log('info', `Loaded Netscape cookie from ${file}`);
                return cookies.join('; ');
            }
        } catch (error) {
            log('warn', `Failed to read cookie file ${file}: ${error.message}`);
        }
    }

    return '';
}

function simplifyArtist(artist) {
    if (!artist) return null;
    return {
        id: artist.id,
        name: artist.name,
        alias: artist.alias || artist.alia || []
    };
}

function simplifyAlbum(album) {
    if (!album) return null;
    const coverUrl = normalizePicUrl(album.picUrl || album.coverUrl || album.blurPicUrl);
    return {
        id: album.id,
        name: album.name,
        picUrl: coverUrl,
        coverUrl,
        size: album.size
    };
}

function simplifySong(song, extra = {}) {
    if (!song) return null;
    const artists = (song.ar || song.artists || []).map(simplifyArtist).filter(Boolean);
    const artistNames = artists.map(artist => artist.name).filter(Boolean);
    const album = simplifyAlbum(song.al || song.album);
    const coverUrl = normalizePicUrl(song.coverUrl || song.picUrl || (album && album.coverUrl));
    const id = song.id || song.songId;

    const simplified = {
        id,
        name: song.name,
        artists,
        artistNames,
        artistText: artistNames.join('/'),
        album,
        albumName: album ? album.name : null,
        coverUrl,
        webUrl: id ? `https://music.163.com/#/song?id=${id}` : null,
        duration: song.dt || song.duration,
        durationMs: song.dt || song.duration,
        fee: song.fee,
        publishTime: song.publishTime || song.publish_time,
        tns: song.tns || song.transNames || [],
        alia: song.alia || song.alias || []
    };

    if (extra.reason !== undefined) simplified.reason = extra.reason;
    if (extra.liked !== undefined) simplified.liked = extra.liked;
    if (extra.inPlaylists !== undefined) simplified.inPlaylists = extra.inPlaylists;
    if (extra.playTime !== undefined) simplified.playTime = extra.playTime;
    if (extra.score !== undefined) simplified.score = extra.score;
    if (extra.playCount !== undefined) simplified.playCount = extra.playCount;
    return simplified;
}

function compactSong(song, extra = {}, options = {}) {
    const simplified = simplifySong(song, extra);
    if (!simplified) return null;
    const compact = {
        id: simplified.id,
        name: simplified.name,
        artistText: simplified.artistText,
        artistNames: simplified.artistNames,
        albumName: simplified.albumName,
        coverUrl: simplified.coverUrl,
        durationMs: simplified.durationMs
    };
    if (options.includeWebUrl === true) compact.webUrl = simplified.webUrl;
    if (simplified.tns && simplified.tns.length) compact.tns = simplified.tns;
    if (simplified.alia && simplified.alia.length) compact.alia = simplified.alia;
    if (extra.reason !== undefined) compact.reason = extra.reason;
    if (extra.liked !== undefined) compact.liked = extra.liked;
    if (extra.inPlaylists !== undefined) compact.inPlaylists = extra.inPlaylists;
    if (extra.playTime !== undefined) compact.playTime = extra.playTime;
    if (extra.score !== undefined) compact.score = extra.score;
    if (extra.playCount !== undefined) compact.playCount = extra.playCount;
    return compact;
}

function simplifyPlaylist(playlist) {
    if (!playlist) return null;
    return {
        id: playlist.id,
        name: playlist.name,
        coverImgUrl: normalizePicUrl(playlist.coverImgUrl),
        trackCount: playlist.trackCount,
        playCount: playlist.playCount,
        userId: playlist.userId || (playlist.creator ? playlist.creator.userId : null),
        description: playlist.description ? playlist.description.substring(0, 200) + (playlist.description.length > 200 ? '...' : '') : '',
        tags: playlist.tags
    };
}

function simplifyUser(user) {
    if (!user) return null;
    return {
        userId: user.userId,
        nickname: user.nickname,
        avatarUrl: normalizePicUrl(user.avatarUrl),
        signature: user.signature,
        vipType: user.vipType
    };
}

function simplifySearchResult(result) {
    if (!result) return {};
    const simplified = {};
    if (result.songs) {
        simplified.songs = result.songs.map(song => simplifySong(song));
        simplified.songCount = result.songCount;
    }
    if (result.playlists) {
        simplified.playlists = result.playlists.map(simplifyPlaylist);
        simplified.playlistCount = result.playlistCount;
    }
    if (result.artists) {
        simplified.artists = result.artists.map(simplifyArtist);
        simplified.artistCount = result.artistCount;
    }
    if (result.userprofiles) {
        simplified.users = result.userprofiles.map(simplifyUser);
        simplified.userprofileCount = result.userprofileCount;
    }
    return simplified;
}

async function getUserId(args, cookie) {
    if (args.uid) return args.uid;
    if (!cookie) throw new Error('Need cookie or uid for this action');
    const statusRes = await callApi(api.login_status, { cookie });
    const uid = statusRes.body.data && statusRes.body.data.profile && statusRes.body.data.profile.userId;
    if (!uid) throw new Error('Could not determine userId');
    return uid;
}

async function getLikedSet(args, cookie) {
    const uid = await getUserId(args, cookie);
    const likeRes = await callApi(api.likelist, { uid, cookie });
    return {
        uid,
        ids: new Set((likeRes.body.ids || []).map(id => String(id)))
    };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function getPlaylistMembershipMap(args, cookie, targetIds) {
    const uid = await getUserId(args, cookie);
    const wanted = new Set(targetIds.map(id => String(id)));
    if (wanted.size === 0) {
        return { uid, scannedPlaylists: 0, failedPlaylists: 0, bySongId: new Map() };
    }

    const playlistLimit = clampNumber(args.playlistScanLimit, 80, 300);
    const playlistRes = await callApi(api.user_playlist, {
        uid,
        limit: playlistLimit,
        offset: 0,
        cookie
    });
    const playlists = (playlistRes.body.playlist || []).map(simplifyPlaylist).filter(Boolean).slice(0, playlistLimit);
    const bySongId = new Map();
    let failedPlaylists = 0;

    await mapWithConcurrency(playlists, 4, async playlist => {
        try {
            const detailRes = await callApi(api.playlist_detail, {
                id: playlist.id,
                cookie
            }, clampNumber(args.playlistScanTimeoutMs, 90000, 300000));
            const trackIds = ((detailRes.body.playlist && detailRes.body.playlist.trackIds) || []).map(track => String(track.id));
            for (const trackId of trackIds) {
                if (!wanted.has(trackId)) continue;
                if (!bySongId.has(trackId)) bySongId.set(trackId, []);
                bySongId.get(trackId).push({
                    id: playlist.id,
                    name: playlist.name,
                    trackCount: playlist.trackCount
                });
            }
        } catch (error) {
            failedPlaylists += 1;
            log('warn', `Failed to scan playlist ${playlist.id}: ${error.message}`);
        }
    });

    return {
        uid,
        scannedPlaylists: playlists.length,
        failedPlaylists,
        bySongId
    };
}

async function enrichListeningEntries(entries, args, cookie) {
    const compact = normalizeBoolean(args.compact, true) && args.format !== 'full';
    const includeWebUrl = normalizeBoolean(args.includeWebUrl, false);
    const includeLikeState = normalizeBoolean(args.includeLikeState, true);
    // Playlist membership requires scanning user playlists and can exceed the synchronous plugin timeout.
    // Keep it opt-in for listening-record actions so recent_songs/top_songs remain responsive by default.
    const includePlaylistState = normalizeBoolean(args.includePlaylistState, false);
    const ids = entries
        .map(entry => entry.song && (entry.song.id || entry.song.songId))
        .filter(id => id !== undefined && id !== null)
        .map(id => String(id));

    let uid = null;
    let likedSet = null;
    let playlistMembership = null;

    if (cookie && includeLikeState) {
        try {
            const liked = await getLikedSet(args, cookie);
            uid = liked.uid;
            likedSet = liked.ids;
        } catch (error) {
            log('warn', `Failed to load liked songs for listening records: ${error.message}`);
        }
    }

    if (cookie && includePlaylistState) {
        try {
            playlistMembership = await getPlaylistMembershipMap(args, cookie, ids);
            uid = uid || playlistMembership.uid;
        } catch (error) {
            log('warn', `Failed to load playlist membership for listening records: ${error.message}`);
        }
    }

    const songs = entries.map(entry => {
        const songId = entry.song && (entry.song.id || entry.song.songId);
        const extra = { ...entry.extra };
        if (likedSet && songId !== undefined && songId !== null) {
            extra.liked = likedSet.has(String(songId));
        }
        if (playlistMembership && songId !== undefined && songId !== null) {
            extra.inPlaylists = playlistMembership.bySongId.get(String(songId)) || [];
        }
        return compact
            ? compactSong(entry.song, extra, { includeWebUrl })
            : simplifySong(entry.song, extra);
    }).filter(Boolean);

    return {
        uid,
        compact,
        includeWebUrl,
        includeLikeState,
        includePlaylistState,
        playlistMembership: playlistMembership ? {
            scannedPlaylists: playlistMembership.scannedPlaylists,
            failedPlaylists: playlistMembership.failedPlaylists
        } : null,
        songs
    };
}

async function resolveSongIds(args, options = {}) {
    const allowMultiple = options.allowMultiple !== false;
    const idLikeValue = pickArg(args, ['ids', 'songIds', 'song_ids', 'trackIds', 'track_ids', 'id', 'songId', 'song_id', 'trackId', 'track_id']);
    const direct = toSongIdList(idLikeValue);
    if (direct.length > 0) {
        const ids = allowMultiple ? direct : [direct[0]];
        return { ids, id: ids[0], source: 'direct' };
    }

    const textParts = [
        idLikeValue,
        pickArg(args, ['url', 'shareUrl', 'share_url', 'link']),
        pickArg(args, ['shareText', 'share_text', 'text', 'input', 'content', 'message'])
    ].filter(Boolean).map(String);

    for (const part of textParts) {
        const ids = extractSongIdsFromText(part);
        if (ids.length > 0) {
            const finalIds = allowMultiple ? ids : [ids[0]];
            return { ids: finalIds, id: finalIds[0], source: 'text' };
        }
    }

    const urls = textParts.flatMap(extractUrls);
    for (const url of urls) {
        const directIds = extractSongIdsFromText(url);
        if (directIds.length > 0) {
            const ids = allowMultiple ? directIds : [directIds[0]];
            return { ids, id: ids[0], source: 'url', sourceUrl: url, resolvedUrl: url };
        }

        const resolved = await resolveHttpUrl(url);
        const resolvedIds = [
            ...extractSongIdsFromText(resolved.finalUrl),
            ...extractSongIdsFromText(resolved.body)
        ];
        if (resolvedIds.length > 0) {
            const ids = allowMultiple ? [...new Set(resolvedIds)] : [resolvedIds[0]];
            return { ids, id: ids[0], source: 'resolved_url', sourceUrl: url, resolvedUrl: resolved.finalUrl };
        }
    }

    throw new Error('Need a song id, song URL, or NetEase share text containing a resolvable song link');
}

function buildReasonMap(data) {
    const map = new Map();
    for (const item of data.recommendReasons || []) {
        if (item && item.songId) map.set(String(item.songId), item.reason || null);
    }
    return map;
}

async function getSongDetails(ids, cookie) {
    const songRes = await callApi(api.song_detail, {
        ids: Array.isArray(ids) ? ids.join(',') : ids,
        cookie
    });
    return songRes.body.songs || [];
}

async function buildSongInfo(args, cookie) {
    const resolved = await resolveSongIds(args, { allowMultiple: false });
    const songs = await getSongDetails([resolved.id], cookie);
    if (!songs.length) throw new Error(`No song detail returned for ${resolved.id}`);

    const song = simplifySong(songs[0]);
    const includeLyrics = normalizeBoolean(args.includeLyrics, true);
    const result = {
        source: resolved,
        song,
        cover: {
            url: song.coverUrl
        },
        artists: song.artists,
        artistText: song.artistText
    };

    if (includeLyrics) {
        const lyricRes = await callApi(api.lyric, { id: resolved.id, cookie });
        result.lyrics = {
            lrc: lyricRes.body.lrc ? lyricRes.body.lrc.lyric : '',
            tlyric: lyricRes.body.tlyric ? lyricRes.body.tlyric.lyric : '',
            romalrc: lyricRes.body.romalrc ? lyricRes.body.romalrc.lyric : ''
        };
    }

    if (normalizeBoolean(args.multimodal, false) && song.coverUrl) {
        result.content = [
            {
                type: 'text',
                text: `${song.name} - ${song.artistText}\n${song.webUrl}`
            },
            {
                type: 'image_url',
                image_url: { url: song.coverUrl }
            }
        ];
    }

    return result;
}

async function main() {
    const stdin = process.stdin;
    let inputData = '';

    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
        inputData += chunk;
    });

    stdin.on('end', async () => {
        try {
            if (!inputData.trim()) {
                throw new Error('No input data received');
            }

            const input = JSON.parse(inputData);
            const action = input.action || (input.args && input.args.action);
            if (!action) throw new Error('Missing action');

            const config = input.config || {};
            const cookie = loadCookie(config);
            const args = { ...input.args, ...input };
            delete args.config;
            delete args.tool_name;
            delete args.action;

            let result = null;
            let summary = '';
            let rawResult = null;

            log('info', `Executing action: ${action}`, args);

            switch (action) {
                case 'search': {
                    const searchRes = await callApi(api.cloudsearch, {
                        keywords: args.keywords,
                        type: args.type || 1,
                        limit: Math.min(args.limit || 30, 100),
                        offset: args.offset || 0,
                        cookie
                    });
                    rawResult = searchRes.body.result;
                    result = simplifySearchResult(rawResult);
                    summary = `Found ${rawResult.songCount || rawResult.playlistCount || rawResult.artistCount || 0} results for "${args.keywords}"`;
                    break;
                }

                case 'playlist': {
                    const plRes = await callApi(api.playlist_detail, {
                        id: args.id,
                        cookie
                    });
                    const playlist = plRes.body.playlist;
                    const tracks = (playlist.tracks || []).map(song => simplifySong(song));
                    result = {
                        ...simplifyPlaylist(playlist),
                        tracks,
                        trackIds: (playlist.trackIds || []).map(track => track.id)
                    };
                    summary = `Playlist: ${playlist.name} (${playlist.trackCount} tracks)`;
                    break;
                }

                case 'playlist_all_songs': {
                    const allTracksRes = await callApi(api.playlist_track_all, {
                        id: args.id,
                        limit: args.limit || 10000,
                        offset: args.offset || 0,
                        cookie
                    });
                    rawResult = allTracksRes.body.songs || [];
                    result = rawResult.map(song => simplifySong(song));
                    summary = `Retrieved ${result.length} tracks from playlist ${args.id}`;
                    break;
                }

                case 'song_detail': {
                    const resolved = await resolveSongIds(args);
                    const songs = await getSongDetails(resolved.ids, cookie);
                    result = songs.map(song => simplifySong(song));
                    summary = `Details for ${result.length} song(s)`;
                    break;
                }

                case 'song_info':
                case 'share_song': {
                    result = await buildSongInfo(args, cookie);
                    summary = `Song info: ${result.song.name} - ${result.song.artistText}`;
                    break;
                }

                case 'cover': {
                    result = await buildSongInfo({ ...args, includeLyrics: false, multimodal: true }, cookie);
                    summary = `Cover for ${result.song.name}`;
                    break;
                }

                case 'song_url': {
                    const resolved = await resolveSongIds(args);
                    const urlRes = await callApi(api.song_url, {
                        id: resolved.ids.join(','),
                        level: args.level || 'standard',
                        cookie
                    });
                    result = (urlRes.body.data || []).map(item => ({
                        id: item.id,
                        url: item.url,
                        size: item.size,
                        type: item.type,
                        br: item.br
                    }));
                    summary = `Got URL for song(s)`;
                    break;
                }

                case 'lyric': {
                    const resolved = await resolveSongIds(args, { allowMultiple: false });
                    const lyricRes = await callApi(api.lyric, {
                        id: resolved.id,
                        cookie
                    });
                    result = {
                        id: resolved.id,
                        source: resolved,
                        lrc: lyricRes.body.lrc ? lyricRes.body.lrc.lyric : '',
                        tlyric: lyricRes.body.tlyric ? lyricRes.body.tlyric.lyric : '',
                        romalrc: lyricRes.body.romalrc ? lyricRes.body.romalrc.lyric : ''
                    };
                    summary = `Got lyrics for ${resolved.id}`;
                    break;
                }

                case 'user_playlist':
                case 'my_playlists': {
                    const uid = await getUserId(args, cookie);
                    const uPlRes = await callApi(api.user_playlist, {
                        uid,
                        limit: args.limit || 30,
                        offset: args.offset || 0,
                        cookie
                    });
                    result = (uPlRes.body.playlist || []).map(simplifyPlaylist);
                    summary = `User playlists for ${uid}`;
                    break;
                }

                case 'recent_songs': {
                    const limit = Math.min(args.limit || 50, 100);
                    const recentRes = await callApi(api.record_recent_song, {
                        limit,
                        cookie
                    });
                    const list = (recentRes.body.data && recentRes.body.data.list) || [];
                    const limitedList = list.slice(0, limit);
                    const enriched = await enrichListeningEntries(limitedList.map(item => ({
                        song: item.data,
                        extra: {
                            playTime: item.playTime
                        }
                    })), args, cookie);
                    result = {
                        total: list.length,
                        returned: enriched.songs.length,
                        ...enriched
                    };
                    summary = `Got ${enriched.songs.length} recently played songs with listening context`;
                    break;
                }

                case 'top_songs': {
                    const uid = await getUserId(args, cookie);
                    const topRes = await callApi(api.user_record, {
                        uid,
                        type: args.type !== undefined ? args.type : 1,
                        cookie
                    });
                    const source = Number(args.type) === 0 ? topRes.body.allData : topRes.body.weekData;
                    const limitedSource = (source || []).slice(0, clampNumber(args.limit, 50, 100));
                    const enriched = await enrichListeningEntries(limitedSource.map(item => ({
                        song: item.song,
                        extra: {
                            score: item.score,
                            playCount: item.playCount
                        }
                    })), { ...args, uid }, cookie);
                    result = {
                        type: Number(args.type) === 0 ? 'all' : 'week',
                        total: (source || []).length,
                        returned: enriched.songs.length,
                        ...enriched
                    };
                    summary = `Got ${enriched.songs.length} top played songs with listening context`;
                    break;
                }

                case 'daily_recommend': {
                    const dailyRes = await callApi(api.recommend_songs, { cookie });
                    const data = dailyRes.body.data || {};
                    const dailySongs = data.dailySongs || [];
                    const limit = clampNumber(args.limit, 20, 100);
                    const compact = normalizeBoolean(args.compact, true) && args.format !== 'full';
                    const includeLikeState = normalizeBoolean(args.includeLikeState, true);
                    const reasonMap = buildReasonMap(data);
                    let likedSet = null;
                    let uid = null;

                    if (includeLikeState && cookie) {
                        try {
                            const liked = await getLikedSet(args, cookie);
                            likedSet = liked.ids;
                            uid = liked.uid;
                        } catch (error) {
                            log('warn', `Failed to load liked songs for daily_recommend: ${error.message}`);
                        }
                    }

                    const songs = dailySongs.slice(0, limit).map(song => {
                        const extra = {
                            reason: reasonMap.get(String(song.id)) || null
                        };
                        if (likedSet) extra.liked = likedSet.has(String(song.id));
                        return compact ? compactSong(song, extra) : simplifySong(song, extra);
                    });

                    result = {
                        date: formatLocalDate(),
                        total: dailySongs.length,
                        returned: songs.length,
                        compact,
                        uid,
                        songs,
                        operationActions: {
                            like: "action='like_song', id/songId/url/shareText",
                            unlike: "action='unlike_song', id/songId/url/shareText",
                            addToPlaylist: "action='add_to_playlist', pid/playlistId, id/songId/url/shareText"
                        }
                    };
                    summary = `Got ${songs.length}/${dailySongs.length} daily recommended songs`;
                    break;
                }

                case 'today_listens': {
                    const todayRes = await callApi(api.listen_data_today_song, { cookie });
                    const data = todayRes.body.data || {};
                    const list = data.songDTOs || data.list || data.songList || [];
                    const limitedList = list.slice(0, clampNumber(args.limit, 50, 100));
                    const enriched = await enrichListeningEntries(limitedList.map(item => {
                        const song = item.song || item.songDTO || item;
                        return {
                            song,
                            extra: {
                                playTime: item.playTime,
                                score: item.score,
                                playCount: item.playCount
                            }
                        };
                    }), args, cookie);
                    result = {
                        total: list.length,
                        returned: enriched.songs.length,
                        ...enriched
                    };
                    summary = `Got ${enriched.songs.length} today's listen records with listening context`;
                    break;
                }

                case 'like_song':
                case 'unlike_song': {
                    if (!cookie) throw new Error('Need NETEASE_COOKIE for like/unlike actions');
                    const resolved = await resolveSongIds(args, { allowMultiple: false });
                    const like = action === 'like_song' ? normalizeBoolean(args.like, true) : false;
                    const dryRun = normalizeBoolean(args.dryRun, false);
                    const song = simplifySong((await getSongDetails([resolved.id], cookie))[0]);

                    if (dryRun) {
                        result = {
                            dryRun: true,
                            operation: like ? 'like_song' : 'unlike_song',
                            id: resolved.id,
                            song,
                            source: resolved,
                            message: 'No account changes were made'
                        };
                    } else {
                        const likeRes = await callApi(api.like, {
                            id: resolved.id,
                            like,
                            cookie
                        });
                        result = {
                            operation: like ? 'like_song' : 'unlike_song',
                            id: resolved.id,
                            song,
                            response: likeRes.body
                        };
                    }
                    summary = `${dryRun ? 'Dry-run ' : ''}${like ? 'like' : 'unlike'} song ${resolved.id}`;
                    break;
                }

                case 'add_to_playlist':
                case 'remove_from_playlist': {
                    if (!cookie) throw new Error('Need NETEASE_COOKIE for playlist mutation actions');
                    const pid = pickArg(args, ['pid', 'playlistId', 'playlist_id']);
                    if (!pid) throw new Error('Need pid or playlistId');

                    const songArgs = {
                        ...args,
                        ids: pickArg(args, ['songIds', 'song_ids', 'trackIds', 'track_ids', 'songId', 'song_id', 'trackId', 'track_id', 'ids', 'id'])
                    };
                    const resolved = await resolveSongIds(songArgs);
                    const dryRun = normalizeBoolean(args.dryRun, false);
                    const op = action === 'remove_from_playlist' ? 'del' : 'add';
                    const songs = (await getSongDetails(resolved.ids, cookie)).map(song => simplifySong(song));

                    if (dryRun) {
                        result = {
                            dryRun: true,
                            operation: action,
                            pid,
                            ids: resolved.ids,
                            songs,
                            source: resolved,
                            message: 'No account changes were made'
                        };
                    } else {
                        const mutationRes = await callApi(api.playlist_tracks, {
                            op,
                            pid,
                            tracks: resolved.ids.join(','),
                            cookie
                        });
                        result = {
                            operation: action,
                            pid,
                            ids: resolved.ids,
                            songs,
                            response: mutationRes.body
                        };
                    }
                    summary = `${dryRun ? 'Dry-run ' : ''}${op === 'add' ? 'add' : 'remove'} ${resolved.ids.length} song(s) ${op === 'add' ? 'to' : 'from'} playlist ${pid}`;
                    break;
                }

                case 'top_playlist': {
                    const topPlRes = await callApi(api.top_playlist, {
                        cat: args.cat || '全部',
                        limit: args.limit || 30,
                    offset: args.offset || 0,
                        cookie
                    });
                    result = (topPlRes.body.playlists || []).map(simplifyPlaylist);
                    summary = `Top playlists retrieved`;
                    break;
                }

                case 'login_status': {
                    const statusRes = await callApi(api.login_status, { cookie });
                    result = {
                        code: statusRes.body.data.code,
                        profile: simplifyUser(statusRes.body.data.profile)
                    };
                    summary = `Login status check`;
                    break;
                }

                case 'download': {
                    const resolved = await resolveSongIds(args, { allowMultiple: false });
                    const level = args.level || 'standard';

                    const songs = await getSongDetails([resolved.id], cookie);
                    if (!songs.length) throw new Error(`No song detail returned for ${resolved.id}`);
                    const song = simplifySong(songs[0]);

                    const urlRes = await callApi(api.song_url, {
                        id: resolved.id,
                        level: level,
                        cookie
                    });
                    const urlData = urlRes.body.data && urlRes.body.data[0];
                    if (!urlData || !urlData.url) {
                        throw new Error(`Could not get download URL for song ${resolved.id} (VIP/Copyright restriction)`);
                    }

                    const songUrl = urlData.url;
                    const ext = urlData.type ? urlData.type.toLowerCase() : 'mp3';

                    let outputDir = args.outputDir || args.savePath || path.join(__dirname, 'downloads');
                    outputDir = path.resolve(outputDir);
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }

                    const safeName = `${song.name} - ${song.artistText}`.replace(/[\\/:*?"<>|]/g, '_');
                    const targetPath = path.join(outputDir, `${safeName}.${ext}`);

                    log('info', `Downloading song from ${songUrl} to ${targetPath}`);
                    await downloadFile(songUrl, targetPath);

                    result = {
                        songId: resolved.id,
                        name: song.name,
                        artistText: song.artistText,
                        albumName: song.albumName,
                        coverUrl: song.coverUrl,
                        url: songUrl,
                        savePath: targetPath,
                        fileSize: urlData.size,
                        bitrate: urlData.br,
                        format: ext
                    };
                    summary = `Successfully downloaded "${song.name} - ${song.artistText}" to ${targetPath}`;
                    break;
                }

                case 'analyze': {
                    let audioPath = args.audioPath || args.filePath;
                    let songInfo = null;

                    if (!audioPath) {
                        const resolved = await resolveSongIds(args, { allowMultiple: false });
                        const level = args.level || 'standard';

                        const songs = await getSongDetails([resolved.id], cookie);
                        if (!songs.length) throw new Error(`No song detail returned for ${resolved.id}`);
                        const song = simplifySong(songs[0]);

                        const urlRes = await callApi(api.song_url, {
                            id: resolved.id,
                            level: level,
                            cookie
                        });
                        const urlData = urlRes.body.data && urlRes.body.data[0];
                        if (!urlData || !urlData.url) {
                            throw new Error(`Could not get URL for song ${resolved.id} to analyze`);
                        }

                        const songUrl = urlData.url;
                        const ext = urlData.type ? urlData.type.toLowerCase() : 'mp3';

                        const outputDir = path.join(__dirname, 'downloads');
                        if (!fs.existsSync(outputDir)) {
                            fs.mkdirSync(outputDir, { recursive: true });
                        }
                        const safeName = `${song.name} - ${song.artistText}`.replace(/[\\/:*?"<>|]/g, '_');
                        audioPath = path.join(outputDir, `${safeName}.${ext}`);

                        log('info', `Downloading song for analysis to ${audioPath}`);
                        await downloadFile(songUrl, audioPath);
                        songInfo = song;
                    } else {
                        audioPath = path.resolve(audioPath);
                        if (!fs.existsSync(audioPath)) {
                            throw new Error(`Target audio file not found: ${audioPath}`);
                        }
                        const basename = path.basename(audioPath, path.extname(audioPath));
                        const parts = basename.split(' - ');
                        songInfo = {
                            name: parts[0] || basename,
                            artistText: parts[1] || 'Unknown Artist'
                        };
                    }

                    const mainConfig = loadMainConfig();
                    if (!mainConfig.API_Key || !mainConfig.API_URL) {
                        throw new Error('API_Key or API_URL not found in config.env');
                    }

                    const stat = fs.statSync(audioPath);
                    let processedAudioPath = audioPath;
                    let isTempProcessedFile = false;

                    const ffmpegPath = 'D:\\327AI-VCP\\VCPToolBox\\Plugin\\VideoAnalyzer\\yt-dlp\\ffmpeg.exe';
                    if (stat.size > 2 * 1024 * 1024 && fs.existsSync(ffmpegPath)) {
                        const tempDir = path.join(__dirname, 'temp');
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        const processedName = `temp_${Date.now()}_compact.mp3`;
                        const outputPath = path.join(tempDir, processedName);

                        log('info', `Audio file size ${stat.size} bytes > 2MB. Compressing 60s sample to ${outputPath}...`);
                        try {
                            await compressAudio(audioPath, outputPath, 60);
                            processedAudioPath = outputPath;
                            isTempProcessedFile = true;
                            log('info', `Compressed successfully. New size: ${fs.statSync(outputPath).size} bytes`);
                        } catch (e) {
                            log('warn', `Failed to compress audio with ffmpeg: ${e.message}. Will try uploading original file.`);
                        }
                    }

                    log('info', `Reading audio file: ${processedAudioPath}`);
                    const audioBuffer = fs.readFileSync(processedAudioPath);
                    const base64Audio = audioBuffer.toString('base64');
                    const ext = path.extname(processedAudioPath).toLowerCase();
                    const mimeType = ext === '.flac' ? 'audio/flac' : (ext === '.wav' ? 'audio/wav' : 'audio/mpeg');

                    const analyzePrompt = `你是一个专业的音乐分析引擎（Music Analysis Engine）。请你对所给的音乐音频进行深度、“体毛级”的全面剖析。
请重点从以下几个维度进行分析，并输出结构化的 Markdown 报告：
1. **整体曲风与流派 (Genre & Style)**: 识别音乐的风格（如流行、摇融、电子、古风、交响等），以及它的融合元素与整体氛围。
2. **节奏与律动 (Tempo & Rhythm)**: 分析节拍律动、BPM 大致范围、节奏的强弱对比，以及打击乐器/节奏声部的编排特点。
3. **旋律、和声与器乐 (Melody, Harmony & Instrumentation)**: 音乐中使用了哪些主要乐器？它们的音色特点是什么？旋律线与和声走向有什么特点？
4. **歌曲结构与转折点 (Structure & Transitions)**: 音乐是如何层层递进的？列出它的各个转折点（如前奏、主歌、副歌/高潮、桥段、间奏、尾奏）以及在这些转折点处配器、情绪、节奏上的具体变化。
5. **亮点与特色 (Highlights & Characteristics)**: 这首音乐有什么抓耳的特色（Hook）、新颖的转调、人声编排或特殊的混音效果？
6. **情感与听觉画卷 (Emotion & Narrative)**: 音乐传达了怎样的情绪？在听觉上勾勒出了怎样的画面？`;

                    let fetchImpl;
                    if (typeof fetch === 'function') {
                        fetchImpl = fetch;
                    } else {
                        try {
                            fetchImpl = require('node-fetch');
                        } catch (e) {
                            const { default: nodeFetch } = await import('node-fetch');
                            fetchImpl = nodeFetch;
                        }
                    }

                    const modelsToTry = [];
                    if (mainConfig.MultiModalModel) {
                        modelsToTry.push(mainConfig.MultiModalModel);
                    }
                    if (mainConfig.MultiModalModelChain) {
                        const chainModels = mainConfig.MultiModalModelChain.split(',').map(m => m.trim()).filter(Boolean);
                        for (const m of chainModels) {
                            if (!modelsToTry.includes(m)) {
                                modelsToTry.push(m);
                            }
                        }
                    }
                    if (modelsToTry.length === 0) {
                        modelsToTry.push('gemini-2.5-flash-lite');
                    }

                    let analysis = null;
                    let lastError = null;
                    let usedModel = null;

                    for (const currentModel of modelsToTry) {
                        log('info', `Attempting music analysis with model: ${currentModel} via API: ${mainConfig.API_URL}`);
                        try {
                            const payload = {
                                model: currentModel,
                                messages: [{
                                    role: 'user',
                                    content: [
                                        { type: 'text', text: analyzePrompt },
                                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Audio}` } }
                                    ]
                                }],
                                max_tokens: 4000
                            };

                            const response = await fetchImpl(`${mainConfig.API_URL}/v1/chat/completions`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${mainConfig.API_Key}`
                                },
                                body: JSON.stringify(payload),
                                timeout: 600000
                            });

                            if (!response.ok) {
                                const errorText = await response.text();
                                throw new Error(`HTTP ${response.status} - ${errorText}`);
                            }

                            const apiResult = await response.json();
                            const content = apiResult?.choices?.[0]?.message?.content;
                            if (content) {
                                analysis = content;
                                usedModel = currentModel;
                                break;
                            } else {
                                throw new Error('API returned empty message content');
                            }
                        } catch (e) {
                            lastError = e;
                            log('warn', `Failed analysis with model ${currentModel}: ${e.message}. Trying next model...`);
                        }
                    }

                    if (!analysis) {
                        throw new Error(`All models in chain failed. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
                    }

                    if (isTempProcessedFile && fs.existsSync(processedAudioPath)) {
                        try {
                            fs.unlinkSync(processedAudioPath);
                            log('info', `Cleaned up temporary compressed file: ${processedAudioPath}`);
                        } catch (e) {
                            log('warn', `Failed to clean up temporary file: ${e.message}`);
                        }
                    }

                    result = {
                        song: songInfo,
                        audioPath: audioPath,
                        analysis: analysis
                    };
                    summary = `Completed music analysis for "${songInfo.name} - ${songInfo.artistText}" using model ${usedModel}`;
                    break;
                }

                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            process.stdout.write(JSON.stringify({ status: 'success', result, summary }, null, 2));
            process.exit(0);
        } catch (error) {
            log('error', `Execution failed: ${error.message}`);
            process.stdout.write(JSON.stringify({ status: 'error', error: error.message }, null, 2));
            process.exit(0);
        }
    });
}

main();
