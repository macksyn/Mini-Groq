import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

const HAS_DB = !!(
    process.env.MONGO_URL || process.env.POSTGRES_URL ||
    process.env.MYSQL_URL || process.env.DB_URL
);

const configPath = dataFile('schedules.json');

// ── Max media size to store (5 MB)
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export type Recurrence = 'once' | 'daily' | 'weekly';

export interface ScheduledMessage {
    id: string;
    /** Chat where the command was issued */
    chatId: string;
    /** Chat / JID where the message will actually be sent */
    targetJid: string;
    senderId: string;
    /** Plain text to send (mutually exclusive with media fields) */
    message?: string;
    /** 'image' | 'video' | 'audio' | 'sticker' | 'document' */
    mediaType?: string;
    /** Base64-encoded media buffer */
    mediaBase64?: string;
    mediaMimetype?: string;
    mediaCaption?: string;
    /** Epoch ms — when to fire next */
    sendAt: number;
    createdAt: number;
    recurrence: Recurrence;
    lastSentAt?: number;
}

// ── Storage helpers ────────────────────────────────────────────────────────────

export async function loadSchedules(): Promise<ScheduledMessage[]> {
    try {
        if (HAS_DB) {
            return (await store.getSetting('global', 'schedules')) ?? [];
        }
        if (!fs.existsSync(configPath)) {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, '[]');
        }
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
        return [];
    }
}

