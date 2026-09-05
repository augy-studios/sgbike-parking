// The link handshake, from the browser's side.
//
//   POST   /api/link   -> mint a single use token and the t.me deep link
//   GET    /api/link   -> current link status for this device
//   DELETE /api/link   -> unlink this device only
//
// The bot does the other half. It receives the token as the start payload and
// calls sgbp_consume_link_token, which creates the link and merges the two
// favourite sets in one transaction.

import { select, insert, rpc, randomToken } from './_lib/supabase.js';
import {
    applyCors,
    fail,
    requireConfig,
    authenticateDevice,
    resolveOwner,
} from './_lib/http.js';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'sgbikepark_bot';
const TOKEN_TTL_MINUTES = 15;

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireConfig(res)) return;

    const device = await authenticateDevice(req, res);
    if (!device) return;

    try {
        if (req.method === 'POST') return await mint(res, device);
        if (req.method === 'GET') return await status(res, device);
        if (req.method === 'DELETE') return await unlink(res, device);
        return fail(res, 405, 'Method not allowed.');
    } catch (err) {
        return fail(res, 500, err.message);
    }
}

async function mint(res, device) {
    // Telegram start payloads are limited to 64 characters and allow only
    // A-Z, a-z, 0-9, underscore and hyphen, which base64url already satisfies.
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000).toISOString();

    await insert('sgbp_link_tokens', {
        token,
        device_id: device.id,
        expires_at: expiresAt,
    });

    return res.status(201).json({
        token,
        url: `https://t.me/${BOT_USERNAME}?start=${token}`,
        expires_at: expiresAt,
    });
}

async function status(res, device) {
    const owner = await resolveOwner(device.id);

    if (!owner.linked) {
        const mine = await select(
            'sgbp_favourites',
            `device_id=eq.${device.id}&select=code`
        );
        return res.status(200).json({
            linked: false,
            favourites: (mine || []).length,
        });
    }

    const [user, devices, favourites, codes] = await Promise.all([
        select('sgbp_telegram_users', `telegram_id=eq.${owner.telegramId}&select=username,first_name&limit=1`),
        select('sgbp_links', `telegram_id=eq.${owner.telegramId}&select=device_id`),
        select('sgbp_favourites', `telegram_id=eq.${owner.telegramId}&select=code`),
        select('sgbp_backup_codes', `telegram_id=eq.${owner.telegramId}&used_at=is.null&select=id`),
    ]);

    return res.status(200).json({
        linked: true,
        telegram_id: owner.telegramId,
        username: (user && user[0] && user[0].username) || null,
        first_name: (user && user[0] && user[0].first_name) || null,
        linked_at: owner.linkedAt,
        linked_via: owner.linkedVia,
        devices: (devices || []).length,
        favourites: (favourites || []).length,
        backup_codes_remaining: (codes || []).length,
    });
}

async function unlink(res, device) {
    // The stored procedure copies the Telegram favourites back onto this
    // device before cutting the link, so unlinking never empties the list.
    const result = await rpc('sgbp_unlink_device', { p_device_id: device.id });

    if (!result || result.ok !== true) {
        return res.status(200).json({ ok: false, error: (result && result.error) || 'not_linked' });
    }
    return res.status(200).json({ ok: true, kept: result.kept });
}
