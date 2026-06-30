// Shared server-side request signing verification for uwu apps (Vercel functions).

import crypto from 'node:crypto';

function hmacHex(keyStr, message) {
    return crypto.createHmac('sha256', keyStr).update(message).digest('hex');
}

function timingSafeEqual(a, b) {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function isEmptyBody(req) {
    if (req.body === undefined || req.body === null || req.body === '') return true;
    if (typeof req.body === 'object' && JSON.stringify(req.body) === '{}') return true;
    return false;
}

function bodyToString(req) {
    if (isEmptyBody(req)) return '';
    return typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
}

function getSessionToken(req) {
    const keyId = req.headers['x-key-id'];
    if (keyId) return keyId;
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    return null;
}

export async function verifySignedRequest(req, supabase) {
    const token = req.headers['x-request-token'];
    const ts = req.headers['x-request-ts'];
    const sessionToken = getSessionToken(req);

    if (!token || !ts || !sessionToken) {
        return { valid: false, reason: 'missing signature headers' };
    }

    const now = Date.now();
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 30000) {
        return { valid: false, reason: 'timestamp out of range' };
    }

    const { data: keyRow, error: keyErr } = await supabase
        .from('uwu_signing_keys')
        .select('signing_key,expires_at')
        .eq('session_token', sessionToken)
        .single();

    if (keyErr || !keyRow) {
        return { valid: false, reason: 'unknown signing key' };
    }

    if (new Date(keyRow.expires_at).getTime() < now) {
        return { valid: false, reason: 'signing key expired' };
    }

    const method = req.method.toUpperCase();
    const path = (req.url || '').split('?')[0];
    const bodyStr = bodyToString(req);
    const bodyHash = bodyStr ? hmacHex(keyRow.signing_key, bodyStr) : 'empty';
    const message = `${ts}:${method}:${path}:${bodyHash}`;
    const expectedToken = hmacHex(keyRow.signing_key, message);

    if (!timingSafeEqual(token, expectedToken)) {
        return { valid: false, reason: 'invalid signature' };
    }

    const { data: usedRow } = await supabase
        .from('uwu_used_request_tokens')
        .select('token')
        .eq('token', token)
        .maybeSingle();

    if (usedRow) {
        return { valid: false, reason: 'replayed request' };
    }

    await supabase
        .from('uwu_used_request_tokens')
        .insert({ token, session_token: sessionToken, used_at: new Date().toISOString() });

    return { valid: true, reason: 'ok' };
}
