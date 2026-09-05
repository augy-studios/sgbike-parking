// Request plumbing shared by the sync endpoints: CORS, JSON bodies, device
// authentication, and owner resolution.

import { select, update, sha256, safeEqual, isConfigured } from './supabase.js';

/**
 * Best guess at who is calling, for rate limiting buckets.
 *
 * Vercel sits in front of every request and sets these, overwriting whatever
 * the client sent, so the leftmost entry is the real peer here. Do not copy
 * this into a deployment without a trusted proxy in front, where the header is
 * attacker controlled and trivially spoofed.
 */
export function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return String(req.headers['x-real-ip'] || 'unknown');
}

/** Reject a request that has used up its allowance. Returns true if handled. */
export function tooManyRequests(res, verdict, message) {
    if (verdict.allowed) return false;
    if (verdict.retry_after) res.setHeader('Retry-After', String(verdict.retry_after));
    res.status(429).json({ error: message, retry_after: verdict.retry_after || 0 });
    return true;
}

export function applyCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id, X-Device-Secret');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return true;
    }
    return false;
}

export function fail(res, status, error, extra = {}) {
    return res.status(status).json({ error, ...extra });
}

/** Vercel parses JSON bodies already, but be tolerant of a raw string. */
export function readBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body);
        } catch {
            return {};
        }
    }
    return req.body;
}

/** Guard every handler so a missing Supabase config fails loudly and early. */
export function requireConfig(res) {
    if (!isConfigured()) {
        fail(res, 503, 'Sync is not configured on this deployment.');
        return false;
    }
    return true;
}

/**
 * Verify the device id and secret the browser sends on every sync call.
 * Returns the device row, or null after having written the error response.
 */
export async function authenticateDevice(req, res) {
    const id = req.headers['x-device-id'];
    const secret = req.headers['x-device-secret'];

    if (!id || !secret) {
        fail(res, 401, 'Missing device credentials.');
        return null;
    }
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) {
        fail(res, 400, 'Malformed device id.');
        return null;
    }

    const rows = await select(
        'sgbp_devices',
        `id=eq.${encodeURIComponent(id)}&select=id,secret_hash&limit=1`
    );
    const device = rows && rows[0];

    if (!device || !safeEqual(device.secret_hash, sha256(secret))) {
        fail(res, 401, 'Device not recognised.');
        return null;
    }

    // Best effort liveness stamp. A failure here must not break the request.
    update('sgbp_devices', `id=eq.${device.id}`, { last_seen_at: new Date().toISOString() })
        .catch(() => {});

    return device;
}

/**
 * Work out whose favourites this device reads and writes.
 * Linked devices operate on the Telegram user's set, unlinked ones on their own.
 */
export async function resolveOwner(deviceId) {
    const rows = await select(
        'sgbp_links',
        `device_id=eq.${deviceId}&select=telegram_id,linked_at,linked_via&limit=1`
    );
    const link = rows && rows[0];
    if (!link) {
        return { deviceId, telegramId: null, linked: false, filter: `device_id=eq.${deviceId}` };
    }
    return {
        deviceId,
        telegramId: link.telegram_id,
        linked: true,
        linkedAt: link.linked_at,
        linkedVia: link.linked_via,
        filter: `telegram_id=eq.${link.telegram_id}`,
    };
}

/** The column pair that stamps ownership onto a new favourite row. */
export function ownerColumns(owner) {
    return owner.linked
        ? { telegram_id: owner.telegramId, device_id: null }
        : { device_id: owner.deviceId, telegram_id: null };
}
