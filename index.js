require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const Fuse = require('fuse.js');

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'AutofilterBot';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'Files';
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const DATABASE_CHANNEL_ID = process.env.DATABASE_CHANNEL_ID ? parseInt(process.env.DATABASE_CHANNEL_ID) : null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID ? parseInt(process.env.LOG_CHANNEL_ID) : null;
const FSUB_CHANNEL_ID = process.env.FSUB_CHANNEL_ID ? parseInt(process.env.FSUB_CHANNEL_ID) : null;
const FSUB_LINK = process.env.FSUB_LINK || '';

// God-Mode Configs
let IS_MAINTENANCE = process.env.IS_MAINTENANCE === 'true';
let IS_GROWTH_LOCK = process.env.IS_GROWTH_LOCK === 'true';
let LAST_FSUB_POST_ID = null;
let LAST_PING_STATUS = 'Waiting...';
let LAST_PING_TIME = null;

const RESULTS_PER_PAGE = 10;
const AUTO_DELETE_SECONDS = 3600;

// Bot start time for uptime tracking
const BOT_START_TIME = Date.now();

// Store pending indexing operations
const pendingIndexing = new Map();

// 📡 Immediate Health Check Server (Critical for Koyeb)
const http = require('http');
const port = process.env.PORT || 8080;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(port, () => {
    console.log(`📡 Health check server live on port ${port}`);
});

// Validate environment variables
const requiredVars = ['BOT_TOKEN', 'MONGO_URI'];
console.log('🔍 Environment Check:');
Object.keys(process.env).forEach(key => {
    if (requiredVars.includes(key) || key.includes('CHANNEL_ID') || key === 'ADMIN_IDS') {
        const val = process.env[key];
        console.log(`✅ Detected Key: ${key} (${val ? 'FOUND' : 'EMPTY/NULL'})`);
    }
});

if (!BOT_TOKEN || !MONGO_URI) {
    console.error('❌ CRITICAL ERROR: Missing BOT_TOKEN or MONGO_URI');
    console.error('Check your Koyeb Dashboard > Environment Variables.');
    process.exit(1);
}

// Trim tokens to avoid space issues
const FINAL_BOT_TOKEN = BOT_TOKEN.trim();
const FINAL_MONGO_URI = MONGO_URI.trim();

// Initialize bot
const bot = new Telegraf(FINAL_BOT_TOKEN);

// MongoDB client
let db;
let filesCollection;
let usersCollection;
let trendingCollection;
let requestsCollection;
let settingsCollection;
let blockedKeywordsCollection;

// Connect to MongoDB
async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log('✅ Connected to MongoDB');

        db = client.db(DB_NAME);
        filesCollection = db.collection(COLLECTION_NAME);
        usersCollection = db.collection('users');
        trendingCollection = db.collection('trending');
        requestsCollection = db.collection('requests');
        settingsCollection = db.collection('settings');
        blockedKeywordsCollection = db.collection('blocked_keywords');

        // Load settings
        const mnt = await settingsCollection.findOne({ key: 'maintenance' });
        if (mnt) IS_MAINTENANCE = mnt.value;

        const gl = await settingsCollection.findOne({ key: 'growth_lock' });
        if (gl) IS_GROWTH_LOCK = gl.value;

        const lastPost = await settingsCollection.findOne({ key: 'last_fsub_post' });
        if (lastPost) LAST_FSUB_POST_ID = lastPost.value;

        // Create indexes
        await filesCollection.createIndex({ file_name: 'text' });

        // Migration: Rename 'language' to 'file_lang' for existing documents (MongoDB Conflict Fix)
        const oldDocs = await filesCollection.findOne({ language: { $exists: true } });
        if (oldDocs) {
            console.log('🔄 MongoDB Migration: Renaming "language" field to "file_lang"...');
            await filesCollection.updateMany(
                { language: { $exists: true } },
                { $rename: { language: 'file_lang' } }
            );
            console.log('✅ Migration complete: Global language override conflict resolved.');
        }

        // Fix: Remove documents with null user_id before creating unique index
        await usersCollection.deleteMany({ user_id: null });
        await usersCollection.createIndex({ user_id: 1 }, { unique: true });

        // TTL Indexes for memory optimization (Auto-delete old data)
        await trendingCollection.createIndex({ last_searched: 1 }, { expireAfterSeconds: 86400 * 7 }); // 7 days
        await requestsCollection.createIndex({ last_requested: 1 }, { expireAfterSeconds: 86400 * 7 }); // 7 days

        console.log('✅ Collection indexes & TTL created');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Helper: Send log to log channel
async function sendLog(message, parseMode = 'Markdown') {
    if (!LOG_CHANNEL_ID) return;

    try {
        await bot.telegram.sendMessage(LOG_CHANNEL_ID, message, {
            parse_mode: parseMode
        });
    } catch (error) {
        console.error('Error sending log:', error.message);
    }
}

// Helper: Check if user is admin
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

