import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';

// ── Periodic presence enforcer ────────────────────────────────────────────────
// WhatsApp's server silently resets a client to "online" after a few minutes
// regardless of what Baileys sends at connect-time. The only reliable fix is to
// periodically re-assert "unavailable" while stealth mode is active.
let _enforcerTimer: ReturnType<typeof setInterval> | null = null;
let _sock: any = null;

function startEnforcer(sock: any): void {
    _sock = sock;
    if (_enforcerTimer) return; // already running

    _enforcerTimer = setInterval(async () => {
        try {
            const state = await store.getSetting('global', 'stealthMode');
            if (!state?.enabled || !_sock) return;

            // Re-assert offline status; silently ignore errors (e.g. during reconnects)
            await _sock.sendPresenceUpdate('unavailable').catch(() => {});
        } catch (_) {
            // Never let the enforcer crash
        }
    }, 2 * 60 * 1000); // every 2 minutes
}

function stopEnforcer(): void {
    if (_enforcerTimer) {
        clearInterval(_enforcerTimer);
        _enforcerTimer = null;
    }
}

export default {
    command: 'stealth',
    aliases: ['alwaysonline', 'stealthmode'],
    category: 'owner',
    description: 'Toggle stealth mode — bot will appear permanently offline',
    usage: '.stealth <on|off>',
    ownerOnly: true,

    // ── Called once when the bot connects (pluginLoader lifecycle) ────────────
    async onLoad(sock: any) {
        _sock = sock;
        const state = await store.getSetting('global', 'stealthMode').catch(() => null);
        if (state?.enabled) {
            startEnforcer(sock);
            // Immediately assert offline so there is no window where the bot
            // appears online after a reconnect.
            try {
                await sock.sendPresenceUpdate('unavailable');
            } catch (_) {}
        }
    },

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const { chatId } = context;

        const action = args[0]?.toLowerCase();

        if (!action || !['on', 'off'].includes(action)) {
            const currentState = await store.getSetting('global', 'stealthMode');
            const status = currentState?.enabled ? 'ON 👻' : 'OFF ✅';

            return await sock.sendMessage(chatId, {
                text: `👻 *Stealth Mode Status:* ${status}\n\n*Usage:* .stealth <on|off>\n\n*What it does:*\n• Blocks all presence updates (typing, online, last seen)\n• Periodically re-asserts offline status every 2 min\n• Makes the bot completely invisible to contacts\n\n*When enabled:*\n✓ No "typing..." indicator\n✓ No "online" status\n✓ Complete ghost mode`
            }, { quoted: message });
        }

        const enabled = action === 'on';
        await store.saveSetting('global', 'stealthMode', { enabled });

        if (enabled) {
            // 1. Start the periodic enforcer so it survives reconnects
            startEnforcer(sock);

            // 2. Immediately go offline — don't wait for the next enforcer tick
            try {
                await new Promise(r => setTimeout(r, 300));
                await sock.sendPresenceUpdate('unavailable');
            } catch (_) {}

            let warnings = '';
            try {
                const autotypingState = await store.getSetting('global', 'autotyping');
                const autoreadState   = await store.getSetting('global', 'autoread');
                if (autotypingState?.enabled || autoreadState?.enabled) {
                    warnings = '\n\n*⚠️ Note:*\n';
                    if (autotypingState?.enabled) warnings += '• Autotyping is enabled but will be suppressed\n';
                    if (autoreadState?.enabled)   warnings += '• Autoread is enabled but will be suppressed\n';
                }
            } catch (_) {}

            return await sock.sendMessage(chatId, {
                text: `👻 Stealth mode *ON*\n\n✓ Bot is now invisible\n✓ No presence updates will leak\n✓ Offline status refreshed every 2 min${warnings}`
            }, { quoted: message });

        } else {
            // Stop the enforcer first so it can't fight us
            stopEnforcer();

            try {
                await new Promise(r => setTimeout(r, 300));
                await sock.sendPresenceUpdate('available');
            } catch (_) {}

            return await sock.sendMessage(chatId, {
                text: `✅ Stealth mode *OFF*\n\n✓ Presence updates re-enabled\n✓ Typing indicators active (if autotyping is on)`
            }, { quoted: message });
        }
    }
};