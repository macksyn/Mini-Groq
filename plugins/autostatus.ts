import type { BotContext } from '../types.js';
import fs from 'fs';
import path from 'path';
import { dataFile } from '../lib/paths.js';
import store from '../lib/lightweight_store.js';

const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
const HAS_DB = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const configPath = dataFile('autoStatus.json');

if (!HAS_DB && !fs.existsSync(configPath)) {
    if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify({
        enabled: false,
        reactOn: false,
        filterMode: 'none',   // 'none' | 'whitelist' | 'blacklist'
        filterList: []        // array of phone numbers e.g. ["2348012345678"]
    }, null, 2));
}

const channelInfo = {
    contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363319098372999@newsletter',
            newsletterName: 'GlobalTechInc',
            serverMessageId: -1
        }
    }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip everything from a JID/number leaving only the numeric part */
function cleanNumber(raw: string): string {
    return raw
        .replace('@s.whatsapp.net', '')
        .replace('@lid', '')
        .replace('@g.us', '')
        .replace(/\D/g, '')
        .split(':')[0];
}

// ── Config helpers ────────────────────────────────────────────────────────────

async function readConfig() {
    try {
        let raw: any = null;
        if (HAS_DB) {
            raw = await store.getSetting('global', 'autoStatus');
        } else {
            raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        // Always normalise — handles old configs that predate filterMode/filterList
        return {
            enabled:    !!(raw?.enabled),
            reactOn:    !!(raw?.reactOn),
            filterMode: raw?.filterMode  || 'none',
            filterList: Array.isArray(raw?.filterList) ? raw.filterList : []
        };
    } catch {
        return { enabled: false, reactOn: false, filterMode: 'none', filterList: [] };
    }
}

async function writeConfig(config: any) {
    try {
        if (HAS_DB) {
            await store.saveSetting('global', 'autoStatus', config);
        } else {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
    } catch (error: any) {
        console.error('Error writing auto status config:', error);
    }
}

// ── Filter logic ──────────────────────────────────────────────────────────────

/**
 * Returns true if the bot should view/react to this status sender.
 *
 * filterMode = 'none'       → always view everyone
 * filterMode = 'whitelist'  → view ONLY numbers in filterList
 * filterMode = 'blacklist'  → view everyone EXCEPT numbers in filterList
 */
async function shouldViewStatus(senderJid: string): Promise<boolean> {
    const config = await readConfig();
    if (!config.enabled) return false;

    const { filterMode, filterList } = config;
    if (!filterMode || filterMode === 'none') return true;

    const senderNum = cleanNumber(senderJid);
    const inList = (filterList as string[]).some(n => cleanNumber(n) === senderNum);

    if (filterMode === 'whitelist') return inList;
    if (filterMode === 'blacklist') return !inList;
    return true;
}

// ── Status reaction ───────────────────────────────────────────────────────────

async function reactToStatus(sock: any, statusKey: any) {
    try {
        const config = await readConfig();
        if (!config.reactOn) return;

        await sock.relayMessage(
            'status@broadcast',
            {
                reactionMessage: {
                    key: {
                        remoteJid:   'status@broadcast',
                        id:          statusKey.id,
                        participant: statusKey.participant || statusKey.remoteJid,
                        fromMe:      false
                    },
                    text: '💚'
                }
            },
            {
                messageId:     statusKey.id,
                statusJidList: [statusKey.remoteJid, statusKey.participant || statusKey.remoteJid]
            }
        );
        console.log('✅ Reacted to status');
    } catch (error: any) {
        console.error('❌ Error reacting to status:', error.message);
    }
}

// ── Main status handler ───────────────────────────────────────────────────────

async function handleStatusUpdate(sock: any, status: any) {
    try {
        // Resolve the sender JID from whatever shape the event arrives in
        let senderJid: string | null = null;

        if (status.messages?.length > 0) {
            const msg = status.messages[0];
            if (msg.key?.remoteJid === 'status@broadcast') {
                senderJid = msg.key.participant || msg.key.remoteJid;
            }
        } else if (status.key?.remoteJid === 'status@broadcast') {
            senderJid = status.key.participant || status.key.remoteJid;
        } else if (status.reaction?.key?.remoteJid === 'status@broadcast') {
            senderJid = status.reaction.key.participant || status.reaction.key.remoteJid;
        }

        if (!senderJid) return;

        // Apply filter check
        const allowed = await shouldViewStatus(senderJid);
        if (!allowed) {
            console.log(`⏭️ Skipped status from ${cleanNumber(senderJid)} (filter)`);
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Helper to read + react, with rate-limit retry
        const readAndReact = async (key: any) => {
            try {
                await sock.readMessages([key]);
                await reactToStatus(sock, key);
            } catch (err: any) {
                if (err.message?.includes('rate-overlimit')) {
                    await new Promise(r => setTimeout(r, 2000));
                    await sock.readMessages([key]);
                } else {
                    throw err;
                }
            }
        };

        if (status.messages?.length > 0) {
            const msg = status.messages[0];
            if (msg.key?.remoteJid === 'status@broadcast') {
                await readAndReact(msg.key);
                console.log('✅ Viewed status from messages');
                return;
            }
        }

        if (status.key?.remoteJid === 'status@broadcast') {
            await readAndReact(status.key);
            console.log('✅ Viewed status from key');
            return;
        }

        if (status.reaction?.key?.remoteJid === 'status@broadcast') {
            await readAndReact(status.reaction.key);
            console.log('✅ Viewed status from reaction');
        }

    } catch (error: any) {
        console.error('❌ Error in auto status view:', error.message);
    }
}

// ── Command handler ───────────────────────────────────────────────────────────

export default {
    command: 'autostatus',
    aliases: ['autoview', 'statusview'],
    category: 'owner',
    description: 'Automatically view and react to WhatsApp statuses with optional filter',
    usage: '.autostatus <on|off|react on|react off|whitelist|blacklist|add|remove|list|reset>',
    ownerOnly: true,

    async handler(sock: any, message: any, args: any[], context: BotContext) {
        const chatId = context.chatId || message.key.remoteJid;

        try {
            const config = await readConfig();

            // ── No args → show status ─────────────────────────────────────
            if (!args || args.length === 0) {
                const viewStatus  = config.enabled    ? '✅ Enabled'  : '❌ Disabled';
                const reactStatus = config.reactOn    ? '✅ Enabled'  : '❌ Disabled';
                const modeLabel   = config.filterMode === 'none'
                    ? '🌐 View everyone'
                    : config.filterMode === 'whitelist'
                        ? `✅ Whitelist (${(config.filterList as string[]).length} contacts)`
                        : `🚫 Blacklist (${(config.filterList as string[]).length} contacts)`;

                return await sock.sendMessage(chatId, {
                    text:
                        `🔄 *Auto Status Settings*\n\n` +
                        `📱 *Auto View:*      ${viewStatus}\n` +
                        `💫 *Auto React:*     ${reactStatus}\n` +
                        `🎯 *Filter Mode:*    ${modeLabel}\n\n` +
                        `*── Toggle ──*\n` +
                        `• \`.autostatus on/off\`          — Enable/disable auto view\n` +
                        `• \`.autostatus react on/off\`    — Enable/disable reactions\n\n` +
                        `*── Filter Mode ──*\n` +
                        `• \`.autostatus whitelist\`        — View ONLY listed contacts\n` +
                        `• \`.autostatus blacklist\`        — View everyone EXCEPT listed\n` +
                        `• \`.autostatus reset\`            — Remove all filters (view all)\n\n` +
                        `*── Manage List ──*\n` +
                        `• \`.autostatus add 2348012345678\`   — Add a number\n` +
                        `• \`.autostatus remove 2348012345678\` — Remove a number\n` +
                        `• \`.autostatus list\`               — Show current filter list`,
                    ...channelInfo
                }, { quoted: message });
            }

            const cmd  = args[0].toLowerCase();
            const arg2 = args[1]?.toLowerCase();

            // ── on / off ──────────────────────────────────────────────────
            if (cmd === 'on') {
                config.enabled = true;
                await writeConfig(config);
                return await sock.sendMessage(chatId, {
                    text: '✅ *Auto status view enabled!*',
                    ...channelInfo
                }, { quoted: message });
            }

            if (cmd === 'off') {
                config.enabled = false;
                await writeConfig(config);
                return await sock.sendMessage(chatId, {
                    text: '❌ *Auto status view disabled!*',
                    ...channelInfo
                }, { quoted: message });
            }

            // ── react on / off ────────────────────────────────────────────
            if (cmd === 'react') {
                if (!arg2 || !['on', 'off'].includes(arg2)) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Usage: `.autostatus react on` or `.autostatus react off`',
                        ...channelInfo
                    }, { quoted: message });
                }
                config.reactOn = arg2 === 'on';
                await writeConfig(config);
                return await sock.sendMessage(chatId, {
                    text: config.reactOn
                        ? '💫 *Status reactions enabled!* Bot will react with 💚'
                        : '❌ *Status reactions disabled!*',
                    ...channelInfo
                }, { quoted: message });
            }

            // ── whitelist / blacklist ─────────────────────────────────────
            if (cmd === 'whitelist' || cmd === 'blacklist') {
                config.filterMode = cmd;
                await writeConfig(config);
                const modeText = cmd === 'whitelist'
                    ? '✅ *Whitelist mode ON*\nBot will view status of ONLY contacts in your list.\nUse `.autostatus add <number>` to populate the list.'
                    : '🚫 *Blacklist mode ON*\nBot will view everyone\'s status EXCEPT contacts in your list.\nUse `.autostatus add <number>` to add people to skip.';
                return await sock.sendMessage(chatId, {
                    text: modeText,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── reset ─────────────────────────────────────────────────────
            if (cmd === 'reset') {
                config.filterMode = 'none';
                config.filterList = [];
                await writeConfig(config);
                return await sock.sendMessage(chatId, {
                    text: '🌐 *Filter reset!* Bot will now view everyone\'s status.',
                    ...channelInfo
                }, { quoted: message });
            }

            // ── add <number> ──────────────────────────────────────────────
            if (cmd === 'add') {
                if (!args[1]) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Please provide a number.\nExample: `.autostatus add 2348012345678`',
                        ...channelInfo
                    }, { quoted: message });
                }

                const num = cleanNumber(args[1]);
                if (num.length < 7) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Invalid number format. Use international format without +\nExample: `2348012345678`',
                        ...channelInfo
                    }, { quoted: message });
                }

                const list: string[] = config.filterList || [];
                if (list.some(n => cleanNumber(n) === num)) {
                    return await sock.sendMessage(chatId, {
                        text: `⚠️ *${num}* is already in the list.`,
                        ...channelInfo
                    }, { quoted: message });
                }

                list.push(num);
                config.filterList = list;
                await writeConfig(config);

                const modeHint = config.filterMode === 'none'
                    ? '\n\n💡 *Tip:* You haven\'t set a filter mode yet. Use `.autostatus whitelist` or `.autostatus blacklist` to activate filtering.'
                    : '';

                return await sock.sendMessage(chatId, {
                    text: `✅ *${num}* added to filter list. (${list.length} total)${modeHint}`,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── remove <number> ───────────────────────────────────────────
            if (cmd === 'remove') {
                if (!args[1]) {
                    return await sock.sendMessage(chatId, {
                        text: '❌ Please provide a number.\nExample: `.autostatus remove 2348012345678`',
                        ...channelInfo
                    }, { quoted: message });
                }

                const num = cleanNumber(args[1]);
                const list: string[] = config.filterList || [];
                const before = list.length;
                config.filterList = list.filter(n => cleanNumber(n) !== num);

                if (config.filterList.length === before) {
                    return await sock.sendMessage(chatId, {
                        text: `⚠️ *${num}* was not found in the list.`,
                        ...channelInfo
                    }, { quoted: message });
                }

                await writeConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `✅ *${num}* removed from filter list. (${config.filterList.length} remaining)`,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── list ──────────────────────────────────────────────────────
            if (cmd === 'list') {
                const list: string[] = config.filterList || [];
                if (list.length === 0) {
                    return await sock.sendMessage(chatId, {
                        text: `📋 *Filter List is empty.*\n\nCurrent mode: *${config.filterMode || 'none'}*\n\nUse \`.autostatus add <number>\` to add contacts.`,
                        ...channelInfo
                    }, { quoted: message });
                }

                const modeLabel = config.filterMode === 'whitelist'
                    ? '✅ Whitelist — viewing ONLY these'
                    : config.filterMode === 'blacklist'
                        ? '🚫 Blacklist — skipping these'
                        : '⚠️ No mode set (list unused until you run `.autostatus whitelist` or `.autostatus blacklist`)';

                const numbered = list.map((n, i) => `${i + 1}. ${n}`).join('\n');

                return await sock.sendMessage(chatId, {
                    text: `📋 *Filter List* (${list.length})\nMode: ${modeLabel}\n\n${numbered}`,
                    ...channelInfo
                }, { quoted: message });
            }

            // ── unknown command ───────────────────────────────────────────
            await sock.sendMessage(chatId, {
                text:
                    '❌ *Unknown sub-command.*\n\n' +
                    'Run `.autostatus` with no arguments to see all options.',
                ...channelInfo
            }, { quoted: message });

        } catch (error: any) {
            console.error('Error in autostatus command:', error);
            await sock.sendMessage(chatId, {
                text: `❌ *Error:* ${error.message}`,
                ...channelInfo
            }, { quoted: message });
        }
    },

    // Exported for use in index.ts / messageHandler
    handleStatusUpdate,
    shouldViewStatus,
    readConfig,
    writeConfig
};