// Helper: Get bot uptime
function getUptime() {
    const uptimeMs = Date.now() - BOT_START_TIME;
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${days}d ${hours}h ${minutes}m`;
}

// Helper: Format file size
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Helper: Escape regex special characters
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper: Parse file name for language, year, and quality
function parseFileName(fileName) {
    const languages = ['English', 'Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Marathi'];
    const quality = ['480p', '720p', '1080p', '1440p', '2160p', '4K', 'HDR', 'CAM', 'HDTS', 'Web-DL', 'BluRay'];

    const yearMatch = fileName.match(/\b(19\d{2}|20\d{2})\b/);
    const qualityMatch = quality.find(q => fileName.toLowerCase().includes(q.toLowerCase()));

    let detectedLanguage = null;
    for (const lang of languages) {
        if (fileName.toLowerCase().includes(lang.toLowerCase())) {
            detectedLanguage = lang;
            break;
        }
    }

    return {
        year: yearMatch ? yearMatch[1] : null,
        file_lang: detectedLanguage,
        quality: qualityMatch || null
    };
}

// Helper: Parse Telegram Post URL
function parsePostUrl(url) {
    if (!url) return null;
    try {
        const parts = url.split('/');
        const messageId = parseInt(parts.pop());
        let chatId = parts.pop();

        if (chatId === 'c') {
            // Private channel link format: https://t.me/c/12345/678
            chatId = '-100' + parts.pop();
        } else {
            // Public channel link format: https://t.me/username/678
            chatId = '@' + chatId;
        }

        return { chatId, messageId };
    } catch (e) {
        return null;
    }
}

// Helper: Check if user is subscribed (Force Subscribe) with caching
async function isSubscribed(userId) {
    if (!FSUB_CHANNEL_ID) return true;

    try {
        const member = await bot.telegram.getChatMember(FSUB_CHANNEL_ID, userId);
        const status = ['member', 'administrator', 'creator'].includes(member.status);
        return status;
    } catch (error) {
        console.log(`Subscription check error for ${userId}:`, error.message);
        return false;
    }
}

// Helper: Get user premium status
async function isPremium(userId) {
    const user = await usersCollection.findOne({ user_id: userId });
    return user ? !!user.isPremium : false;
}

// Helper: Check if user is banned or bot is in maintenance
async function checkUser(ctx) {
    if (isAdmin(ctx.from.id)) return true;

    if (IS_MAINTENANCE) {
        await ctx.reply('🚧 *Maintenance Mode*\n\nBot is currently undergoing maintenance. Please try again later.', { parse_mode: 'Markdown' });
        return false;
    }

    const user = await usersCollection.findOne({ user_id: ctx.from.id });
    if (user && user.isBanned) {
        await ctx.reply('⛔ *Access Denied*\n\nYou have been banned from using this bot.', { parse_mode: 'Markdown' });
        return false;
    }

    return true;
}

// Helper: Save user to database with referral tracking
async function saveUser(user, referredBy = null) {
    try {
        const existingUser = await usersCollection.findOne({ user_id: user.id });

        const updateDoc = {
            $set: {
                user_id: user.id,
                first_name: user.first_name,
                username: user.username,
                last_seen: new Date()
            }
        };

        if (!existingUser) {
            updateDoc.$set.joined_at = new Date();
            updateDoc.$set.referrals = 0;
            if (referredBy && referredBy !== user.id) {
                updateDoc.$set.referred_by = referredBy;
                // Increment referral count for the referrer
                await usersCollection.updateOne(
                    { user_id: referredBy },
                    { $inc: { referrals: 1 } }
                );
            }
        }

        await usersCollection.updateOne(
            { user_id: user.id },
            updateDoc,
            { upsert: true }
        );
    } catch (error) {
        console.error('Error saving user:', error);
    }
}

// Helper: Check if keyword is blocked
async function isKeywordBlocked(text) {
    if (!text) return false;
    const words = text.toLowerCase().split(/\s+/);
    const blocked = await blockedKeywordsCollection.find({}).toArray();
    const blockedWords = blocked.map(b => b.word.toLowerCase());
    return words.some(word => blockedWords.includes(word));
}

// Helper: Track search query for trending
async function trackSearch(query) {
    if (!query || query.length < 3) return;
    try {
        await trendingCollection.updateOne(
            { query: query.toLowerCase() },
            { $inc: { count: 1 }, $set: { last_searched: new Date() } },
            { upsert: true }
        );
    } catch (error) {
        console.error('Error tracking search:', error);
    }
}

// Helper: Get database stats
async function getDatabaseStats() {
    try {
        const stats = await db.stats();
        const fileCount = await filesCollection.countDocuments();
        const userCount = await usersCollection.countDocuments();

        return {
            totalFiles: fileCount,
            totalUsers: userCount,
            sizeInMB: (stats.dataSize / (1024 * 1024)).toFixed(2),
            storageSizeInMB: (stats.storageSize / (1024 * 1024)).toFixed(2)
        };
    } catch (error) {
        console.error('Error getting database stats:', error);
        return null;
    }
}

// Search files in MongoDB with fuzzy matching
async function searchFiles(query, page = 0, filters = {}) {
    try {
        const skip = page * RESULTS_PER_PAGE;
        console.log(`🔍 Search: query="${query}", page=${page}, filters=`, filters);

        // Build query with filters
        let searchQuery = {};
        const conditions = [];

        // Use regex for basic search (Escaped for safety)
        if (query) {
            conditions.push({ file_name: { $regex: new RegExp(escapeRegex(query), 'i') } });
        }

        // Add filters (Regex match against file_name for scoped filtering)
        if (filters.file_lang) {
            conditions.push({ file_name: { $regex: new RegExp(escapeRegex(filters.file_lang), 'i') } });
        }
        if (filters.year) {
            conditions.push({ file_name: { $regex: new RegExp(filters.year, 'i') } });
        }
        if (filters.quality) {
            conditions.push({ file_name: { $regex: new RegExp(escapeRegex(filters.quality), 'i') } });
        }

        if (conditions.length > 1) {
            searchQuery = { $and: conditions };
        } else if (conditions.length === 1) {
            searchQuery = conditions[0];
        }

        console.log(`📡 MongoDB Query: ${JSON.stringify(searchQuery)}`);

        const results = await filesCollection
            .find(searchQuery)
            .sort({ _id: -1 }) // Sort by ID descending (newest first approximation)
            .skip(skip)
            .limit(RESULTS_PER_PAGE + 1)
            .toArray();

        console.log(`📊 Found ${results.length} results`);

        const hasMore = results.length > RESULTS_PER_PAGE;
        const files = hasMore ? results.slice(0, RESULTS_PER_PAGE) : results;

        // If no results with regex, try fuzzy search
        if (files.length === 0 && query && !filters.file_lang && !filters.year) {
            console.log('✨ Trying fuzzy fallback...');
            const allFiles = await filesCollection.find({}).sort({ _id: -1 }).limit(1000).toArray();
            const fuse = new Fuse(allFiles, {
                keys: ['file_name'],
                threshold: 0.4,
                includeScore: true
            });

            const fuzzyResults = fuse.search(query);
            const fuzzyFiles = fuzzyResults.slice(skip, skip + RESULTS_PER_PAGE).map(r => r.item);

            return {
                files: fuzzyFiles,
                hasNext: fuzzyResults.length > skip + RESULTS_PER_PAGE,
                hasPrev: page > 0,
                currentPage: page,
                isFuzzy: true
            };
        }

        if (query && page === 0 && !filters.file_lang && !filters.year && !filters.quality) {
            await trackSearch(query);
        }

        return {
            files,
            hasNext: hasMore,
            hasPrev: page > 0,
            currentPage: page,
            isFuzzy: false
        };
    } catch (error) {
        console.error('Search error:', error);
        return { files: [], hasNext: false, hasPrev: false, currentPage: 0, isFuzzy: false };
    }
}

// Generate keyboard with shortlink support
async function generateKeyboard(files, query, page, hasNext, hasPrev, userId = null) {
    const buttons = [];

    // File buttons
    for (const file of files) {
        // Use file_ref for the link if available (shorter), otherwise fallback to _id
        const linkId = file.file_ref || file._id;
        buttons.push([
            Markup.button.url(`🎬 ${file.file_name}`, `https://t.me/${bot.botInfo.username}?start=file_${linkId}`)
        ]);
    }

    // Pagination buttons
    const paginationRow = [];
    if (hasPrev) {
        paginationRow.push(
            Markup.button.callback('⏪ Prev', `page_${query}_${page - 1}`)
        );
    }
    if (hasNext) {
        paginationRow.push(
            Markup.button.callback('Next ⏩', `page_${query}_${page + 1}`)
        );
    }

    if (paginationRow.length > 0) {
        buttons.push(paginationRow);
    }

    // Get All Files button (Only if results exist)
    if (files.length > 0) {
        buttons.push([Markup.button.callback('📥 Get All Files', `getall_${query}_${page}`)]);
    }

    // Request button if no results or just for fun
    if (files.length === 0) {
        buttons.push([Markup.button.callback('🆘 Request Movie', `req_${query}`)]);
    }

    return Markup.inlineKeyboard(buttons);
}