export async function saveSchedules(data: ScheduledMessage[]): Promise<void> {
    if (HAS_DB) {
        await store.saveSetting('global', 'schedules', data);
    } else {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export function generateId(): string {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

/**
 * Parse a time string into a future Date.
 * Supports: 10m | 2h | 1h30m | 14:30 | 10:30am
 */
export function parseTime(input: string): Date | null {
    const now = new Date();

    // relative: 10m | 2h | 1h30m
    const rel = input.match(/^(?:(\d+)h)?(?:(\d+)m)?$/i);
    if (rel && (rel[1] || rel[2])) {
        const h = parseInt(rel[1] ?? '0', 10);
        const m = parseInt(rel[2] ?? '0', 10);
        if (h === 0 && m === 0) return null;
        return new Date(now.getTime() + (h * 60 + m) * 60_000);
    }

    // clock: 14:30 | 10:30am | 9:00pm
    const clock = input.match(/^(\d{1,2}):(\d{2})(am|pm)?$/i);
    if (clock) {
        let hour = parseInt(clock[1], 10);
        const min = parseInt(clock[2], 10);
        const mer = clock[3]?.toLowerCase();
        if (mer === 'pm' && hour < 12) hour += 12;
        if (mer === 'am' && hour === 12) hour = 0;
        const target = new Date(now);
        target.setHours(hour, min, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        return target;
    }

    return null;
}

export function formatTimeLeft(ms: number): string {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const parts: string[] = [];
    if (h)   parts.push(`${h}h`);
    if (m)   parts.push(`${m}m`);
    if (sec || !parts.length) parts.push(`${sec}s`);
    return parts.join(' ');
}

/**
 * Detect whether a string token looks like a JID or bare phone number.
 * Returns the normalised JID, or null if it is not a JID.
 */
function toJid(token: string): string | null {
    // Already a full JID
    if (/@(s\.whatsapp\.net|g\.us|lid)$/.test(token)) return token;
    // Bare digits (≥ 10) → private chat
    if (/^\d{10,}$/.test(token)) return `${token}@s.whatsapp.net`;
    return null;
}

/**
 * Parse the argument list after `.schedule`.
 *
 * Syntax:  <time>  [once|daily|weekly]  [<jid|number>]  [message...]
 *
 * Any token that looks like a JID / phone number is treated as the target.
 * All remaining tokens become the message text.
 */
function parseArgs(args: string[]): {
    time: string;
    recurrence: Recurrence;
    targetJid: string | null;
    messageText: string;
} {
    if (!args.length) return { time: '', recurrence: 'once', targetJid: null, messageText: '' };

    let i = 0;
    const time = args[i++] ?? '';

    let recurrence: Recurrence = 'once';
    if (args[i] && ['once', 'daily', 'weekly'].includes(args[i].toLowerCase())) {
        recurrence = args[i++].toLowerCase() as Recurrence;
    }

    let targetJid: string | null = null;
    if (args[i]) {
        const candidate = toJid(args[i]);
        if (candidate) {
            targetJid = candidate;
            i++;
        }
    }

    return { time, recurrence, targetJid, messageText: args.slice(i).join(' ').trim() };
}

// Remove these entirely:
// let _engineStarted = false;
// export function startSchedulerEngine(sock: any): void { ... }

// Add this named export instead:
export const schedules = [
    {
        every: 10_000,
        handler: async (sock: any) => {
            try {
                const now = Date.now();
                const schedules = await loadSchedules();
                const remaining: ScheduledMessage[] = [];
                let changed = false;

                for (const item of schedules) {
                    if (now < item.sendAt) {
                        remaining.push(item);
                        continue;
                    }

                    try {
                        if (item.mediaType && item.mediaBase64) {
                            const buf = Buffer.from(item.mediaBase64, 'base64');
                            const payload: Record<string, any> = {};
                            switch (item.mediaType) {
                                case 'image':    payload.image = buf; if (item.mediaCaption) payload.caption = item.mediaCaption; break;
                                case 'video':    payload.video = buf; if (item.mediaCaption) payload.caption = item.mediaCaption; break;
                                case 'audio':    payload.audio = buf; payload.mimetype = item.mediaMimetype || 'audio/mpeg'; payload.ptt = false; break;
                                case 'sticker':  payload.sticker = buf; break;
                                case 'document': payload.document = buf; payload.mimetype = item.mediaMimetype || 'application/octet-stream'; if (item.mediaCaption) payload.fileName = item.mediaCaption; break;
                            }
                            await sock.sendMessage(item.targetJid, payload);
                        } else if (item.message) {
                            await sock.sendMessage(item.targetJid, { text: item.message });
                        }

                        console.log(`[SCHEDULE] ✅ Sent ID:${item.id} → ${item.targetJid} (${item.recurrence})`);
                        changed = true;

                        // Recurrence requeue — only on success
                        if (item.recurrence === 'daily') {
                            remaining.push({ ...item, sendAt: item.sendAt + 86_400_000, lastSentAt: now });
                        } else if (item.recurrence === 'weekly') {
                            remaining.push({ ...item, sendAt: item.sendAt + 7 * 86_400_000, lastSentAt: now });
                        }

                    } catch (e: any) {
                        console.error(`[SCHEDULE] ❌ Failed ID:${item.id}: ${e.message}`);
                        // Retry in 60s instead of silently dropping (fixes Bug 2)
                        remaining.push({ ...item, sendAt: now + 60_000 });
                        changed = true;
                    }
                }

                if (changed) await saveSchedules(remaining);
            } catch (e: any) {
                console.error('[SCHEDULE] Engine error:', e.message);
            }
        }
    }
];

                // ── Fire the message ──────────────────────────────────────
                try {
                    if (item.mediaType && item.mediaBase64) {
                        const buf = Buffer.from(item.mediaBase64, 'base64');
                        const payload: Record<string, any> = {};

                        switch (item.mediaType) {
                            case 'image':
                                payload.image = buf;
                                if (item.mediaCaption) payload.caption = item.mediaCaption;
                                break;
                            case 'video':
                                payload.video = buf;
                                if (item.mediaCaption) payload.caption = item.mediaCaption;
                                break;
                            case 'audio':
                                payload.audio = buf;
                                payload.mimetype = item.mediaMimetype || 'audio/mpeg';
                                payload.ptt = false;
                                break;
                            case 'sticker':
                                payload.sticker = buf;
                                break;
                            case 'document':
                                payload.document = buf;
                                payload.mimetype = item.mediaMimetype || 'application/octet-stream';
                                if (item.mediaCaption) payload.fileName = item.mediaCaption;
                                break;
                        }

                        await sock.sendMessage(item.targetJid, payload);
                    } else if (item.message) {
                        await sock.sendMessage(item.targetJid, { text: item.message });
                    }

                    console.log(`[SCHEDULE] ✅ Sent ID:${item.id} → ${item.targetJid} (${item.recurrence})`);
                } catch (e: any) {
                    console.error(`[SCHEDULE] ❌ Failed ID:${item.id}: ${e.message}`);
                }

                // ── Recurrence: requeue or drop ───────────────────────────
                changed = true;
                if (item.recurrence === 'daily') {
                    remaining.push({ ...item, sendAt: item.sendAt + 86_400_000, lastSentAt: now });
                } else if (item.recurrence === 'weekly') {
                    remaining.push({ ...item, sendAt: item.sendAt + 7 * 86_400_000, lastSentAt: now });
                }
                // 'once' → simply not pushed back
            }

            if (changed) await saveSchedules(remaining);
        } catch (e: any) {
            console.error('[SCHEDULE] Engine error:', e.message);
        }
    }, 10_000);
}

