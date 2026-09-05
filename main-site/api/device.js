// Registers a browser session so it can own favourites on the server.
//
// POST /api/device
//   -> { device_id, device_secret }
//
// The secret is returned exactly once and lives in localStorage from then on.
// Only its sha256 hash is stored. Losing it means losing the favourites tied
// to that browser, which is precisely what the backup codes are there to fix.

import { insert, sha256, randomToken, rateLimit } from './_lib/supabase.js';
import { applyCors, clientIp, fail, requireConfig, tooManyRequests } from './_lib/http.js';

// A real person needs one of these per browser, once. Twenty a day leaves room
// for private windows and cleared site data while making a bulk loop pointless.
const REGISTRATIONS_PER_DAY = 20;

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
    if (!requireConfig(res)) return;

    const verdict = await rateLimit(`device:ip:${clientIp(req)}`, REGISTRATIONS_PER_DAY, 86400);
    if (tooManyRequests(res, verdict, 'Too many devices registered from here today.')) return;

    const secret = randomToken(32);

    try {
        const rows = await insert('sgbp_devices', { secret_hash: sha256(secret) });
        const device = rows && rows[0];
        if (!device) return fail(res, 500, 'Could not register this device.');

        return res.status(201).json({
            device_id: device.id,
            device_secret: secret,
        });
    } catch (err) {
        return fail(res, 500, err.message);
    }
}
