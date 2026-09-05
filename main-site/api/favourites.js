// Favourites for one browser session, or for the Telegram account it is linked
// to. Which of the two is decided by resolveOwner, so the client never has to
// know or care whether a link exists.
//
//   GET    /api/favourites               -> { linked, telegram_id, favourites: [] }
//   POST   /api/favourites               -> add one, ignoring duplicates
//   DELETE /api/favourites?code=XXXXX    -> remove one
//
// Every call carries X-Device-Id and X-Device-Secret.

import { select, insert, remove } from './_lib/supabase.js';
import {
    applyCors,
    fail,
    readBody,
    requireConfig,
    authenticateDevice,
    resolveOwner,
    ownerColumns,
} from './_lib/http.js';

const SELECT_COLS = 'code,description,rack_type,rack_count,sheltered,latitude,longitude,created_at';

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireConfig(res)) return;

    const device = await authenticateDevice(req, res);
    if (!device) return;

    let owner;
    try {
        owner = await resolveOwner(device.id);
    } catch (err) {
        return fail(res, 500, err.message);
    }

    try {
        if (req.method === 'GET') return await list(res, owner);
        if (req.method === 'POST') return await add(req, res, owner);
        if (req.method === 'DELETE') return await drop(req, res, owner);
        return fail(res, 405, 'Method not allowed.');
    } catch (err) {
        return fail(res, 500, err.message);
    }
}

async function list(res, owner) {
    const rows = await select(
        'sgbp_favourites',
        `${owner.filter}&select=${SELECT_COLS}&order=created_at.asc`
    );
    return res.status(200).json({
        linked: owner.linked,
        telegram_id: owner.telegramId,
        favourites: rows || [],
    });
}

async function add(req, res, owner) {
    const body = readBody(req);
    const code = String(body.code || '').trim();
    if (!code) return fail(res, 400, 'A parking code is required.');
    if (code.length > 120) return fail(res, 400, 'That parking code is too long.');

    const row = {
        ...ownerColumns(owner),
        code,
        description: body.description ? String(body.description).slice(0, 300) : code,
        rack_type: body.rack_type ? String(body.rack_type).slice(0, 60) : null,
        rack_count: Number.isFinite(Number(body.rack_count)) ? Number(body.rack_count) : null,
        sheltered: Boolean(body.sheltered),
        latitude: Number.isFinite(Number(body.latitude)) ? Number(body.latitude) : null,
        longitude: Number.isFinite(Number(body.longitude)) ? Number(body.longitude) : null,
    };

    // The unique indexes make a repeat save a no-op rather than an error.
    const conflict = owner.linked ? 'telegram_id,code' : 'device_id,code';
    const rows = await insert('sgbp_favourites', row, { upsert: true, onConflict: conflict });

    return res.status(200).json({ ok: true, favourite: (rows && rows[0]) || row });
}

async function drop(req, res, owner) {
    const code = String((req.query && req.query.code) || readBody(req).code || '').trim();
    if (!code) return fail(res, 400, 'A parking code is required.');

    const gone = await remove(
        'sgbp_favourites',
        `${owner.filter}&code=eq.${encodeURIComponent(code)}`
    );
    return res.status(200).json({ ok: true, removed: (gone || []).length });
}
