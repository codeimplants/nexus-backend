import { MessagingClient } from '@codeimplants/messaging-node';

let client: MessagingClient | null | undefined;

/**
 * The Code Implants Messaging client for the console's OTP login, or null when
 * MESSAGING_API_KEY is missing, in which case OTP login is refused (see
 * AuthService). Nexus moved here from calling 2Factor directly on 2026-10-21,
 * the last of the apps to do so.
 *
 * Messaging (msg.codeimplants.com) holds the one copy of the 2Factor key the
 * Code Implants apps share, applies the per-number limits in one place, and
 * reports who used how many SMS. On dev and preprod it sends nothing and every
 * code is 123456 (owner's decision, 2026-10-21: no real SMS outside prod).
 */
export function messagingClient(): MessagingClient | null {
    if (client === undefined) {
        const apiKey = process.env.MESSAGING_API_KEY?.trim();
        // A malformed key throws here, at the first OTP, so the misconfiguration
        // is loud rather than a silent "service unavailable".
        client = apiKey
            ? new MessagingClient({ apiKey, baseUrl: process.env.MESSAGING_BASE_URL?.trim() || undefined })
            : null;
    }
    return client;
}
