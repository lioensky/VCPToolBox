// modules/lyricFetcher.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const lyricApiUrl = 'https://music.163.com/api/song/lyric';
const searchApiUrl = 'https://music.163.com/api/search/get/';

async function searchSongId(title, artist) {
    if (!title) return null;
    try {
        const cleanedArtist = artist ? artist.replace(/\//g, ' ') : '';
        const response = await axios.get(searchApiUrl, {
            params: {
                s: `${title} ${cleanedArtist}`.trim(),
                type: 1,
                limit: 10, // Increase limit to get more results
            },
            headers: {
                'Referer': 'https://music.163.com',
                'Content-Type': 'application/json',
            },
            timeout: 8000
        });

        if (response.data.code === 200 && response.data.result && response.data.result.songs && response.data.result.songs.length > 0) {
            return response.data.result.songs; // Return all found songs
        }
        console.warn(`[LyricFetcher] Could not find any songs for "${title} - ${artist}". API response:`, response.data);
        return null;
    } catch (error) {
        console.error(`[LyricFetcher] Error searching for song "${title} - ${artist}":`, error.message);
        return null;
    }
}

async function getLyric(songId) {
    if (!songId) return null;
    try {
        // First, try to get translated and original lyrics
        let response = await axios.get(`${lyricApiUrl}?id=${songId}&lv=1&kv=1&tv=-1`, {
            headers: { 'Referer': 'https://music.163.com' },
            timeout: 8000
        });

        if (response.data && (response.data.lrc?.lyric || response.data.tlyric?.lyric)) {
            return parseLyric(response.data);
        }
        return null;

    } catch (error) {
        console.error(`[LyricFetcher] Error fetching lyric for song ID ${songId}:`, error.message);
        return null;
    }
}

function parseLyric(lyricData) {
    if (!lyricData || !lyricData.lrc || !lyricData.lrc.lyric) {
        return null;
    }

    const lrc = lyricData.lrc.lyric;
    const tlyric = lyricData.tlyric ? lyricData.tlyric.lyric : null;

    if (!tlyric) {
        return lrc; // Return only original if no translation
    }

    const lrcLines = lrc.split('\n');
    const tlyricLines = tlyric.split('\n');
    const mergedLrc = [];

    const tlyricMap = new Map();
    for (const line of tlyricLines) {
        const match = line.match(/\[(\d{2}:\d{2}[.:]\d{2,3})\](.*)/);
        if (match && match[2].trim()) { // Ensure translation is not empty
            tlyricMap.set(match[1], match[2].trim());
        }
    }

    for (const line of lrcLines) {
        const match = line.match(/\[(\d{2}:\d{2}[.:]\d{2,3})\](.*)/);
        if (match) {
            const timestamp = match[1];
            mergedLrc.push(line); // Push original line
            const translatedText = tlyricMap.get(timestamp);
            if (translatedText) {
                // To keep sync, add translated line with same timestamp
                mergedLrc.push(`[${timestamp}]${translatedText}`);
            }
        } else {
            mergedLrc.push(line);
        }
    }

    return mergedLrc.join('\n');
}


function getBestMatch(songs, artist) {
    if (!artist) {
        return songs[0]; // If no artist provided, return the first result
    }

    let bestMatch = null;
    let maxScore = -1;

    // Simple string similarity function (Jaro-Winkler-like)
    const calculateSimilarity = (s1, s2) => {
        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;
        const longerLength = longer.length;
        if (longerLength === 0) {
            return 1.0;
        }
        const matchDistance = Math.floor(longerLength / 2) - 1;
        const shorterMatches = new Array(shorter.length).fill(false);
        const longerMatches = new Array(longerLength).fill(false);
        let matches = 0;
        for (let i = 0; i < shorter.length; i++) {
            const start = Math.max(0, i - matchDistance);
            const end = Math.min(i + matchDistance + 1, longerLength);
            for (let j = start; j < end; j++) {
                if (longerMatches[j]) continue;
                if (shorter[i] !== longer[j]) continue;
                shorterMatches[i] = true;
                longerMatches[j] = true;
                matches++;
                break;
            }
        }
        if (matches === 0) {
            return 0.0;
        }
        let transpositions = 0;
        let k = 0;
        for (let i = 0; i < shorter.length; i++) {
            if (!shorterMatches[i]) continue;
            while (!longerMatches[k]) {
                k++;
            }
            if (shorter[i] !== longer[k]) {
                transpositions++;
            }
            k++;
        }
        transpositions /= 2;
        return (matches / shorter.length + matches / longer.length + (matches - transpositions) / matches) / 3;
    };

    for (const song of songs) {
        const songArtists = song.artists.map(a => a.name).join(' ');
        const score = calculateSimilarity(artist, songArtists);

        if (score > maxScore) {
            maxScore = score;
            bestMatch = song;
        }
    }

    return bestMatch;
}


async function fetchAndSaveLyrics(artist, title, lyricDir) {
    const songs = await searchSongId(title, artist);
    if (!songs || songs.length === 0) {
        console.log(`[LyricFetcher] Could not find any songs for "${title}".`);
        return null;
    }

    const bestMatch = getBestMatch(songs, artist);
    if (!bestMatch) {
        console.log(`[LyricFetcher] Could not determine a best match for "${title}".`);
        return null;
    }

    const songId = bestMatch.id;
    console.log(`[LyricFetcher] Found best match song ID: ${songId} for "${title}" (Artist: ${bestMatch.artists.map(a => a.name).join('/')})`);
    const lrcContent = await getLyric(songId);

    if (lrcContent) {
        try {
            await fs.mkdir(lyricDir, { recursive: true });
            const sanitize = (str) => str.replace(/[\\/:"*?<>|]/g, '_').trim();
            const sanitizedTitle = sanitize(title);
            const lrcFileName = artist ? `${sanitize(artist)} - ${sanitizedTitle}.lrc` : `${sanitizedTitle}.lrc`;
            const lrcFilePath = path.join(lyricDir, lrcFileName);
            await fs.writeFile(lrcFilePath, lrcContent);
            console.log(`[LyricFetcher] Lyric saved to ${lrcFilePath}`);
            return lrcContent;
        } catch (error) {
            console.error(`[LyricFetcher] Error saving lyric file:`, error);
            return lrcContent; // Still return content even if saving fails
        }
    }
    
    console.log(`[LyricFetcher] No lyric content found for song ID ${songId}.`);
    return null;
}

module.exports = {
    fetchAndSaveLyrics
};