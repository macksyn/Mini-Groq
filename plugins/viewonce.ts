import type { BotContext } from '../types.js';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { writeFile, readFile, unlink, stat, readdir, mkdir } from 'fs/promises';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';

// ===================== Constants =====================
const TEMP_DIR = path.join(process.cwd(), 'temp', 'viewonce');
const METADATA_FILE = dataFile('viewonce_cache.json');
const CONFIG_KEY = 'viewonce';

const HAS_DB = !!(process.env.MONGO_URL || process.env.POSTGRES_URL || process.env.MYSQL_URL || process.env.DB_URL);
const DEFAULT_DESTINATION = process.env.OWNER_NUMBER || (process.env.SUDO_NUMBER || '');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===================== In-memory cache =====================
type ViewOnceEntry = {
    id: string;
    sender: string;
    group?: string;
    mediaType: 'image' | 'video' | 'sticker' | 'audio';
    mediaPath: string;
    caption: string;
    timestamp: string;
};

const cache = new Map<string, ViewOnceEntry>();
let cacheLoaded = false;

// ===================== Config helpers =====================
async function getConfig() {
    try {
        if (HAS_DB) {
            const cfg = await store.getSetting('global', CONFIG_KEY);
            return cfg || { enabled: false, destination: DEFAULT_DESTINATION };
        } else {
            const cfgPath = dataFile('viewonce.json');
            if (!fs.existsSync(cfgPath)) return { enabled: false, destination: DEFAULT_DESTINATION };
            return JSON.parse(await readFile(cfgPath, 'utf-8'));
        }
    } catch {
        return { enabled: false, destination: DEFAULT_DESTINATION };
    }
}

async function saveConfig(config: any) {
    try {
        if (HAS_DB) {
            await store.saveSetting('global', CONFIG_KEY, config);
        } else {
            await writeFile(dataFile('viewonce.json'), JSON.stringify(config, null, 2));
        }
    } catch (e) {
        console.error('ViewOnce config save error:', e);
    }
}

// ===================== Cache persistence =====================
async function loadCache() {
    if (cacheLoaded) return;
    try {
        if (HAS_DB) {
            const stored = await store.getSetting('global', CONFIG_KEY + '_cache');
            if (stored) {
                const entries = Object.values(stored) as ViewOnceEntry[];
                entries.forEach(e => cache.set(e.id, e));
            }
        } else {
            if (fs.existsSync(METADATA_FILE)) {
                const data = await readFile(METADATA_FILE, 'utf-8');
                const entries = JSON.parse(data) as ViewOnceEntry[];
                entries.forEach(e => cache.set(e.id, e));
            }
        }
    } catch (e) { console.error('ViewOnce cache load error:', e); }
    cacheLoaded = true;
}

let saveTimeout: NodeJS.Timeout | null = null;
async function saveCache() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            const entries = Array.from(cache.values());
            if (HAS_DB) {
                await store.saveSetting('global', CONFIG_KEY + '_cache', entries);
            } else {
                await writeFile(METADATA_FILE, JSON.stringify(entries, null, 2));
            }
        } catch (e) { console.error('ViewOnce cache save error:', e); }
        saveTimeout = null;
    }, 1000);
}

async function addEntry(entry: ViewOnceEntry) {
    cache.set(entry.id, entry);
    await saveCache();
}

function getEntry(id: string) { return cache.get(id); }

// ===================== Download helper =====================
async function downloadMedia(mediaMessage: any, type: 'image' | 'video' | 'sticker' | 'audio', ext: string): Promise<string> {
    const stream = await downloadContentFromMessage(mediaMessage, type);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = path.join(TEMP_DIR, fileName);
    await writeFile(filePath, buffer);
    return filePath;
}

