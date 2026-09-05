// Thin PostgREST client for the serverless functions.
// The service key bypasses row level security, so this file must never be
// imported from anything that ships to a browser. Files under api/_lib are
// ignored by the Vercel function builder, which is why the underscore is there.

import crypto from 'node:crypto';

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export function isConfigured() {
    return Boolean(URL_BASE && SERVICE_KEY);
}

function headers(extra = {}) {
    return {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...extra,
    };
}

/** Postgres SQLSTATE for a unique index violation, passed through by PostgREST. */
export const UNIQUE_VIOLATION = '23505';

async function parse(res) {
    const text = await res.text();
    if (!res.ok) {
        const err = new Error(`Supabase ${res.status}: ${text}`);
        err.status = res.status;
        err.body = text;
        // The SQLSTATE is the only reliable way to tell a row that is already
        // there from any other failure, so carry it on the error.
        try {
            err.code = (JSON.parse(text) || {}).code;
        } catch {
            err.code = undefined;
        }
        throw err;
    }
    return text ? JSON.parse(text) : null;
}

/** Select rows. `query` is a PostgREST query string without the leading "?". */
export async function select(table, query = '') {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}${query ? `?${query}` : ''}`, {
        headers: headers(),
    });
    return parse(res);
}

/** Insert one or more rows. Pass `upsert` to merge on the primary key. */
export async function insert(table, rows, { upsert = false, onConflict } = {}) {
    const prefer = ['return=representation'];
    if (upsert) prefer.push('resolution=merge-duplicates');
    const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    const res = await fetch(`${URL_BASE}/rest/v1/${table}${qs}`, {
        method: 'POST',
        headers: headers({ Prefer: prefer.join(',') }),
        body: JSON.stringify(rows),
    });
    return parse(res);
}

/** Patch rows matching a PostgREST filter. */
export async function update(table, query, patch) {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${query}`, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify(patch),
    });
    return parse(res);
}

/** Delete rows matching a PostgREST filter. */
export async function remove(table, query) {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${query}`, {
        method: 'DELETE',
        headers: headers({ Prefer: 'return=representation' }),
    });
    return parse(res);
}

/** Call one of the sgbp_* SQL functions. */
export async function rpc(fn, args = {}) {
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(args),
    });
    return parse(res);
}

// ── Small crypto helpers, shared by the device and backup code endpoints.

export function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function randomToken(bytes = 24) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Backup codes are shown to a human once, so they use an unambiguous alphabet.
 * No 0/O and no 1/I/L, formatted as XXXX-XXXX-XXXX.
 *
 * Twelve characters over a 31 symbol alphabet is about 59 bits. That matters
 * more than it looks, because redemption matches a hash across every user at
 * once rather than against one named account, so an attacker guessing is
 * guessing at all outstanding codes simultaneously. Rate limiting is the real
 * defence and the length is the backstop.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;

export function generateBackupCode() {
    // Rejection sampling, so the modulo does not bias the alphabet.
    const limit = 256 - (256 % CODE_ALPHABET.length);
    const chars = [];

    while (chars.length < CODE_GROUPS * CODE_GROUP_LENGTH) {
        for (const byte of crypto.randomBytes(32)) {
            if (byte >= limit) continue;
            chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
            if (chars.length === CODE_GROUPS * CODE_GROUP_LENGTH) break;
        }
    }

    return Array.from({ length: CODE_GROUPS }, (_, i) =>
        chars.slice(i * CODE_GROUP_LENGTH, (i + 1) * CODE_GROUP_LENGTH).join('')
    ).join('-');
}

/**
 * Count one hit against a named bucket and say whether it is allowed.
 *
 * Serverless functions keep nothing between invocations, so the counter lives
 * in the database and the increment is a single atomic upsert. A limiter that
 * cannot be reached should not lock people out of the product, so a failure
 * here is reported as allowed and logged by the caller.
 */
export async function rateLimit(bucket, limit, windowSeconds) {
    try {
        const result = await rpc('sgbp_rate_limit_hit', {
            p_bucket: bucket,
            p_limit: limit,
            p_window_seconds: windowSeconds,
        });
        return result || { allowed: true, retry_after: 0 };
    } catch {
        return { allowed: true, retry_after: 0, degraded: true };
    }
}

/** Constant time compare for anything secret. */
export function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}