// Index file to MongoDB
async function indexFile(fileData) {
    try {
        // Fallback for missing file names (common in videos)
        const fileName = fileData.file_name || fileData.caption || 'Untitled Media';

        const document = {
            _id: fileData.file_id,
            file_ref: fileData.file_unique_id,
            file_name: fileName,
            file_size: fileData.file_size,
            file_type: fileData.file_type || 'document',
            mime_type: fileData.mime_type
        };

        // Check if file already exists
        const existing = await filesCollection.findOne({ _id: document._id });
        if (existing) {
            return { success: false, message: 'File already indexed', duplicate: true };
        }

        await filesCollection.insertOne(document);
        return { success: true, message: 'File indexed successfully', duplicate: false };
    } catch (error) {
        console.error('Error indexing file:', error);
        return { success: false, message: 'Error indexing file', duplicate: false };
    }
}

// Batch index files from a channel
async function batchIndexFromChannel(channelId, fromMessageId, ctx) {
    let indexed = 0;
    let duplicates = 0;
    let errors = 0;

    try {
        // Start from the forwarded message and go backwards
        let currentMessageId = fromMessageId;

        for (let i = 0; i < 1000; i++) { // Limit to prevent infinite loop
            try {
                const message = await bot.telegram.forwardMessage(
                    ctx.chat.id,
                    channelId,
                    currentMessageId
                );

                // Delete the forwarded message immediately
                await bot.telegram.deleteMessage(ctx.chat.id, message.message_id);

                const media = message.document || message.video || message.audio;
                const type = message.document ? 'document' : (message.video ? 'video' : 'audio');

                if (media) {
                    const result = await indexFile({
                        file_id: media.file_id,
                        file_unique_id: media.file_unique_id,
                        file_name: media.file_name,
                        file_size: media.file_size,
                        mime_type: media.mime_type,
                        file_type: type,
                        caption: message.caption || ''
                    });

                    if (result.success) {
                        indexed++;

                        // Log each indexed file
                        await sendLog(
                            `📥 *File Indexed*\n\n` +
                            `📁 *File:* ${media.file_name || message.caption || 'Untitled'}\n` +
                            `💾 *Size:* ${formatFileSize(media.file_size)}\n` +
                            `🆔 *Type:* ${type}\n` +
                            `📍 *From:* Channel ${channelId}`
                        );
                    } else if (result.duplicate) {
                        duplicates++;
                    }
                }

                currentMessageId--;

                // Update progress every 10 files
                if ((indexed + duplicates) % 10 === 0) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        ctx.message.message_id + 1,
                        null,
                        `⏳ Indexing in progress...\n\n✅ Indexed: ${indexed}\n⚠️ Duplicates: ${duplicates}`
                    ).catch(() => { });
                }

            } catch (error) {
                // If we can't fetch the message, we've reached the beginning
                if (error.response && error.response.error_code === 400) {
                    break;
                }
                errors++;
                currentMessageId--;
            }
        }

        return { indexed, duplicates, errors };
    } catch (error) {
        console.error('Batch indexing error:', error);
        return { indexed, duplicates, errors };
    }
}

// ===== HANDLERS - ORDER MATTERS! =====

// Handle /start command with deep link
bot.command('me', async (ctx) => {
    if (!await checkUser(ctx)) return;
    const user = await usersCollection.findOne({ user_id: ctx.from.id });
    if (!user) return;

    const profileText = `👤 *Noir Premium Profile*
    
🆔 *UID:* \`${ctx.from.id}\`
🎭 *Name:* ${ctx.from.first_name}
💎 *Status:* ${user.isPremium ? '🌟 Premium' : 'Free User'}
🤝 *Referrals:* \`${user.referrals || 0}\`
📅 *Joined:* ${user.joined_at ? new Date(user.joined_at).toLocaleDateString() : 'N/A'}

🚀 _Share your link to grow your rank!_`;

    await ctx.reply(profileText, { parse_mode: 'Markdown' });
});

// Handle check_sub action
bot.action('check_sub', async (ctx) => {
    const subscribed = await isSubscribed(ctx.from.id);
    if (subscribed) {
        await ctx.answerCbQuery('✅ Thank you for joining!');
        await ctx.editMessageText('🎉 *Thank you for joining!*\n\nYou can now search for movies directly or click /start to see the main menu.', { parse_mode: 'Markdown' });
    } else {
        await ctx.answerCbQuery('❌ You have not joined yet!', { show_alert: true });
    }
});

// Helper: Show Home/Welcome Menu
async function showWelcome(ctx) {
    const welcomeText = `🎬 *Noir Premium Filter Bot* 🍿

🚀 *The fastest way to find movies!*

✨ *Features:*
└ 🔍 AI Smart Search
└ 🗣️ Multi-Language Support
└ 💎 HD Quality Filters
└ 🤝 Referral Program

🔥 *Trending Right Now:*
${await getTrendingText()}

💡 *Just type a movie name below to start!*`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔥 Trending', 'show_trending')],
        [Markup.button.callback('🤝 Refer & Earn', 'show_refer')],
        [Markup.button.callback('📊 Stats', 'show_stats'), Markup.button.callback('❓ Help', 'show_help')]
    ]);

    if (ctx.updateType === 'callback_query') {
        try {
            await ctx.editMessageText(welcomeText, { parse_mode: 'Markdown', ...keyboard });
        } catch (e) {
            await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...keyboard });
        }
        await ctx.answerCbQuery();
    } else {
        await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...keyboard });
    }
}

// Handle show_home action
bot.action('show_home', async (ctx) => {
    return showWelcome(ctx);
});

bot.start(async (ctx) => {
    if (!await checkUser(ctx)) return;
    const startPayload = ctx.startPayload;

    // Handle referral payload
    let referredBy = null;
    if (startPayload && startPayload.startsWith('ref_')) {
        referredBy = parseInt(startPayload.replace('ref_', ''));
    }

    // Save user and log
    await saveUser(ctx.from, referredBy);

    // Check Force Subscribe
    const subscribed = await isSubscribed(ctx.from.id);
    if (!subscribed && FSUB_CHANNEL_ID) {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('📢 Join Channel', FSUB_LINK)],
            [Markup.button.callback('✅ I Have Joined', 'check_sub')]
        ]);

        await ctx.reply(
            `🍿 *Welcome to Noir Premium Filter*\n\n` +
            `To keep our library free and fast, please join our sponsor channel first!`,
            { parse_mode: 'Markdown', ...keyboard }
        );
        return;
    }

    // Check if it's a file request
    if (startPayload && startPayload.startsWith('file_')) {
        const fileId = startPayload.replace('file_', '');
        await sendFile(ctx, fileId);
        return;
    } else {
        await showWelcome(ctx);
    }
});



