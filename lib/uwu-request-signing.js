// Shared client-side request signing for uwu apps.
// Exposes window.UwuSigning with storeSigningKey/getSigningKey/clearSigningKey/initGuestKey/signedFetch.

(function (global) {
    const LS_KEY = 'uwu_signing_key';
    const SS_KEY = 'uwu_signing_key';

    function storeSigningKey(signingKey, keyId, persistent = false) {
        const payload = JSON.stringify({ signingKey, keyId });
        if (persistent) {
            localStorage.setItem(LS_KEY, payload);
            sessionStorage.removeItem(SS_KEY);
        } else {
            sessionStorage.setItem(SS_KEY, payload);
            localStorage.removeItem(LS_KEY);
        }
    }

    function getSigningKey() {
        const fromLocal = localStorage.getItem(LS_KEY);
        if (fromLocal) {
            try {
                return JSON.parse(fromLocal);
            } catch {
                localStorage.removeItem(LS_KEY);
            }
        }
        const fromSession = sessionStorage.getItem(SS_KEY);
        if (fromSession) {
            try {
                return JSON.parse(fromSession);
            } catch {
                sessionStorage.removeItem(SS_KEY);
            }
        }
        return null;
    }

    function clearSigningKey() {
        localStorage.removeItem(LS_KEY);
        sessionStorage.removeItem(SS_KEY);
    }

    async function initGuestKey(appId) {
        if (getSigningKey()) return;
        const res = await fetch(`/api/auth/guest-key?app_id=${encodeURIComponent(appId)}`);
        if (!res.ok) throw new Error(`Failed to get guest signing key: ${res.status}`);
        const data = await res.json();
        storeSigningKey(data.signing_key, data.key_id, false);
    }

    async function hmacHex(keyStr, message) {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
        return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    function bodyToString(options) {
        if (!options || options.body === undefined || options.body === null) return '';
        if (typeof options.body === 'string') return options.body;
        return JSON.stringify(options.body);
    }

    async function signedFetch(url, options = {}) {
        const key = getSigningKey();
        if (!key) {
            throw new Error('No signing key available — call initGuestKey() or log in first');
        }

        const method = (options.method || 'GET').toUpperCase();
        const path = new URL(url, location.origin).pathname;
        const ts = Date.now().toString();
        const bodyStr = bodyToString(options);
        const bodyHash = bodyStr ? await hmacHex(key.signingKey, bodyStr) : 'empty';
        const message = `${ts}:${method}:${path}:${bodyHash}`;
        const token = await hmacHex(key.signingKey, message);

        const headers = new Headers(options.headers || {});
        headers.set('X-Request-Token', token);
        headers.set('X-Request-TS', ts);
        headers.set('X-Key-ID', key.keyId);

        return fetch(url, { ...options, headers });
    }

    global.UwuSigning = { storeSigningKey, getSigningKey, clearSigningKey, initGuestKey, signedFetch };
})(window);
