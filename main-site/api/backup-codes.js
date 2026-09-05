// Two factor backup codes for favourites recovery.
//
// The point of these is the case where Telegram itself is unreachable: a lost
// phone, a locked account, a wiped browser. Redeeming a code attaches a fresh
// browser session to the same favourites the Telegram account owns.
//
// Generating them is deliberately gated on a Telegram approval, so possession
// of an already linked browser is not enough on its own to mint recovery
// credentials. The bot asks the human first, and only an approved request
// releases the codes.
//
//   POST /api/backup-codes  { action: "request" }
//        -> { request_id, expires_at }            asks the bot to prompt
//   GET  /api/backup-codes?request_id=UUID
//        -> { status } while waiting, and { status: "approved", codes: [...] }
//           exactly once after the human taps Approve
//   POST /api/backup-codes  { action: "redeem", code: "XXXX-XXXX" }
//        -> attaches this device to the Telegram account behind that code
//
// Codes are stored as sha256 hashes and are single use.

import crypto from 'node:crypto';
import {
    select,
    insert,
    update,
    remove,
    rpc,
    sha256,
    generateBackupCode,
    rateLimit,
} from './_lib/supabase.js';
import {
    applyCors,
    clientIp,
    fail,
    readBody,
    requireConfig,
    authenticateDevice,
    resolveOwner,
    tooManyRequests,
} from './_lib/http.js';

const CODES_PER_BATCH = 10;

// Redemption matches a hash across every user at once rather than against one
// named account, so an attacker guessing is guessing at all outstanding codes
// at the same time. Throttling both the source address and the calling device
// is what makes that impractical. Ten an hour is far more than anyone typing a
// code off a piece of paper will ever need.
const REDEEMS_PER_HOUR = 10;

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireConfig(res)) return;

    const device = await authenticateDevice(req, res);
    if (!device) return;

    try {
        if (req.method === 'POST') {
            const body = readBody(req);
            if (body.action === 'redeem') return await redeem(req, res, device, body);
            if (body.action === 'request') return await request(res, device);
            return fail(res, 400, 'Unknown action.');
        }
        if (req.method === 'GET') return await poll(req, res, device);
        return fail(res, 405, 'Method not allowed.');
    } catch (err) {
        return fail(res, 500, err.message);
    }
}

// ── Step one: ask the bot to get a human to approve this.
async function request(res, device) {
    const owner = await resolveOwner(device.id);
    if (!owner.linked) {
        return fail(res, 409, 'Link a Telegram account before creating backup codes.');
    }

    // One live request at a time keeps the chat from filling with prompts.
    const existing = await select(
        'sgbp_backup_requests',
        `device_id=eq.${device.id}&status=in.(pending,notified)&expires_at=gt.${new Date().toISOString()}&select=id,expires_at&limit=1`
    );
    if (existing && existing[0]) {
        return res.status(200).json({
            request_id: existing[0].id,
            expires_at: existing[0].expires_at,
            reused: true,
        });
    }

    const rows = await insert('sgbp_backup_requests', {
        telegram_id: owner.telegramId,
        device_id: device.id,
    });
    const row = rows && rows[0];
    if (!row) return fail(res, 500, 'Could not raise the approval request.');

    return res.status(201).json({ request_id: row.id, expires_at: row.expires_at });
}

// ── Step two: the browser polls until the human decides.
async function poll(req, res, device) {
    const id = String((req.query && req.query.request_id) || '');
    if (!id) return fail(res, 400, 'A request_id is required.');

    const rows = await select(
        'sgbp_backup_requests',
        `id=eq.${encodeURIComponent(id)}&device_id=eq.${device.id}&select=id,telegram_id,status,expires_at&limit=1`
    );
    const reqRow = rows && rows[0];
    if (!reqRow) return fail(res, 404, 'No such request.');

    if (reqRow.status !== 'approved') {
        const expired =
            (reqRow.status === 'pending' || reqRow.status === 'notified') &&
            new Date(reqRow.expires_at) < new Date();
        return res.status(200).json({ status: expired ? 'expired' : reqRow.status });
    }

    // Approved, and not yet collected. Mint the batch and hand it over once.
    // Marking the request consumed first means a double poll cannot produce
    // two batches, at the cost of a lost batch if the response never lands.
    const claimed = await update(
        'sgbp_backup_requests',
        `id=eq.${reqRow.id}&status=eq.approved`,
        { status: 'consumed' }
    );
    if (!claimed || !claimed.length) {
        return res.status(200).json({ status: 'consumed' });
    }

    // Regenerating invalidates whatever was outstanding before.
    await remove(
        'sgbp_backup_codes',
        `telegram_id=eq.${reqRow.telegram_id}&used_at=is.null`
    );

    const batchId = crypto.randomUUID();
    const codes = Array.from({ length: CODES_PER_BATCH }, generateBackupCode);

    await insert(
        'sgbp_backup_codes',
        codes.map((code) => ({
            telegram_id: reqRow.telegram_id,
            batch_id: batchId,
            code_hash: sha256(code),
        }))
    );

    return res.status(200).json({ status: 'approved', codes });
}

// ── Recovery: no Telegram involved.
async function redeem(req, res, device, body) {
    // Both buckets have to pass, so neither rotating addresses nor reusing one
    // device gets an attacker a meaningfully larger number of guesses.
    const [byIp, byDevice] = await Promise.all([
        rateLimit(`redeem:ip:${clientIp(req)}`, REDEEMS_PER_HOUR, 3600),
        rateLimit(`redeem:device:${device.id}`, REDEEMS_PER_HOUR, 3600),
    ]);
    const blocked = !byIp.allowed ? byIp : byDevice;
    if (tooManyRequests(res, blocked, 'Too many attempts. Please wait and try again.')) return;

    const raw = String(body.code || '').trim().toUpperCase().replace(/[\s-]+/g, '');
    if (!raw) return fail(res, 400, 'A backup code is required.');

    // Accept the code however it was typed, with or without its hyphens.
    const normalised = raw.replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');

    const result = await rpc('sgbp_redeem_backup_code', {
        p_code_hash: sha256(normalised),
        p_device_id: device.id,
    });

    if (!result || result.ok !== true) {
        const error = (result && result.error) || 'invalid_code';
        const message =
            error === 'already_used'
                ? 'That backup code has already been used.'
                : 'That backup code is not valid.';
        return res.status(400).json({ ok: false, error, message });
    }

    return res.status(200).json({
        ok: true,
        merged: result.merged,
        total: result.total,
    });
}