// Helper: Send file with auto-delete and CTA button
async function sendFile(ctx, fileId) {
    try {
        // Retrieve file by _id OR file_ref (to support both old and new links)
        const file = await filesCollection.findOne({
            $or: [{ _id: fileId }, { file_ref: fileId }]
        });

        if (!file) {
            await ctx.reply('❌ File not found or has been deleted.');
            return;
        }

        // Automatic Monetization: Forward the most recent channel post
        if (IS_GROWTH_LOCK && FSUB_CHANNEL_ID && LAST_FSUB_POST_ID) {
            const userIsPremium = await isPremium(ctx.from.id);
            if (!userIsPremium) {
                try {
                    const forwarded = await ctx.telegram.forwardMessage(ctx.from.id, FSUB_CHANNEL_ID, LAST_FSUB_POST_ID);
                    // Single-use monetization post: Auto-delete after 5 minutes (300s)
                    setTimeout(() => {
                        ctx.telegram.deleteMessage(ctx.from.id, forwarded.message_id).catch(() => { });
                    }, 300 * 1000);
                } catch (e) {
                    console.error('Error forwarding auto-monetization post:', e.message);
                }
            }
        } else if (IS_GROWTH_LOCK) {
            console.log(`📡 Monetization skipped: FSUB_ID=${!!FSUB_CHANNEL_ID}, POST_ID=${!!LAST_FSUB_POST_ID}`);
        }

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('🍿 Join Main Channel', FSUB_LINK)]
        ]);

        const deleteInMins = Math.floor(AUTO_DELETE_SECONDS / 60);
        const caption = `🎬 *${file.file_name}*\n\n` +
            `📦 *Size:* ${formatFileSize(file.file_size)}\n` +
            `⚠️ _This file will auto-delete in ${deleteInMins} minutes_`;

        let sentMsg;
        if (file.file_type === 'video') {
            sentMsg = await ctx.replyWithVideo(file._id, { caption, ...keyboard, parse_mode: 'Markdown' });
        } else if (file.file_type === 'audio') {
            sentMsg = await ctx.replyWithAudio(file._id, { caption, ...keyboard, parse_mode: 'Markdown' });
        } else {
            sentMsg = await ctx.replyWithDocument(file._id, { caption, ...keyboard, parse_mode: 'Markdown' });
        }

        setTimeout(async () => {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id);
                await ctx.reply(`❌ *File Deleted!* \n\nFiles are removed to keep our server fast. \n\n_Just search again if you missed it!_`, { parse_mode: 'Markdown' });
            } catch (error) { }
        }, AUTO_DELETE_SECONDS * 1000);
    } catch (error) {
        console.error('Error sending file:', error);
    }
}

// Handle new group members (Auto-Welcome)
bot.on('new_chat_members', async (ctx) => {
    const chatTitle = ctx.chat.title;
    const userNames = ctx.message.new_chat_members.map(m => m.first_name).join(', ');

    const welcomeMsg = `🎬 *Welcome to ${chatTitle}!* 🍿\n\n` +
        `Hello ${userNames}! 🥤\n\n` +
        `🚀 *How to find movies?*\n` +
        `Just type the movie name in this group or start me in PM!\n\n` +
        `Powered by Noir Advanced Indexer`;

    await ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
});

async function getTrendingText() {
    try {
        const trending = await trendingCollection.find({}).sort({ count: -1 }).limit(5).toArray();
        if (trending.length === 0) return '_No trending yet_';
        return trending.map((t, i) => `${i + 1}. \`${t.query}\``).join('\n');
    } catch (error) {
        return '_Error loading trending_';
    }
}

// Handle /stats command (admin only)
bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.reply('⛔ This command is only available for admins.');
        return;
    }

    const stats = await getDatabaseStats();
    const uptime = getUptime();

    if (stats) {
        const statsText = `📊 *Bot Statistics*

⏱️ *Uptime:* ${uptime}
📁 *Total Files:* ${stats.totalFiles}
💾 *Database Size:* ${stats.sizeInMB} MB

🤖 *Bot Info:*
👤 Admin: ${ctx.from.first_name}
🆔 User ID: ${ctx.from.id}`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'show_home')]
        ]);

        if (ctx.updateType === 'callback_query') {
            await ctx.editMessageText(statsText, { parse_mode: 'Markdown', ...keyboard });
            await ctx.answerCbQuery();
        } else {
            await ctx.reply(statsText, { parse_mode: 'Markdown', ...keyboard });
        }
    } else {
        await ctx.answerCbQuery('Error fetching stats');
    }
});

// Handle show_stats button callback
bot.action('show_stats', async (ctx) => {
    const stats = await getDatabaseStats();
    const uptime = getUptime();

    if (stats) {
        const statsText = `📊 *Bot Statistics*

⏱️ *Uptime:* ${uptime}
📁 *Total Files:* ${stats.totalFiles}
💾 *Database Size:* ${stats.sizeInMB} MB

👤 User: ${ctx.from.first_name}
🆔 ID: ${ctx.from.id}`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', 'show_home')]
        ]);

        await ctx.editMessageText(statsText, { parse_mode: 'Markdown', ...keyboard });
        await ctx.answerCbQuery();
    } else {
        await ctx.answerCbQuery('Error fetching stats');
    }
});

// Handle referral button
bot.action('show_refer', async (ctx) => {
    const user = await usersCollection.findOne({ user_id: ctx.from.id });
    const refLink = `https://t.me/${bot.botInfo.username}?start=ref_${ctx.from.id}`;
    const refCount = user.referrals || 0;

    const referText = `🤝 *Noir Referral Program*

Invite your friends and grow our community! 

📈 *Your Stats:* 
└ Referred Users: \`${refCount}\` 

🔗 *Your Unique Link:* 
\`${refLink}\` 

_Copy and share this link to earn referrals!_`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back', 'show_home')]
    ]);

    await ctx.answerCbQuery();
    await ctx.editMessageText(referText, { parse_mode: 'Markdown', ...keyboard });
});

// Handle request button action
bot.action(/^req_(.+)$/, async (ctx) => {
    const query = ctx.match[1];

    // Save request
    await requestsCollection.updateOne(
        { query: query.toLowerCase() },
        { $inc: { count: 1 }, $set: { last_requested: new Date() } },
        { upsert: true }
    );

    await ctx.answerCbQuery('✅ Movie Requested!', { show_alert: true });
    await ctx.editMessageText(`✅ *Requested:* \`${query}\`\n\nAdmins have been notified. We will add it soon!`, { parse_mode: 'Markdown' });

    // Notify logs
    await sendLog(
        `🆘 *New Movie Request*\n\n` +
        `🔍 *Query:* \`${query}\`\n` +
        `👤 *User:* ${ctx.from.first_name} (${ctx.from.id})`
    );
});

