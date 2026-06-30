import crypto from 'node:crypto';
import { getSupabaseClient } from '../../lib/uwu-supabase-rest.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
    }

    const origin = req.headers['origin'];
    if (origin) {
        const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim());
        if (!allowed.includes(origin)) {
            return res.status(403).json({ error: 'origin not allowed' });
        }
    }

    const appId = (req.query.app_id || 'unknown').toString();
    const sessionToken = crypto.randomUUID();
    const signingKey = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const supabase = getSupabaseClient();
    const { error } = await supabase.from('uwu_signing_keys').insert({
        session_token: sessionToken,
        signing_key: signingKey,
        is_guest: true,
        app_id: appId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
    });

    if (error) {
        return res.status(500).json({ error: 'failed to create guest key' });
    }

    return res.status(200).json({ key_id: sessionToken, signing_key: signingKey });
}
