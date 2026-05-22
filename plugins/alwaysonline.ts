import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';

// Track the current presence state to avoid redundant updates
let currentPresenceState: 'available' | 'unavailable' | 'unknown' = 'unknown';
let isUpdatingPresence = false;

/**
 * Send presence update with state tracking
 */
async function sendPresenceUpdate(sock: any, state: 'available' | 'unavailable') {
    if (isUpdatingPresence) return;
    if (currentPresenceState === state) return; // Skip if already in that state

    try {
        isUpdatingPresence = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log(`[AlwaysOnline] Sending presence: ${state}`);
        await sock.sendPresenceUpdate(state);
        
        currentPresenceState = state;
        await new Promise(resolve => setTimeout(resolve, 300));
    } catch (e: any) {
        console.error(`[AlwaysOnline] Failed to send presence update: ${e.message}`);
    } finally {
        isUpdatingPresence = false;
    }
}

export default {
    command: 'alwaysonline',
    aliases: ['ao', 'stealth', 'stealthmode'],
    category: 'owner',
    description: 'Toggle always online mode - bot will appear offline when enabled',
    usage: '.alwaysonline <on|off>',
    ownerOnly: true,

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const { chatId } = context;
        const action = args[0]?.toLowerCase();

        // Get current state
        const currentState = await store.getSetting('global', 'alwaysOnlineMode');
        const isEnabled = currentState?.enabled ?? false;

        // If no action provided, show status
        if (!action || !['on', 'off'].includes(action)) {
            let warnings = '';
            try {
                const autotypingState = await store.getSetting('global', 'autotyping');
                const autoreadState = await store.getSetting('global', 'autoread');
                
                if ((autotypingState?.enabled || autoreadState?.enabled) && isEnabled) {
                    warnings = '\n\n⚠️ *Note:* Autotyping/Autoread are enabled but blocked by always online mode.';
                }
            } catch(e: any) {}

            return await sock.sendMessage(chatId, {
                text: `👻 *Always Online Status:* ${isEnabled ? 'ON' : 'OFF'}\n\n*Usage:* .alwaysonline <on|off>\n\n*What it does:*\n• Keeps bot appearing offline\n• Blocks all presence updates\n• No typing indicators\n• No "online" status${warnings}`
            }, { quoted: message });
        }

        const newState = action === 'on';

        // If state is already what we want, just notify
        if (isEnabled === newState) {
            return await sock.sendMessage(chatId, {
                text: `👻 Always online is already ${newState ? 'ON' : 'OFF'}`
            }, { quoted: message });
        }

        try {
            // Step 1: Send presence update immediately
            console.log(`[AlwaysOnline] Toggling to: ${newState ? 'ON' : 'OFF'}`);
            await sendPresenceUpdate(sock, newState ? 'unavailable' : 'available');

            // Step 2: Save setting after presence is sent
            await store.saveSetting('global', 'alwaysOnlineMode', { enabled: newState });

            // Also maintain old 'stealthMode' key for compatibility
            await store.saveSetting('global', 'stealthMode', { enabled: newState });

            // Step 3: Confirm to user
            let confirmMsg = '';
            if (newState) {
                confirmMsg = '✅ Always Online Mode: **ON**\n✓ Bot is now appearing offline\n✓ All presence updates blocked';
            } else {
                confirmMsg = '✅ Always Online Mode: **OFF**\n✓ Bot will show normal presence\n✓ Presence updates enabled';
            }

            // Check for conflicts
            let conflictWarning = '';
            if (newState) {
                try {
                    const autotypingState = await store.getSetting('global', 'autotyping');
                    const autoreadState = await store.getSetting('global', 'autoread');
                    
                    if (autotypingState?.enabled) conflictWarning += '\n⚠️ Autotyping will be blocked';
                    if (autoreadState?.enabled) conflictWarning += '\n⚠️ Autoread will be blocked';
                } catch(e: any) {}
            }

            await sock.sendMessage(chatId, {
                text: `👻 ${confirmMsg}${conflictWarning}`
            }, { quoted: message });

            console.log(`[AlwaysOnline] Successfully toggled to: ${newState ? 'ON' : 'OFF'}`);

        } catch (e: any) {
            console.error(`[AlwaysOnline] Error toggling mode:`, e);
            await sock.sendMessage(chatId, {
                text: `❌ Error toggling always online: ${e.message}`
            }, { quoted: message });
        }
    }
};

// Export function to check if always online is enabled
export async function isAlwaysOnlineEnabled(): Promise<boolean> {
    try {
        const state = await store.getSetting('global', 'alwaysOnlineMode');
        return state?.enabled ?? false;
    } catch (e: any) {
        return false;
    }
}

// Export function to set presence state (for external callers like on reconnect)
export async function setPresenceState(sock: any, enabled: boolean) {
    try {
        await sendPresenceUpdate(sock, enabled ? 'unavailable' : 'available');
    } catch (e: any) {
        console.error(`[AlwaysOnline] Error setting presence state:`, e);
    }
}