// Broadcast command (admin only)
bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const message = ctx.message.reply_to_message;
    if (!message) {
        return ctx.reply('❌ Reply to a message to broadcast it.');
    }

    const m = await ctx.reply('⏳ Broadcasting message...');
    const users = await usersCollection.find({}).toArray();
    let success = 0;
    let failed = 0;

    for (const user of users) {
        try {
            await ctx.telegram.copyMessage(user.user_id, ctx.chat.id, message.message_id);
            success++;
        } catch (error) {
            failed++;
        }
    }

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        m.message_id,
        null,
        `✅ *Broadcast Complete*\n\n` +
        `👤 *Total Users:* ${users.length}\n` +
        `✅ *Success:* ${success}\n` +
        `❌ *Failed:* ${failed}`,
        { parse_mode: 'Markdown' }
    );
});

// Block Keyword
bot.command('block', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const word = ctx.message.text.split(' ')[1];
    if (!word) return ctx.reply('Usage: /block <word>');
    await blockedKeywordsCollection.updateOne({ word: word.toLowerCase() }, { $set: { word: word.toLowerCase() } }, { upsert: true });
    await ctx.reply(`✅ *Blocked:* \`${word}\``, { parse_mode: 'Markdown' });
});

// Admin File Deletion Command
bot.command('delete', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const query = ctx.message.text.split(' ').slice(1).join(' ');
    if (!query) return ctx.reply('Usage: /delete <movie name>');

    const searchResult = await searchFiles(query, 0);
    if (searchResult.files.length === 0) {
        return ctx.reply(`❌ No files found for \`${query}\``, { parse_mode: 'Markdown' });
    }

    const buttons = searchResult.files.map(file => [
        Markup.button.callback(`🗑️ ${file.file_name}`, `delete_confirm_${file._id}`)
    ]);

    await ctx.reply(`🛠️ *Select file to delete from Database:*`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
});

// Unblock Keyword
bot.command('unblock', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const word = ctx.message.text.split(' ')[1];
    if (!word) return ctx.reply('Usage: /unblock <word>');
    await blockedKeywordsCollection.deleteOne({ word: word.toLowerCase() });
    await ctx.reply(`✅ *Unblocked:* \`${word}\``, { parse_mode: 'Markdown' });
});

// Set Premium
bot.command('premium', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (!uid) return ctx.reply('Usage: /premium <uid>');
    await usersCollection.updateOne({ user_id: uid }, { $set: { isPremium: true } }, { upsert: true });
    await ctx.reply(`🌟 *User ${uid} is now Premium!*`, { parse_mode: 'Markdown' });
});

// Remove Premium
bot.command('unpremium', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (!uid) return ctx.reply('Usage: /unpremium <uid>');
    await usersCollection.updateOne({ user_id: uid }, { $set: { isPremium: false } }, { upsert: true });
    await ctx.reply(`❌ *User ${uid} premium status removed.*`, { parse_mode: 'Markdown' });
});

// Admin Dashboard
bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const stats = await getDatabaseStats();
    const adminText = `🛠️ *Admin Dashboard*

🚦 *Maintenance:* ${IS_MAINTENANCE ? '🔴 ON' : '🟢 OFF'}
👁️ *Monetization:* ${IS_GROWTH_LOCK ? '🟢 AUTO' : '🔴 DISABLED'}
🌐 *APP URL:* \`${process.env.APP_URL || 'Not Set'}\`
� *Ping Status:* \`${LAST_PING_STATUS}\`

�📊 *Total Stats:* 
└ Users: \`${stats.totalUsers}\` 
└ Files: \`${stats.totalFiles}\``;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(IS_MAINTENANCE ? '🟢 Disable Mnt' : '🔴 Enable Mnt', 'toggle_mnt')],
        [Markup.button.callback(IS_GROWTH_LOCK ? '🔴 Disable Crypto Mode' : '🟢 Enable Crypto Mode', 'toggle_gl')],
        [Markup.button.callback('🔄 Refresh Stats', 'refresh_admin')]
    ]);

    await ctx.reply(adminText, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('toggle_gl', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    IS_GROWTH_LOCK = !IS_GROWTH_LOCK;
    await settingsCollection.updateOne({ key: 'growth_lock' }, { $set: { value: IS_GROWTH_LOCK } }, { upsert: true });
    await ctx.answerCbQuery(`Monetization ${IS_GROWTH_LOCK ? 'Enabled' : 'Disabled'}`);
    return triggerAdminRefresh(ctx);
});

// 🗑️ setpost command removed (Now Fully Automatic)

// 🗑️ setpost command removed for simplicity

bot.action('toggle_mnt', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    IS_MAINTENANCE = !IS_MAINTENANCE;
    await settingsCollection.updateOne({ key: 'maintenance' }, { $set: { value: IS_MAINTENANCE } }, { upsert: true });
    await ctx.answerCbQuery(`Maintenance ${IS_MAINTENANCE ? 'Enabled' : 'Disabled'}`);
    // Refresh dashboard
    return triggerAdminRefresh(ctx);
});

bot.action('refresh_admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery('Refreshed!');
    return triggerAdminRefresh(ctx);
});

async function triggerAdminRefresh(ctx) {
    const stats = await getDatabaseStats();
    const adminText = `🛠️ *Admin Dashboard*

🚦 *Maintenance:* ${IS_MAINTENANCE ? '🔴 ON' : '🟢 OFF'}
👁️ *Monetization:* ${IS_GROWTH_LOCK ? '🟢 AUTO' : '🔴 DISABLED'}
📍 *Tracking:* \`${FSUB_CHANNEL_ID || 'Not Set'}\`
📦 *Last Post:* \`${LAST_FSUB_POST_ID || 'Waiting...'}\`
🌐 *URL:* \`${process.env.APP_URL || 'Not Set'}\`
📡 *Ping:* \`${LAST_PING_STATUS}\`

📊 *Total Stats:* 
└ Users: \`${stats.totalUsers}\` 
└ Files: \`${stats.totalFiles}\``;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(IS_MAINTENANCE ? '🟢 Disable Mnt' : '🔴 Enable Mnt', 'toggle_mnt')],
        [Markup.button.callback(IS_GROWTH_LOCK ? '🔴 Disable Crypto' : '🟢 Enable Crypto', 'toggle_gl')],
        [Markup.button.callback('🔄 Refresh Stats', 'refresh_admin')]
    ]);

    await ctx.editMessageText(adminText, { parse_mode: 'Markdown', ...keyboard }).catch(() => { });
}

// Handle trending action
bot.action('show_trending', async (ctx) => {
    const trendingText = await getTrendingText();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back', 'show_home')]
    ]);
    await ctx.answerCbQuery();
    await ctx.editMessageText(`🔥 *Trending Movies This Week:*\n\n${trendingText}\n\n_Type any of these to get them!_`, { parse_mode: 'Markdown', ...keyboard });
});

// Handle help button callback
bot.action('show_help', async (ctx) => {
    const helpText = `🎬 *Noir Premium Help Menu* 🍿
...
_Powered by Noir Advanced Indexer_`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back', 'show_home')]
    ]);

    await ctx.answerCbQuery();
    await ctx.editMessageText(helpText, { parse_mode: 'Markdown', ...keyboard });
});

