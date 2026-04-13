import type { BotContext } from '../types.js';
import { loadSchedules, saveSchedules } from './schedule.js';

export default {
    command: 'schedulecancel',
    aliases: ['schedcancel', 'cancelschedule', 'unschedule'],
    category: 'utility',
    description: 'Cancel a scheduled message by its ID',
    usage: '.schedulecancel <ID>',

    async handler(sock: any, message: any, args: any[], context: BotContext) {
        const { chatId, senderId, channelInfo, senderIsOwnerOrSudo } = context;

        if (!args || args.length === 0) {
            return await sock.sendMessage(chatId, {
                text: '❌ Please provide the schedule ID.\n\nUsage: `.schedulecancel <ID>`\nGet IDs with: `.schedulelist`',
                ...channelInfo
            }, { quoted: message });
        }

        const targetId = args[0].toUpperCase();
        const schedules = await loadSchedules();

        // Owners/sudo can cancel any schedule; regular users can only cancel their own
        const index = schedules.findIndex(s => {
            if (s.id !== targetId) return false;
            if (senderIsOwnerOrSudo) return true;
            return s.senderId === senderId || s.chatId === chatId || s.targetJid === chatId;
        });

        if (index === -1) {
            return await sock.sendMessage(chatId, {
                text: `❌ No schedule found with ID *${targetId}*, or you don't have permission to cancel it.\n\nUse \`.schedulelist\` to see your scheduled messages.`,
                ...channelInfo
            }, { quoted: message });
        }

        const cancelled = schedules.splice(index, 1)[0];
        await saveSchedules(schedules);

        const typeLabel = cancelled.mediaType
            ? `📎 ${cancelled.mediaType}`
            : `💬 Text: ${(cancelled.message ?? '').slice(0, 50)}`;

        await sock.sendMessage(chatId, {
            text:
                `🗑️ *Schedule Cancelled*\n\n` +
                `📌 *ID:* ${cancelled.id}\n` +
                `🔁 *Was:* ${cancelled.recurrence}\n` +
                `${typeLabel}`,
            ...channelInfo
        }, { quoted: message });
    }
};