// ── Command handler ────────────────────────────────────────────────────────────

export default {
    command: 'schedule',
    aliases: ['sched', 'remind', 'remindme'],
    category: 'utility',
    description: 'Schedule any message — text, media, or quoted — to any chat',
    usage: [
        '.schedule <time> [once|daily|weekly] [jid] [text]',
        '',
        'Time formats:  10m  2h  1h30m  14:30  10:30am',
        'Recurrence:    once (default) | daily | weekly',
        'JID:           phone number (e.g. 2348012345678) or full JID',
        '',
        'Examples:',
        '  .schedule 10m Good morning!',
        '  .schedule 9:00am daily Good morning everyone!',
        '  .schedule 2h weekly 2348012345678 Weekly reminder',
        '  [reply to a photo] .schedule 1h30m',
        '  [reply to a video] .schedule 14:30 daily 120363..@g.us',
    ].join('\n'),
    schedules,

    async handler(sock: any, message: any, args: any[], context: BotContext) {
        const { chatId, senderId, channelInfo } = context;

        // ── No args → show help ───────────────────────────────────────────
        if (!args || args.length === 0) {
            return await sock.sendMessage(chatId, {
                text:
                    `*⏰ SCHEDULE A MESSAGE*\n\n` +
                    `*Syntax:*\n\`.schedule <time> [once|daily|weekly] [jid] [text]\`\n\n` +
                    `*Time formats:*\n` +
                    `• \`10m\`  → in 10 minutes\n` +
                    `• \`2h\`   → in 2 hours\n` +
                    `• \`1h30m\`→ in 1 h 30 m\n` +
                    `• \`14:30\` → today at 2:30 PM\n` +
                    `• \`10:30am\` → today at 10:30 AM\n\n` +
                    `*Recurrence (optional, default: once):*\n` +
                    `• \`once\`   → fire once and done\n` +
                    `• \`daily\`  → repeat every 24 h\n` +
                    `• \`weekly\` → repeat every 7 days\n\n` +
                    `*Target JID (optional):*\n` +
                    `• Phone number  \`2348012345678\`\n` +
                    `• Full JID      \`2348012345678@s.whatsapp.net\`\n` +
                    `• Group JID     \`120363...@g.us\`\n` +
                    `• Omit to schedule in the current chat\n\n` +
                    `*Quote any message* (text, photo, video, audio, sticker)\n` +
                    `and run \`.schedule <time>\` to schedule that content.\n\n` +
                    `*Examples:*\n` +
                    `\`.schedule 10m Hello world\`\n` +
                    `\`.schedule 9:00am daily Good morning!\`\n` +
                    `\`.schedule 2h weekly 2348012345678 Reminder\`\n` +
                    `_[reply to photo]_ \`.schedule 1h30m\`\n` +
                    `_[reply to video]_ \`.schedule 14:30 daily 234...@g.us\``,
                ...channelInfo
            }, { quoted: message });
        }

        // ── Parse args ────────────────────────────────────────────────────
        const { time, recurrence, targetJid, messageText } = parseArgs(args);

        if (!time) {
            return await sock.sendMessage(chatId, {
                text: '❌ Please provide a time. E.g. `.schedule 10m Hello!`',
                ...channelInfo
            }, { quoted: message });
        }

        const targetDate = parseTime(time);
        if (!targetDate) {
            return await sock.sendMessage(chatId, {
                text: `❌ Invalid time: *${time}*\nValid formats: \`10m\` \`2h\` \`1h30m\` \`14:30\` \`10:30am\``,
                ...channelInfo
            }, { quoted: message });
        }

        const destination = targetJid ?? chatId;

        // ── Check for quoted message ──────────────────────────────────────
        const quotedCtx = message.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = quotedCtx?.quotedMessage;

        const newItem: ScheduledMessage = {
            id: generateId(),
            chatId,
            targetJid: destination,
            senderId,
            sendAt: targetDate.getTime(),
            createdAt: Date.now(),
            recurrence,
        };

        if (quotedMsg) {
            const qType = Object.keys(quotedMsg)[0];

            // ── Quoted text ───────────────────────────────────────────────
            if (qType === 'conversation' || qType === 'extendedTextMessage') {
                const qText = quotedMsg.conversation ?? quotedMsg.extendedTextMessage?.text ?? '';
                // Prefer explicitly typed text; fall back to quoted text
                newItem.message = messageText || qText;

            // ── Quoted media ──────────────────────────────────────────────
            } else if (['imageMessage', 'videoMessage', 'audioMessage',
                        'stickerMessage', 'documentMessage'].includes(qType)) {
                const mediaKind = qType.replace('Message', '') as any;
                try {
                    await sock.sendMessage(chatId, {
                        text: '⏳ Downloading media to schedule...',
                        ...channelInfo
                    }, { quoted: message });

                    const stream = await downloadContentFromMessage(quotedMsg[qType], mediaKind);
                    const chunks: Buffer[] = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buf = Buffer.concat(chunks);

                    if (buf.length > MAX_MEDIA_BYTES) {
                        return await sock.sendMessage(chatId, {
                            text: `❌ Media is too large to schedule (${(buf.length / 1024 / 1024).toFixed(1)} MB).\nMaximum allowed: 5 MB.`,
                            ...channelInfo
                        }, { quoted: message });
                    }

                    newItem.mediaType = mediaKind;
                    newItem.mediaBase64 = buf.toString('base64');
                    newItem.mediaMimetype = quotedMsg[qType]?.mimetype ?? '';
                    // Use typed text as caption override, then fall back to original caption
                    newItem.mediaCaption = messageText || quotedMsg[qType]?.caption || '';
                } catch (e: any) {
                    return await sock.sendMessage(chatId, {
                        text: `❌ Failed to download media: ${e.message}`,
                        ...channelInfo
                    }, { quoted: message });
                }
            } else {
                return await sock.sendMessage(chatId, {
                    text: '❌ Unsupported quoted message type.',
                    ...channelInfo
                }, { quoted: message });
            }

        // ── Plain text (no quote) ─────────────────────────────────────────
        } else if (messageText) {
            newItem.message = messageText;
        } else {
            return await sock.sendMessage(chatId, {
                text: '❌ Please provide a message text, or reply to a message you want to schedule.',
                ...channelInfo
            }, { quoted: message });
        }

        // ── Save and confirm ──────────────────────────────────────────────
        const schedules = await loadSchedules();
        schedules.push(newItem);
        await saveSchedules(schedules);

        const timeLeft = formatTimeLeft(targetDate.getTime() - Date.now());
        const timeStr  = targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const typeLabel = newItem.mediaType
            ? `📎 ${newItem.mediaType.charAt(0).toUpperCase() + newItem.mediaType.slice(1)}`
            : `💬 Text`;
        const destLabel = destination === chatId ? 'this chat' : destination.split('@')[0];
        const recurLabel = recurrence === 'once'
            ? 'once'
            : recurrence === 'daily'
                ? 'every day at this time'
                : 'every week at this time';

        await sock.sendMessage(chatId, {
            text:
                `✅ *Message Scheduled!*\n\n` +
                `📌 *ID:* ${newItem.id}\n` +
                `${typeLabel}\n` +
                `⏳ *Fires in:* ${timeLeft} (at ${timeStr})\n` +
                `🔁 *Recurrence:* ${recurLabel}\n` +
                `📬 *Destination:* ${destLabel}\n\n` +
                `_Use \`.schedulecancel ${newItem.id}\` to cancel_\n` +
                `_Use \`.schedulelist\` to see all scheduled messages_`,
            ...channelInfo
        }, { quoted: message });
    }
};