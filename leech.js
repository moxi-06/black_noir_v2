const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const WebTorrent = require('webtorrent');
const mime = require('mime-types');

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.ensureDirSync(DOWNLOAD_DIR);

const client = new WebTorrent();

/**
 * Formats speed in bytes/s to a readable format
 */
function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) return bytesPerSecond + ' B/s';
    if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(2) + ' KB/s';
    return (bytesPerSecond / (1024 * 1024)).toFixed(2) + ' MB/s';
}

/**
 * Formats bytes to readable size
 */
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Generates a progress bar string
 */
function progressBar(percent) {
    const totalBlocks = 10;
    const filledBlocks = Math.round((percent / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    return '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
}

/**
 * Downloads a file from a direct link
 */
async function downloadDirect(url, ctx) {
    let statusMsg;
    try {
        statusMsg = await ctx.reply('⏳ *Initializing Direct Leech...*', { parse_mode: 'Markdown' });

        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });

        const totalSize = parseInt(response.headers['content-length'], 10);
        const fileName = path.basename(new URL(url).pathname) || 'leech_file';
        const filePath = path.join(DOWNLOAD_DIR, fileName);

        const writer = fs.createWriteStream(filePath);
        let downloadedSize = 0;
        let lastUpdateTime = Date.now();

        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const now = Date.now();

            // Update every 3 seconds to avoid Telegram flood
            if (now - lastUpdateTime > 3000) {
                const percent = ((downloadedSize / totalSize) * 100).toFixed(2);
                const progressText = `📥 *Leeching:* \`${fileName}\`\n\n` +
                    `${progressBar(percent)} ${percent}%\n` +
                    `📦 *Size:* ${formatSize(downloadedSize)} / ${formatSize(totalSize)}\n` +
                    `🚀 *Status:* Downloading...`;

                ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, progressText, { parse_mode: 'Markdown' }).catch(() => { });
                lastUpdateTime = now;
            }
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `✅ *Download Complete:* \`${fileName}\`\n🚀 *Starting Upload...*`, { parse_mode: 'Markdown' }).catch(() => { });
                resolve({ filePath, fileName, statusMsg });
            });
            writer.on('error', (err) => {
                fs.removeSync(filePath);
                reject(err);
            });
        });

    } catch (error) {
        if (statusMsg) ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ *Leech Failed:* ${error.message}`).catch(() => { });
        throw error;
    }
}

/**
 * Downloads a torrent/magnet
 */
async function downloadTorrent(magnet, ctx) {
    let statusMsg = await ctx.reply('⏳ *Initializing Torrent Leech...*', { parse_mode: 'Markdown' });

    return new Promise((resolve, reject) => {
        client.add(magnet, { path: DOWNLOAD_DIR }, (torrent) => {
            const fileName = torrent.name;
            let lastUpdateTime = Date.now();

            torrent.on('download', (bytes) => {
                const now = Date.now();
                if (now - lastUpdateTime > 3000) {
                    const percent = (torrent.progress * 100).toFixed(2);
                    const progressText = `🧲 *Leeching Torrent:* \`${fileName}\`\n\n` +
                        `${progressBar(percent)} ${percent}%\n` +
                        `📦 *Size:* ${formatSize(torrent.downloaded)} / ${formatSize(torrent.length)}\n` +
                        `🚀 *Speed:* ${formatSpeed(torrent.downloadSpeed)}\n` +
                        `👥 *Peers:* ${torrent.numPeers}`;

                    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, progressText, { parse_mode: 'Markdown' }).catch(() => { });
                    lastUpdateTime = now;
                }
            });

            torrent.on('done', () => {
                ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `✅ *Torrent Download Complete:* \`${fileName}\`\n🚀 *Starting Upload...*`, { parse_mode: 'Markdown' }).catch(() => { });

                // For now, leech the biggest file in the torrent
                const biggestFile = torrent.files.reduce((a, b) => a.length > b.length ? a : b);
                const filePath = path.join(DOWNLOAD_DIR, biggestFile.path);

                resolve({ filePath, fileName: biggestFile.name, statusMsg });
            });

            torrent.on('error', (err) => {
                ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ *Torrent Error:* ${err.message}`).catch(() => { });
                reject(err);
            });
        });
    });
}

/**
 * Uploads file to Telegram
 */
async function uploadFile(filePath, fileName, ctx, statusMsg) {
    try {
        const stats = await fs.stat(filePath);
        const mimeType = mime.lookup(filePath) || 'application/octet-stream';

        let uploadMethod = 'sendDocument';
        if (mimeType.startsWith('video/')) uploadMethod = 'sendVideo';
        else if (mimeType.startsWith('audio/')) uploadMethod = 'sendAudio';

        await ctx.telegram[uploadMethod](ctx.chat.id, { source: filePath }, {
            caption: `✅ *Leech Complete*\n\n📁 *File:* \`${fileName}\`\n💾 *Size:* ${formatSize(stats.size)}`,
            parse_mode: 'Markdown'
        });

        // Cleanup
        await fs.remove(filePath);
        if (statusMsg) ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => { });

    } catch (error) {
        if (statusMsg) ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ *Upload Failed:* ${error.message}`).catch(() => { });
        throw error;
    }
}

module.exports = { downloadDirect, downloadTorrent, uploadFile };
