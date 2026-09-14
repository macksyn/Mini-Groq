import config from '../config.js';
import { isSudo } from './index.js';

/**
 * Normalize a WhatsApp JID without destroying the distinction
 * between a phone-number JID (@s.whatsapp.net) and a LID (@lid).
 *
 * Examples:
 *   2348089782988:0@s.whatsapp.net -> 2348089782988@s.whatsapp.net
 *   180230366957605@lid            -> 180230366957605@lid
 */
function normalizeJid(jid: string | undefined | null): string {
    if (!jid) return '';

    return String(jid)
        .replace(/^whatsapp:/i, '')
        .split(':')[0]
        .trim()
        .toLowerCase();
}

/**
 * Return the phone number portion of a normal WhatsApp PN JID.
 *
 * IMPORTANT:
 * We intentionally return '' for @lid.
 * A LID is NOT a phone number and must not be compared directly
 * with config.ownerNumber.
 */
function cleanJid(jid: string | undefined | null): string {
    const normalized = normalizeJid(jid);

    if (!normalized) return '';

    if (normalized.endsWith('@lid')) {
        return '';
    }

    return normalized
        .replace('@s.whatsapp.net', '')
        .replace('@c.us', '')
        .replace('@g.us', '');
}

/**
 * Compare two normal phone-number identities.
 */
function samePhoneNumber(
    jid1: string | undefined | null,
    jid2: string | undefined | null
): boolean {
    const a = cleanJid(jid1);
    const b = cleanJid(jid2);

    return !!a && !!b && a === b;
}

/**
 * Check whether a JID represents the bot's own identity.
 *
 * This is especially useful because WhatsApp groups can identify
 * the bot/owner using a @lid instead of the normal phone JID.
 */
function isBotIdentity(
    senderId: string,
    sock: any
): boolean {
    if (!sock?.user) return false;

    const sender = normalizeJid(senderId);

    if (!sender) return false;

    // Bot's normal phone-number identity
    if (sock.user.id) {
        const botId = normalizeJid(sock.user.id);

        if (sender === botId) {
            console.log('[isOwner] ✅ Bot identity match');
            return true;
        }

        // Also compare phone numbers in case one contains a device suffix.
        if (samePhoneNumber(senderId, sock.user.id)) {
            console.log('[isOwner] ✅ Bot phone identity match');
            return true;
        }
    }

    // Bot's LID identity.
    //
    // This is the important part for group messages where WhatsApp
    // sends the owner as something like:
    // 180230366957605@lid
    if (sock.user.lid) {
        const botLid = normalizeJid(sock.user.lid);

        if (sender === botLid) {
            console.log('[isOwner] ✅ Bot LID identity match');
            return true;
        }
    }

    return false;
}

/**
 * Try to determine whether a group participant corresponds
 * to the configured owner or a sudo user.
 */
async function checkGroupParticipant(
    senderId: string,
    chatId: string,
    sock: any,
    ownerNumberClean: string
): Promise<boolean> {
    if (!sock || !chatId || !chatId.endsWith('@g.us')) {
        return false;
    }

    try {
        const metadata = await sock.groupMetadata(chatId);
        const participants = metadata?.participants || [];

        console.log('[isOwner] Participants:', participants.length);

        const senderNormalized = normalizeJid(senderId);

        const participant = participants.find((p: any) => {
            const identities = [
                p?.id,
                p?.lid,
                p?.jid,
                p?.phoneNumber,
                p?.phoneNumberJid
            ]
                .filter(Boolean)
                .map((id: string) => normalizeJid(id));

            return identities.includes(senderNormalized);
        });

        if (!participant) {
            console.log('[isOwner] ❌ Sender not found in group participants');
            return false;
        }

        console.log('[isOwner] Resolved participant:', {
            id: participant.id,
            lid: participant.lid,
            jid: participant.jid,
            phoneNumber: participant.phoneNumber,
            phoneNumberJid: participant.phoneNumberJid
        });

        // Check every identity Baileys gives us for this participant.
        const identities = [
            participant.id,
            participant.lid,
            participant.jid,
            participant.phoneNumber,
            participant.phoneNumberJid
        ].filter(Boolean);

        for (const identity of identities) {
            // Owner phone number
            if (samePhoneNumber(identity, ownerNumberClean)) {
                console.log('[isOwner] ✅ Owner matched through group participant');
                return true;
            }

            // Sudo
            if (await isSudo(identity)) {
                console.log('[isOwner] ✅ Sudo matched through group participant');
                return true;
            }
        }

    } catch (error: any) {
        console.error(
            '[isOwner] Group participant lookup error:',
            error?.message || error
        );
    }

    return false;
}