// Handle getall callback
bot.action(/^getall_(.+)_(\d+)$/, async (ctx) => {
    try {
        const query = ctx.match[1];
        const page = parseInt(ctx.match[2]);

        const searchResult = await searchFiles(query, page);

        if (searchResult.files.length === 0) {
            await ctx.answerCbQuery('No files found');
            return;
        }

        await ctx.answerCbQuery('Sending files to your PM...');

        for (const file of searchResult.files) {
            const caption = `🎬 *${file.file_name}*\n\n📦 *Size:* ${formatFileSize(file.file_size)}`;
            try {
                if (file.file_type === 'video') {
                    await ctx.telegram.sendVideo(ctx.from.id, file._id, { caption, parse_mode: 'Markdown' });
                } else if (file.file_type === 'audio') {
                    await ctx.telegram.sendAudio(ctx.from.id, file._id, { caption, parse_mode: 'Markdown' });
                } else {
                    await ctx.telegram.sendDocument(ctx.from.id, file._id, { caption, parse_mode: 'Markdown' });
                }
            } catch (err) {
                console.error(`Error sending file ${file._id} to PM:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error handling getall:', error);
        await ctx.answerCbQuery('Error sending files');
    }
});

// Handle pagination callbacks
bot.action(/^page_(.+)_(\d+)$/, async (ctx) => {
    try {
        const query = ctx.match[1];
        const page = parseInt(ctx.match[2]);

        const searchResult = await searchFiles(query, page);

        if (searchResult.files.length === 0) {
            await ctx.answerCbQuery('No more results');
            return;
        }

        const keyboard = await generateKeyboard(
            searchResult.files,
            query,
            page,
            searchResult.hasNext,
            searchResult.hasPrev,
            ctx.from.id
        );

        const resultText = searchResult.isFuzzy
            ? `🔍 Fuzzy results for "${query}"\nPage ${page + 1}`
            : `🔍 Found results for "${query}"\nPage ${page + 1}`;

        await ctx.editMessageText(resultText, keyboard);
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error handling pagination:', error);
        await ctx.answerCbQuery('Error loading page');
    }
});

// Handle filter callbacks
bot.action(/^filter_(lang|year|qual)_(.+)$/, async (ctx) => {
    const filterType = ctx.match[1];
    const query = ctx.match[2];

    // Extract unique items from search results
    const searchResult = await searchFiles(query, 0);
    const items = new Set();

    if (filterType === 'lang') {
        searchResult.files.forEach(file => {
            const parsed = parseFileName(file.file_name);
            if (parsed.file_lang) items.add(parsed.file_lang);
        });
    } else if (filterType === 'year') {
        ['2025', '2024', '2023', '2022', '2021', '2020'].forEach(year => items.add(year));
    } else if (filterType === 'qual') {
        ['4K', '1080p', '720p', '480p', 'Cam'].forEach(q => items.add(q));
    }

    if (items.size === 0) {
        const typeName = filterType === 'lang' ? 'languages' : (filterType === 'year' ? 'years' : 'qualities');
        await ctx.answerCbQuery(`No ${typeName} found`);
        return;
    }

    // Create filter buttons (grid style for better look)
    const buttons = [];
    const itemList = Array.from(items);
    for (let i = 0; i < itemList.length; i += 2) {
        const row = [Markup.button.callback(itemList[i], `apply_${filterType}_${itemList[i]}_${query}`)];
        if (itemList[i + 1]) {
            row.push(Markup.button.callback(itemList[i + 1], `apply_${filterType}_${itemList[i + 1]}_${query}`));
        }
        buttons.push(row);
    }

    buttons.push([Markup.button.callback('« Back to Results', `back_${query}`)]);

    const title = filterType === 'lang' ? 'Language' : (filterType === 'year' ? 'Year' : 'Quality');
    await ctx.editMessageText(
        `Select ${title}:`,
        { reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
    );
    await ctx.answerCbQuery();
});

// Handle apply filter callbacks
bot.action(/^apply_(lang|year|qual)_(.+)_(.+)$/, async (ctx) => {
    const filterType = ctx.match[1];
    const filterValue = ctx.match[2];
    const query = ctx.match[3];

    let filters = {};
    if (filterType === 'lang') filters.file_lang = filterValue;
    else if (filterType === 'year') filters.year = filterValue;
    else if (filterType === 'qual') filters.quality = filterValue;

    const searchResult = await searchFiles(query, 0, filters);

    if (searchResult.files.length === 0) {
        await ctx.answerCbQuery('No results with this filter');
        return;
    }

    const keyboard = await generateKeyboard(
        searchResult.files,
        query,
        0,
        searchResult.hasNext,
        searchResult.hasPrev,
        ctx.from.id
    );

    const typeTitle = filterType === 'lang' ? 'Language' : (filterType === 'year' ? 'Year' : 'Quality');
    await ctx.editMessageText(
        `🔍 Results for "${query}" (${typeTitle}: ${filterValue})`,
        keyboard
    );
    await ctx.answerCbQuery();
});

// Handle back button
bot.action(/^delete_confirm_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const fileId = ctx.match[1];
    // Find by _id or file_ref
    const file = await filesCollection.findOne({
        $or: [{ _id: fileId }, { file_ref: fileId }]
    });

    if (!file) {
        return ctx.answerCbQuery('❌ File not found in DB', { show_alert: true });
    }

    const keyboard = Markup.inlineKeyboard([
        // Pass fileId (which might be file_ref) to execute
        [Markup.button.callback('✅ Yes, Delete', `delete_execute_${fileId}`)],
        [Markup.button.callback('❌ Cancel', 'delete_cancel')]
    ]);

    await ctx.editMessageText(
        `⚠️ *Are you sure you want to delete this file?*\n\n` +
        `📁 *Name:* ${file.file_name}\n` +
        // Show file_ref if that's what we matched, or just a truncated ID
        `🆔 *ID Ref:* \`${fileId.substring(0, 15)}...\`\n\n` +
        `This action cannot be undone.`,
        { parse_mode: 'Markdown', ...keyboard }
    );
    await ctx.answerCbQuery();
});

bot.action(/^delete_execute_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const fileId = ctx.match[1];

    // Find first to get details (optional but good for logs)
    const file = await filesCollection.findOne({
        $or: [{ _id: fileId }, { file_ref: fileId }]
    });

    if (file) {
        // Delete by _id from the found file
        await filesCollection.deleteOne({ _id: file._id });
        await ctx.editMessageText(`✅ *Deleted Successfully!*\n\n📁 ${file.file_name}`, { parse_mode: 'Markdown' });

        await sendLog(
            `🗑️ *File Deleted by Admin*\n\n` +
            `📁 *File:* ${file.file_name}\n` +
            `🆔 *ID:* \`${fileId}\`\n` +
            `👤 *Admin:* ${ctx.from.first_name} (${ctx.from.id})`
        );
    } else {
        await ctx.editMessageText('❌ File was already deleted or not found.');
    }
    await ctx.answerCbQuery('Deleted!');
});

bot.action('delete_cancel', async (ctx) => {
    await ctx.editMessageText('❌ Deletion cancelled.');
    await ctx.answerCbQuery();
});

// Handle back button
bot.action(/^back_(.+)$/, async (ctx) => {
    const query = ctx.match[1];
    const searchResult = await searchFiles(query, 0);

    const keyboard = await generateKeyboard(
        searchResult.files,
        query,
        0,
        searchResult.hasNext,
        searchResult.hasPrev,
        ctx.from.id
    );

    await ctx.editMessageText(
        `🔍 Found results for "${query}"\nPage 1`,
        keyboard
    );
    await ctx.answerCbQuery();
});

// Handle indexing confirmation
bot.action(/^confirm_index_(.+)_(.+)$/, async (ctx) => {
    const channelId = parseInt(ctx.match[1]);
    const messageId = parseInt(ctx.match[2]);

    await ctx.answerCbQuery('Starting indexing...');
    await ctx.editMessageText('⏳ Starting batch indexing...\n\nThis may take a while. Please wait...');

    // Log indexing start
    await sendLog(
        `🚀 *Batch Indexing Started*\n\n` +
        `📍 *Channel ID:* ${channelId}\n` +
        `📨 *From Message:* ${messageId}\n` +
        `👤 *Admin:* ${ctx.from.first_name} (${ctx.from.id})\n` +
        `⏰ *Started:* ${new Date().toLocaleString()}`
    );

    const result = await batchIndexFromChannel(channelId, messageId, ctx);

    const summaryText = `✅ *Indexing Complete!*\n\n` +
        `📥 *Indexed:* ${result.indexed} files\n` +
        `⚠️ *Duplicates:* ${result.duplicates}\n` +
        `❌ *Errors:* ${result.errors}`;

    await ctx.editMessageText(summaryText, { parse_mode: 'Markdown' });

    // Log indexing completion
    await sendLog(
        `✅ *Batch Indexing Completed*\n\n` +
        `📥 *Indexed:* ${result.indexed} files\n` +
        `⚠️ *Duplicates:* ${result.duplicates}\n` +
        `❌ *Errors:* ${result.errors}\n` +
        `👤 *Admin:* ${ctx.from.first_name} (${ctx.from.id})\n` +
        `⏰ *Completed:* ${new Date().toLocaleString()}`
    );
});

// Handle indexing cancellation
bot.action(/^cancel_index$/, async (ctx) => {
    await ctx.answerCbQuery('Indexing cancelled');
    await ctx.editMessageText('❌ Indexing cancelled.');
});

// Handle forwarded messages from channels (admin only)
bot.on('forward_from_chat', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const forwardedFrom = ctx.message.forward_from_chat;

    if (forwardedFrom.type === 'channel') {
        const channelId = forwardedFrom.id;
        const messageId = ctx.message.forward_from_message_id;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Index', `confirm_index_${channelId}_${messageId}`),
                Markup.button.callback('❌ Cancel', 'cancel_index')
            ]
        ]);

        await ctx.reply(
            `📋 *Batch Indexing Confirmation*\n\n` +
            `📍 *Channel:* ${forwardedFrom.title}\n` +
            `🆔 *Channel ID:* \`${channelId}\`\n` +
            `📨 *From Message ID:* ${messageId}\n\n` +
            `⚠️ This will index all files from this message backwards.\n\n` +
            `Do you want to proceed?`,
            { parse_mode: 'Markdown', ...keyboard }
        );
    }
});