// ===================== Main auto-capture handler =====================
export async function handleViewOnceMessage(sock: any, message: any) {
    try {
        const config = await getConfig();
        if (!config.enabled) return;

        const container =
            message.message?.viewOnceMessageV2?.message ||
            message.message?.viewOnceMessage?.message;
        if (!container) return;

        const msgKey = message.key;
        const id = msgKey.id;
        if (!id) return;

        let mediaType: 'image' | 'video' | 'sticker' | 'audio' | null = null;
        let mediaPath = '';
        let caption = '';

        if (container.imageMessage) {
            mediaType = 'image';
            caption = container.imageMessage.caption || '';
            mediaPath = await downloadMedia(container.imageMessage, 'image', 'jpg');
        } else if (container.videoMessage) {
            mediaType = 'video';
            caption = container.videoMessage.caption || '';
            mediaPath = await downloadMedia(container.videoMessage, 'video', 'mp4');
        } else if (container.stickerMessage) {
            mediaType = 'sticker';
            caption = container.stickerMessage.caption || '';
            mediaPath = await downloadMedia(container.stickerMessage, 'sticker', 'webp');
        } else if (container.audioMessage) {
            mediaType = 'audio';
            caption = container.audioMessage.caption || '';
            const mime = container.audioMessage.mimetype || '';
            const ext = mime.includes('mpeg') ? 'mp3' : (mime.includes('ogg') ? 'ogg' : 'mp3');
            mediaPath = await downloadMedia(container.audioMessage, 'audio', ext);
        } else {
            return;
        }

        const sender = msgKey.participant || msgKey.remoteJid;
        const group = msgKey.remoteJid.endsWith('@g.us') ? msgKey.remoteJid : undefined;

        const entry: ViewOnceEntry = {
            id,
            sender,
            group,
            mediaType,
            mediaPath,
            caption,
            timestamp: new Date().toISOString(),
        };
        await addEntry(entry);

        const dest = config.destination || DEFAULT_DESTINATION;
        if (!dest) {
            console.warn('ViewOnce: No destination number set.');
            return;
        }

        const senderName = sender.split('@')[0];
        const captionText = `*📸 View‑Once ${mediaType}*\nFrom: @${senderName}\n${caption ? '\n' + caption : ''}`;

        const mediaOptions: any = {
            caption: captionText,
            mentions: [sender],
        };

        switch (mediaType) {
            case 'image':
                await sock.sendMessage(dest, { image: { url: mediaPath }, ...mediaOptions });
                break;
            case 'video':
                await sock.sendMessage(dest, { video: { url: mediaPath }, ...mediaOptions });
                break;
            case 'sticker':
                await sock.sendMessage(dest, { sticker: { url: mediaPath }, ...mediaOptions });
                break;
            case 'audio':
                await sock.sendMessage(dest, {
                    audio: { url: mediaPath },
                    mimetype: 'audio/mpeg',
                    ptt: false,
                });
                break;
        }
        console.log(`✅ View-once ${mediaType} forwarded to ${dest}`);

    } catch (err) {
        console.error('ViewOnce auto-capture error:', err);
    }
}

// ===================== Optional: handle revocation =====================
export async function handleViewOnceRevocation(sock: any, revocationMessage: any) {
    try {
        const config = await getConfig();
        if (!config.enabled) return;
        const protocol = revocationMessage.message?.protocolMessage;
        if (!protocol) return;
        const deletedId = protocol.key?.id;
        if (!deletedId) return;
        const entry = getEntry(deletedId);
        if (!entry) return;

        const dest = config.destination || DEFAULT_DESTINATION;
        if (!dest) return;
        const caption = `*🔄 View‑Once ${entry.mediaType} (deleted)*\nFrom: @${entry.sender.split('@')[0]}`;
        const mediaOptions: any = { caption, mentions: [entry.sender] };
        switch (entry.mediaType) {
            case 'image': await sock.sendMessage(dest, { image: { url: entry.mediaPath }, ...mediaOptions }); break;
            case 'video': await sock.sendMessage(dest, { video: { url: entry.mediaPath }, ...mediaOptions }); break;
            case 'sticker': await sock.sendMessage(dest, { sticker: { url: entry.mediaPath }, ...mediaOptions }); break;
            case 'audio': await sock.sendMessage(dest, { audio: { url: entry.mediaPath }, mimetype: 'audio/mpeg', ptt: false }); break;
        }
    } catch (err) {
        console.error('ViewOnce revocation error:', err);
    }
}

// ===================== Cleanup =====================
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

