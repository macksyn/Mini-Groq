import type { BotContext } from '../types.js';
import alwaysOnlinePlugin from './alwaysonline.js';

/**
 * DEPRECATED: This is a backward-compatibility wrapper
 * All logic has been moved to alwaysonline.ts
 * Use .alwaysonline instead
 */
export default {
    command: 'stealth',
    aliases: ['stealthmode'],
    category: 'owner',
    description: '[DEPRECATED] Use .alwaysonline instead - Toggle always online mode',
    usage: '.stealth <on|off>',
    ownerOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        // Delegate to alwaysonline plugin
        return alwaysOnlinePlugin.handler(sock, message, args, context);
    }
};