// Handle all channel posts (for monetization tracking and indexing)
bot.on('channel_post', async (ctx) => {
    const message = ctx.channelPost;
    const chatId = ctx.chat.id;

    console.log(`📡 Channel post received from ID: ${chatId}`);

    // 1. Monetization: Track the latest post from Force-Sub Channel
    if (FSUB_CHANNEL_ID && chatId === FSUB_CHANNEL_ID) {
        LAST_FSUB_POST_ID = message.message_id;
        await settingsCollection.updateOne({ key: 'last_fsub_post' }, { $set: { value: LAST_FSUB_POST_ID } }, { upsert: true });
        console.log(`📈 Monetization updated: Last post ID ${LAST_FSUB_POST_ID} from FSUB channel`);
    }

    // 2. Auto-indexing from Database Channel
    if (DATABASE_CHANNEL_ID && chatId === DATABASE_CHANNEL_ID) {
        const media = message.document || message.video || message.audio;
        const type = message.document ? 'document' : (message.video ? 'video' : 'audio');

        console.log(`📂 DB Channel activity detected. Type: ${media ? type : 'none'}`);

        if (media) {
            const result = await indexFile({
                file_id: media.file_id,
                file_unique_id: media.file_unique_id,
                file_name: media.file_name,
                file_size: media.file_size,
                mime_type: media.mime_type,
                file_type: type,
                caption: message.caption || ''
            });

            if (result.success) {
                console.log(`📥 Auto-indexed from channel: ${media.file_name || 'Media'}`);
                await sendLog(
                    `📥 *Auto-Indexed from Database Channel*\n\n` +
                    `📁 *Name:* \`${media.file_name || message.caption || 'Untitled'}\`\n` +
                    `💾 *Size:* ${formatFileSize(media.file_size)}\n` +
                    `🆔 *Type:* ${type}\n` +
                    `✨ *Status:* Success`
                );
            } else {
                console.log(`⚠️ Indexing failed: ${result.message}`);
            }
        }
    }
});

// Handle document/media messages from Admin (Manual Indexing)
bot.on(['document', 'video', 'audio'], async (ctx) => {
    if (ctx.chat.type === 'private' && isAdmin(ctx.from.id)) {
        const media = ctx.message.document || ctx.message.video || ctx.message.audio;
        const type = ctx.message.document ? 'document' : (ctx.message.video ? 'video' : 'audio');

        const result = await indexFile({
            file_id: media.file_id,
            file_unique_id: media.file_unique_id,
            file_name: media.file_name,
            file_size: media.file_size,
            mime_type: media.mime_type,
            file_type: type,
            caption: ctx.message.caption || ''
        });

        if (result.success) {
            await ctx.reply(`✅ Indexed Successfully!\n📁 ${media.file_name || ctx.message.caption || 'Untitled'}\n🆔 Type: ${type}`);
            await sendLog(
                `📥 *Manual Media Indexed*\n\n` +
                `📁 *Name:* ${media.file_name || ctx.message.caption || 'Untitled'}\n` +
                `💾 *Size:* ${formatFileSize(media.file_size)}\n` +
                `🆔 *Type:* ${type}\n` +
                `👤 *Admin:* ${ctx.from.first_name} (${ctx.from.id})`
            );
        } else if (result.duplicate) {
            // Use file_unique_id (file_ref) for callback to avoid length limits
            const callbackId = media.file_unique_id;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🗑️ Delete from DB', `delete_confirm_${callbackId}`)]
            ]);
            await ctx.reply(`⚠️ *Media already indexed:*\n📁 ${media.file_name || ctx.message.caption || 'Untitled'}\n\nDo you want to remove it?`, { parse_mode: 'Markdown', ...keyboard });
        } else {
            await ctx.reply(`⚠️ ${result.message}`);
        }
    }
});


