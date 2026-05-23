import type { BotContext } from '../types.js';
import store from '../lib/lightweight_store.js';

// ── Module-level socket reference ─────────────────────────────────────────────
// Updated from index.ts on EVERY reconnect via syncSock(), so the enforcer
// never operates on a dead/stale socket after WhatsApp forces a reconnect.
let _sock: any = null;
let _enforcerTimer: ReturnType<typeof setInterval> | null = null;

// ── Called from index.ts on every connection.update → 'open' ─────────────────
export function syncSock(sock: any): void {
    _sock = sock;
}

// ── Checks whether the underlying WebSocket is still alive ───────────────────
function isSocketAlive(): boolean {
    if (!_sock) return false;
    const ws = _sock.ws;
    if (ws && typeof ws.readyState === 'number') {
        return ws.readyState === 1; // WebSocket.OPEN = 1
    }
    return true; // unknown state — let try/catch handle it
}

// ── Enforcer ──────────────────────────────────────────────────────────────────
// Re-asserts "unavailable" every 45 seconds while stealth is active.
// 45 s is well within WhatsApp's ~2-3 min auto-reset window.
function startEnforcer(): void {
    if (_enforcerTimer) return;

    _enforcerTimer = setInterval(async () => {
        try {
            const state = await store.getSetting('global', 'stealthMode');
            if (!state?.enabled) return;
            if (!isSocketAlive()) return; // wait for next syncSock() call
            await _sock.sendPresenceUpdate('unavailable');
        } catch (_) {}
    }, 45 * 1000);
}

function stopEnforcer(): void {
    if (_enforcerTimer) {
        clearInterval(_enforcerTimer);
        _enforcerTimer = null;
    }
}

// ── Assert offline with retries ───────────────────────────────────────────────
// Sends 'unavailable' multiple times to beat WA's connect-time 'available' ping.
async function assertOffline(sock: any): Promise<void> {
    for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 1200));
        try { await sock.sendPresenceUpdate('unavailable'); } catch (_) {}
    }
}

// ── Plugin lifecycle hook (called once by pluginLoader on first connect) ──────
export async function onLoad(sock: any): Promise<void> {
    _sock = sock;
    const state = await store.getSetting('global', 'stealthMode').catch(() => null);
    if (state?.enabled) {
        startEnforcer();
        await assertOffline(sock);
    }
}

// ── Command handler ───────────────────────────────────────────────────────────
export default {
    command: 'stealth',
    aliases: ['alwaysonline', 'stealthmode'],
    category: 'owner',
    description: 'Toggle stealth mode — bot appears permanently offline',
    usage: '.stealth <on|off>',
    ownerOnly: true,

    onLoad, // re-exported so pluginLoader.ts picks it up via plugin.onLoad

    async handler(sock: any, message: any, args: any, context: BotContext) {
        const { chatId } = context;
        const action = args[0]?.toLowerCase();

        if (!action || !['on', 'off'].includes(action)) {
            const currentState = await store.getSetting('global', 'stealthMode');
            const status = currentState?.enabled ? '👻 ON' : '✅ OFF';
            return await sock.sendMessage(chatId, {
                text: `👻 *Stealth Mode:* ${status}\n\n*Usage:* .stealth on / .stealth off\n\n*When ON:*\n• Bot appears permanently offline\n• No typing/online indicators\n• Presence re-asserted every 45 sec\n• Survives reconnects automatically`
            }, { quoted: message });
        }

        const enabled = action === 'on';
        await store.saveSetting('global', 'stealthMode', { enabled });

        if (enabled) {
            _sock = sock;
            startEnforcer();
            await assertOffline(sock);

            let warnings = '';
            try {
                const at = await store.getSetting('global', 'autotyping');
                const ar = await store.getSetting('global', 'autoread');
                if (at?.enabled || ar?.enabled) {
                    warnings = '\n\n⚠️ *Note:*\n';
                    if (at?.enabled) warnings += '• Autotyping enabled but will be suppressed\n';
                    if (ar?.enabled) warnings += '• Autoread enabled but will be suppressed\n';
                }
            } catch (_) {}

            return await sock.sendMessage(chatId, {
                text: `👻 Stealth mode *ON*\n\n✓ Bot is now invisible\n✓ Offline status enforced every 45 sec\n✓ Survives reconnects automatically${warnings}`
            }, { quoted: message });

        } else {
            stopEnforcer();
            _sock = sock;
            try {
                await new Promise(r => setTimeout(r, 300));
                await sock.sendPresenceUpdate('available');
            } catch (_) {}

            return await sock.sendMessage(chatId, {
                text: `✅ Stealth mode *OFF*\n\n✓ Presence updates re-enabled`
            }, { quoted: message });
        }
    }
};