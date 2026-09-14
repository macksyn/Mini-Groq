import config from '../config.js';
import { isSudo } from './index.js';

/**
 * Normalize a JID without destroying whether it is a LID or PN.
 *
 * Examples:
 *
 * 2348089782988@s.whatsapp.net
 * 2348089782988:12@s.whatsapp.net
 * 123456789@lid
 *
 * become:
 *
 * 2348089782988@s.whatsapp.net
 * 2348089782988@s.whatsapp.net
 * 123456789@lid
 */
function normalizeJid(jid: string | undefined | null): string {
    if (!jid) return '';

    return jid
        .trim()
        .replace(/^whatsapp:/i, '')
        .replace(/:\d+(?=@)/, '');
}

/**
 * Extract phone number from a PN JID.
 *
 * IMPORTANT:
 * A LID is NOT a phone number, so we return ''
 * for @lid.
 */
function cleanJid(jid: string | undefined | null): string {
    const normalized = normalizeJid(jid);

    if (!normalized || normalized.endsWith('@lid')) {
        return '';
    }

    return normalized
        .split('@')[0]
        .replace(/\D/g, '');
}

/**
 * Compare two phone identities.
 */
function samePhoneNumber(
    a: string | undefined | null,
    b: string | undefined | null
): boolean {
    const aNumber = cleanJid(a);
    const bNumber = cleanJid(b);

    return !!aNumber && !!bNumber && aNumber === bNumber;
}

/**
 * Check whether a JID is the configured owner.
 */
function isConfiguredOwner(jid: string): boolean {
    return samePhoneNumber(jid, config.ownerNumber);
}

/**
 * Find a group participant from either their PN or LID.
 */
function findParticipant(
    participants: any[],
    senderId: string
) {
    const sender = normalizeJid(senderId);

    return participants.find((participant: any) => {

        const identities = [
            participant.id,
            participant.lid,
            participant.jid,
            participant.phoneNumber,
            participant.phoneNumberJid,
        ].filter(Boolean);

        return identities.some(
            (identity: string) =>
                normalizeJid(identity) === sender
        );
    });
}

/**
 * Check whether a user is owner or sudo.
 */
async function isOwnerOrSudo(
    senderId: string,
    sock: any = null,
    chatId: string | null = null
): Promise<boolean> {

    if (!senderId) {
        return false;
    }

    const sender = normalizeJid(senderId);

    console.log('[isOwner] ===========================');
    console.log('[isOwner] Sender:', sender);
    console.log('[isOwner] Config owner:', config.ownerNumber);
    console.log('[isOwner] Chat:', chatId);

    // =========================================================
    // 1. Direct owner check
    // =========================================================

    if (isConfiguredOwner(sender)) {
        console.log('[isOwner] ✅ Direct owner match');
        return true;
    }

    // =========================================================
    // 2. Sudo check
    // =========================================================

    try {
        if (await isSudo(sender)) {
            console.log('[isOwner] ✅ Sudo match');
            return true;
        }
    } catch (error) {
        console.error('[isOwner] Sudo check failed:', error);
    }

    // =========================================================
    // 3. Resolve LID through group metadata
    // =========================================================

    if (
        sock &&
        chatId &&
        chatId.endsWith('@g.us')
    ) {

        try {

            const metadata =
                await sock.groupMetadata(chatId);

            const participants =
                metadata?.participants || [];

            console.log(
                `[isOwner] Participants: ${participants.length}`
            );

            const participant =
                findParticipant(
                    participants,
                    sender
                );

            if (participant) {

                console.log(
                    '[isOwner] Resolved participant:',
                    {
                        id: participant.id,
                        lid: participant.lid,
                        jid: participant.jid,
                    }
                );

                // ---------------------------------------------
                // Check the participant's real PN
                // ---------------------------------------------

                if (
                    participant.id &&
                    isConfiguredOwner(
                        participant.id
                    )
                ) {
                    console.log(
                        '[isOwner] ✅ LID resolved to OWNER'
                    );

                    return true;
                }

                // ---------------------------------------------
                // Check all participant identities for sudo
                // ---------------------------------------------

                const identities = [
                    participant.id,
                    participant.lid,
                    participant.jid,
                ].filter(Boolean);

                for (const identity of identities) {

                    if (
                        await isSudo(identity)
                    ) {
                        console.log(
                            '[isOwner] ✅ LID resolved to SUDO'
                        );

                        return true;
                    }
                }

            } else {

                console.log(
                    '[isOwner] ⚠️ Participant not found'
                );
            }

        } catch (error: any) {

            console.error(
                '[isOwner] Group metadata error:',
                error?.message || error
            );
        }
    }

    // =========================================================
    // 4. Check bot's own identity
    // =========================================================

    if (sock?.user?.id) {

        if (
            samePhoneNumber(
                sender,
                sock.user.id
            )
        ) {
            console.log(
                '[isOwner] ✅ Matches bot identity'
            );

            return true;
        }
    }

    console.log('[isOwner] ❌ Not owner');

    return false;
}

/**
 * Owner ONLY check.
 */
function isOwnerOnly(
    senderId: string
): boolean {

    return isConfiguredOwner(senderId);
}

/**
 * Return a clean phone number for display.
 */
async function getCleanName(
    jid: string,
    sock: any
) {

    if (!jid) {
        return 'Unknown';
    }

    const cleanNumber =
        cleanJid(jid);

    if (!cleanNumber) {
        return normalizeJid(jid);
    }

    try {

        if (sock) {

            const contact =
                await sock.onWhatsApp(jid);

            if (
                contact?.[0]?.exists
            ) {
                return cleanNumber;
            }
        }

    } catch {
        // Ignore
    }

    return cleanNumber;
}

export default isOwnerOrSudo;

export {
    isOwnerOnly,
    cleanJid,
    getCleanName,
    normalizeJid,
};