async function cleanupOldFiles() {
    try {
        const now = Date.now();
        const files = await readdir(TEMP_DIR);
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = await stat(filePath);
                if (now - stats.mtimeMs > MAX_AGE) {
                    await unlink(filePath);
                    for (const [id, entry] of cache) {
                        if (entry.mediaPath === filePath) {
                            cache.delete(id);
                            break;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }
        await saveCache();
    } catch (e) {
        console.error('ViewOnce cleanup error:', e);
    }
}

setTimeout(cleanupOldFiles, 5000);
setInterval(cleanupOldFiles, CLEANUP_INTERVAL);

// ===================== Helper to send error to owner =====================
async function sendErrorToOwner(sock: any, errorMessage: string, commandMessage: any) {
    const dest = (await getConfig()).destination || DEFAULT_DESTINATION;
    if (!dest) {
        console.error('ViewOnce error (no destination):', errorMessage);
        return;
    }
    try {
        const sender = commandMessage.key.participant || commandMessage.key.remoteJid;
        await sock.sendMessage(dest, {
            text: `⚠️ *ViewOnce Manual Forward Error*\n\n${errorMessage}\n\nCommand from: ${sender}`
        });
    } catch (e) {
        console.error('Failed to send error to owner:', e);
    }
}

// ===================== Command =====================
export default {
    command: 'viewonce',
    aliases: ['viewmedia', 'vv'],
    category: 'general',
    description: 'Forward a view‑once media to the owner (reply to it) or manage auto‑capture.',
    usage: '.viewonce (reply to a view‑once media) | .viewonce on/off | .viewonce destination <number>',

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;
        const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const config = await getConfig();

        // --- Manual forward (reply to view-once) ---
        if (!args.length) {
            const quotedImage = quoted?.imageMessage;
            const quotedVideo = quoted?.videoMessage;

            if (quotedImage && quotedImage.viewOnce) {
                try {
                    const stream = await downloadContentFromMessage(quotedImage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    const dest = config.destination || DEFAULT_DESTINATION;
                    if (!dest) {
                        // No destination – send error to owner (but we have fallback, so unlikely)
                        await sendErrorToOwner(sock, 'No destination set for forwarding view‑once.', message);
                        return;
                    }
                    const sender = message.key.participant || message.key.remoteJid;
                    const caption = `*📸 View‑Once Image (manual forward)*\nFrom: @${sender.split('@')[0]}`;
                    await sock.sendMessage(dest, {
                        image: buffer,
                        caption,
                        mentions: [sender]
                    });
                    // ✅ No confirmation sent to chat
                } catch (error: any) {
                    console.error('Manual viewonce image error:', error);
                    await sendErrorToOwner(sock, `Image download/send failed: ${error.message || 'Unknown error'}`, message);
                }
                return;
            }
            else if (quotedVideo && quotedVideo.viewOnce) {
                try {
                    const stream = await downloadContentFromMessage(quotedVideo, 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    const dest = config.destination || DEFAULT_DESTINATION;
                    if (!dest) {
                        await sendErrorToOwner(sock, 'No destination set for forwarding view‑once.', message);
                        return;
                    }
                    const sender = message.key.participant || message.key.remoteJid;
                    const caption = `*📸 View‑Once Video (manual forward)*\nFrom: @${sender.split('@')[0]}`;
                    await sock.sendMessage(dest, {
                        video: buffer,
                        caption,
                        mentions: [sender]
                    });
                    // ✅ No confirmation sent to chat
                } catch (error: any) {
                    console.error('Manual viewonce video error:', error);
                    await sendErrorToOwner(sock, `Video download/send failed: ${error.message || 'Unknown error'}`, message);
                }
                return;
            }
            else {
                // No quoted view-once – show status (this is a response to the user's command)
                await sock.sendMessage(chatId, {
                    text: `*📸 View‑Once Auto‑Capture*\n\n` +
                          `Status: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                          `Destination: ${config.destination || 'Not set'}\n\n` +
                          `Reply to a view‑once message to manually forward it to the owner.\n` +
                          `Commands (owner only):\n` +
                          `• \`.viewonce on/off\` – toggle auto‑capture\n` +
                          `• \`.viewonce destination <number>\` – set recipient`
                }, { quoted: message });
                return;
            }
        }

        // --- Admin subcommands (owner only) ---
        const senderJid = message.key.participant || message.key.remoteJid;
        const ownerJid = sock.user.id.includes('@') ? sock.user.id : sock.user.id.split(':')[0] + '@s.whatsapp.net';
        if (senderJid !== ownerJid) {
            await sock.sendMessage(chatId, {
                text: '❌ You are not authorized to use this command.'
            }, { quoted: message });
            return;
        }

        const action = args[0].toLowerCase();

        if (action === 'on' || action === 'off') {
            config.enabled = (action === 'on');
            await saveConfig(config);
            await sock.sendMessage(chatId, {
                text: `✅ View‑Once auto‑capture ${config.enabled ? 'enabled' : 'disabled'}.`
            }, { quoted: message });
            return;
        }

        if (action === 'destination') {
            const newDest = args[1];
            if (!newDest || !newDest.includes('@')) {
                await sock.sendMessage(chatId, {
                    text: '❌ Provide a valid JID (e.g., 1234567890@s.whatsapp.net)'
                }, { quoted: message });
                return;
            }
            config.destination = newDest;
            await saveConfig(config);
            await sock.sendMessage(chatId, {
                text: `✅ Destination updated to: ${newDest}`
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: '❌ Invalid subcommand. Use: on/off/destination'
        }, { quoted: message });
    },
};

loadCache();