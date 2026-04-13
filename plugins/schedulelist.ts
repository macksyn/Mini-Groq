import type { BotContext } from '../types.js';
import { loadSchedules, formatTimeLeft, type Recurrence } from './schedule.js';

const RECUR_LABELS: Record<Recurrence, string> = {
    once:   '🔂 Once',
    daily:  '📅 Daily',
    weekly: '📆 Weekly',
};

const TYPE_ICONS: Record<string, string> = {
    image:    '🖼️',
    video:    '🎬',
    audio:    '🎵',
    sticker:  '🎭',
    document: '📄',
};

export default {
    command: 'schedulelist',
    aliases: ['schedlist', 'schedules', 'reminders'],
    category: 'utility',
    description: 'View all scheduled messages',
    usage: '.schedulelist [all]',

    async handler(sock: any, message: any, args: any[], context: BotContext) {
        const { chatId, senderId, channelInfo, senderIsOwnerOrSudo } = context;

        const allSchedules = await loadSchedules();
        const showAll = (args[0]?.toLowerCase() === 'all') && senderIsOwnerOrSudo;

        // Show all schedules (owner) or just schedules relevant to this chat / created by sender
        const visible = showAll
            ? allSchedules
            : allSchedules.filter(
                s => s.chatId === chatId ||
                     s.targetJid === chatId ||
                     s.senderId === senderId
              );

        if (visible.length === 0) {
            return await sock.sendMessage(chatId, {
                text: '📭 *No scheduled messages found*\n\nUse `.schedule <time> <message>` to schedule one!\nOwner: `.schedulelist all` to see every schedule.',
                ...channelInfo
            }, { quoted: message });
        }

        const now = Date.now();

        const lines = visible.map((s, i) => {
            const timeLeft  = formatTimeLeft(s.sendAt - now);
            const typeIcon  = s.mediaType ? (TYPE_ICONS[s.mediaType] ?? '📎') : '💬';
            const recurLabel = RECUR_LABELS[s.recurrence] ?? s.recurrence;
            const destLabel  = s.targetJid === chatId
                ? 'here'
                : s.targetJid.split('@')[0];
            const preview = s.mediaType
                ? `[${s.mediaType}${s.mediaCaption ? ': ' + s.mediaCaption.slice(0, 30) : ''}]`
                : (s.message ?? '').slice(0, 40) + ((s.message?.length ?? 0) > 40 ? '…' : '');

            return (
                `${i + 1}. ${typeIcon} *ID:* ${s.id}  ${recurLabel}\n` +
                `    ⏳ *In:* ${timeLeft}  📬 *To:* ${destLabel}\n` +
                `    ${preview}`
            );
        }).join('\n\n');

        await sock.sendMessage(chatId, {
            text:
                `*⏰ SCHEDULED MESSAGES (${visible.length}${showAll ? ' — all' : ''})*\n\n` +
                `${lines}\n\n` +
                `_Cancel one: \`.schedulecancel <ID>\`_`,
            ...channelInfo
        }, { quoted: message });
    }
};