/**
 * Check if user is owner or sudo.
 *
 * Owner detection order:
 *
 * 1. Configured owner phone number
 * 2. Bot's own WhatsApp identity
 * 3. Bot's own LID
 * 4. Direct sudo
 * 5. Group participant identity resolution
 */
async function isOwnerOrSudo(
    senderId: string,
    sock: any = null,
    chatId: string | null = null
): Promise<boolean> {

    try {
        const ownerNumberClean = cleanJid(config.ownerNumber);
        const senderIdClean = cleanJid(senderId);

        console.log('[isOwner] ===========================');
        console.log('[isOwner] Sender:', senderId);
        console.log('[isOwner] Config owner:', ownerNumberClean);
        console.log('[isOwner] Chat:', chatId);

        /**
         * 1. Direct configured owner match
         *
         * Works for private chats where sender is:
         * 2348089782988@s.whatsapp.net
         */
        if (
            senderIdClean &&
            ownerNumberClean &&
            senderIdClean === ownerNumberClean
        ) {
            console.log('[isOwner] ✅ Direct owner match');
            return true;
        }

        /**
         * 2 + 3. Bot identity / bot LID
         *
         * This is what handles the important group case where
         * WhatsApp sends the owner as @lid.
         */
        if (isBotIdentity(senderId, sock)) {
            return true;
        }

        /**
         * 4. Direct sudo check
         */
        if (await isSudo(senderId)) {
            console.log('[isOwner] ✅ Direct sudo match');
            return true;
        }

        /**
         * 5. Group participant resolution
         */
        if (
            sock &&
            chatId &&
            chatId.endsWith('@g.us')
        ) {
            const groupMatch = await checkGroupParticipant(
                senderId,
                chatId,
                sock,
                ownerNumberClean
            );

            if (groupMatch) {
                return true;
            }
        }

        console.log('[isOwner] ❌ Not owner');

        return false;

    } catch (error: any) {
        console.error(
            '[isOwner] Error:',
            error?.message || error
        );

        return false;
    }
}

/**
 * Check if user is ONLY the configured owner.
 *
 * This intentionally does NOT treat sudo users as owner.
 */
function isOwnerOnly(senderId: string): boolean {
    const ownerNumberClean = cleanJid(config.ownerNumber);
    const senderIdClean = cleanJid(senderId);

    return !!(
        ownerNumberClean &&
        senderIdClean &&
        ownerNumberClean === senderIdClean
    );
}

/**
 * Helper for commands that need a clean phone number.
 *
 * Example:
 *   getCleanName('2348089782988@s.whatsapp.net', sock)
 *   -> '2348089782988'
 */
async function getCleanName(
    jid: string,
    sock: any
): Promise<string> {
    if (!jid) return 'Unknown';

    const cleanNumber = cleanJid(jid);

    // LIDs don't contain a phone number.
    if (!cleanNumber) {
        return normalizeJid(jid).replace('@lid', '');
    }

    try {
        if (sock) {
            const contact = await sock.onWhatsApp(jid);

            if (
                contact &&
                contact[0] &&
                contact[0].exists
            ) {
                return cleanNumber;
            }
        }
    } catch {
        // Ignore lookup errors and return cleaned value.
    }

    return cleanNumber;
}

export default isOwnerOrSudo;

export {
    isOwnerOnly,
    cleanJid,
    normalizeJid,
    samePhoneNumber,
    getCleanName
};