// Handle bot added to group
bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;

    // Bot was added to a group/channel
    if ((oldStatus === 'left' || oldStatus === 'kicked') &&
        (newStatus === 'member' || newStatus === 'administrator')) {

        const chat = update.chat;
        const isAdmin = newStatus === 'administrator';

        await sendLog(
            `➕ *Bot Added to ${chat.type === 'channel' ? 'Channel' : 'Group'}*\n\n` +
            `📍 *Name:* ${chat.title}\n` +
            `🆔 *Chat ID:* \`${chat.id}\`\n` +
            `👤 *Added by:* ${ctx.from.first_name} (${ctx.from.id})\n` +
            `👑 *Admin Rights:* ${isAdmin ? '✅ Yes' : '❌ No'}\n` +
            `⏰ *Time:* ${new Date().toLocaleString()}`
        );
    }
});

// Handle keyword search in groups and PMs
bot.on('text', async (ctx) => {
    if (!await checkUser(ctx)) return;
    const message = ctx.message.text.trim();

    // Group Anti-Link: Delete links from non-admins
    if (ctx.chat.type !== 'private') {
        const linkRegex = /https?:\/\/[^\s]+|www\.[^\s]+|t\.me\/[^\s]+/i;
        if (linkRegex.test(message)) {
            const member = await ctx.getChatMember(ctx.from.id);
            if (!['administrator', 'creator'].includes(member.status)) {
                try {
                    await ctx.deleteMessage();
                    return; // Don't process the message further
                } catch (e) { }
            }
        }
    }

    // Keyword Blocking
    if (await isKeywordBlocked(message)) {
        if (ctx.chat.type === 'private') {
            await ctx.reply('⚠️ *Search restricted:* This keyword is blocked due to safety policies.', { parse_mode: 'Markdown' });
        }
        return;
    }

    // Ignore commands
    if (message.startsWith('/')) {
        return;
    }

    // Check Force Subscribe
    const subscribed = await isSubscribed(ctx.from.id);
    if (!subscribed && FSUB_CHANNEL_ID) {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('📢 Join Channel', FSUB_LINK)],
            [Markup.button.callback('✅ I Have Joined', 'check_sub')]
        ]);

        await ctx.reply(
            `❌ *Access Denied!*\n\n` +
            `You must join our channel to use this bot.\n\n` +
            `Please join and click the button below:`,
            { parse_mode: 'Markdown', ...keyboard }
        );
        return;
    }

    // Ignore empty messages
    if (message.length === 0) {
        return;
    }

    try {
        const startTime = Date.now();
        const searchResult = await searchFiles(message, 0);
        const endTime = Date.now();
        const timeTaken = ((endTime - startTime) / 1000).toFixed(2);

        if (searchResult.files.length === 0) {
            // Only reply to failed searches in PM, or if it's explicitly a command-like text in groups
            if (ctx.chat.type === 'private' || message.includes('movie') || message.includes('film')) {
                await ctx.reply(`❌ No results found for "${message}"\n\n💡 Try different keywords or check spelling`,
                    { reply_to_message_id: ctx.message.message_id, ...await generateKeyboard([], message, 0, false, false, ctx.from.id) });
            }
            return;
        }

        const keyboard = await generateKeyboard(
            searchResult.files,
            message,
            0,
            searchResult.hasNext,
            searchResult.hasPrev,
            ctx.from.id
        );

        const resultHeader = `👤 *User ID:* \`${ctx.from.id}\`\n⏱️ *Time Taken:* \`${timeTaken}s\`\n\n`;

        const resultText = searchResult.isFuzzy
            ? `${resultHeader}🔍 *Fuzzy results for* "${message}"\nPage 1\n\n💡 _Showing closest matches_`
            : `${resultHeader}🔍 *Found results for* "${message}"\nPage 1`;

        const sentMsg = await ctx.reply(resultText, {
            parse_mode: 'Markdown',
            reply_to_message_id: ctx.message.message_id,
            ...keyboard
        });

        // Group Auto-Cleaner: Delete search result in groups after 5 minutes
        if (ctx.chat.type !== 'private') {
            setTimeout(async () => {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id);
                    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id); // Delete user's query too
                } catch (error) { }
            }, 300 * 1000);
        }
    } catch (error) {
        console.error('Error handling search:', error);
        await ctx.reply('❌ An error occurred while searching. Please try again.');
    }
});

// Handle errors
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
});

// Start the bot
async function startBot() {
    await connectDB();

    // Get bot info
    const botInfo = await bot.telegram.getMe();
    bot.botInfo = botInfo;
    console.log(`✅ Bot username: @${botInfo.username}`);

    if (ADMIN_IDS.length > 0) {
        console.log(`✅ Admin IDs configured: ${ADMIN_IDS.join(', ')}`);
    }

    if (DATABASE_CHANNEL_ID) {
        console.log(`✅ Auto-indexing enabled from channel: ${DATABASE_CHANNEL_ID}`);
    }

    if (LOG_CHANNEL_ID) {
        console.log(`✅ Logging enabled to channel: ${LOG_CHANNEL_ID}`);

        // Send bot startup log
        await sendLog(
            `🚀 *Bot Started*\n\n` +
            `🤖 *Bot:* @${botInfo.username}\n` +
            `⏰ *Time:* ${new Date().toLocaleString()}\n` +
            `📊 *Version:* 2.0 (Advanced Features)`
        );
    }

    await bot.launch();
    console.log('✅ Bot is running with all advanced features...');
    console.log(`⏱️  Auto-delete timer: ${AUTO_DELETE_SECONDS} seconds`);

    // Self-pinging utility to keep the bot alive (Improved for Koyeb)
    const APP_URL = process.env.APP_URL;
    if (APP_URL) {
        const httpLib = APP_URL.startsWith('https') ? require('https') : require('http');
        console.log(`🚀 Self-ping enabled for: ${APP_URL}`);

        setInterval(() => {
            const startTime = Date.now();
            httpLib.get(APP_URL, (res) => {
                const latency = Date.now() - startTime;
                LAST_PING_STATUS = `✅ OK (${res.statusCode}) - ${latency}ms`;
                LAST_PING_TIME = new Date();
                if (res.statusCode !== 200) {
                    console.warn(`📡 Self-ping warning: Status ${res.statusCode}`);
                }
            }).on('error', (err) => {
                LAST_PING_STATUS = `❌ Error: ${err.message}`;
                LAST_PING_TIME = new Date();
                console.error('❌ Self-ping error:', err.message);
            });
        }, 60 * 1000); // Ping every 60 seconds (Standard for keeping free tiers awake)
    } else {
        LAST_PING_STATUS = '⚠️ APP_URL not set';
    }

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

startBot();
