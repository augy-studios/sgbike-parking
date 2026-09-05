// Favourites store and sync client.
// Plain script, no modules, matching the rest of the site.
//
// Design notes
//   Favourites are local first. Tapping a star writes to localStorage and the
//   UI updates straight away, so the feature works with no network and with no
//   Telegram link at all. Server calls happen behind that, and anything that
//   fails goes into an outbox which is replayed on the next load or when the
//   browser comes back online.
//
//   A device identifies itself with a device id and a device secret, both kept
//   in localStorage. There is no account and no auth. Registration is lazy: a
//   visitor who never saves a favourite never gets a row in the database.
//
//   Once a device is linked to a Telegram account, the server quietly serves
//   the Telegram account's favourites instead of the device's own. The client
//   does not need to know which of the two it is talking to.

const SYNC_DEVICE_KEY = 'sgbikes.device';
const SYNC_FAV_KEY = 'sgbikes.favourites';
const SYNC_OUTBOX_KEY = 'sgbikes.outbox';

const Sync = (() => {
    let device = null;         // { id, secret }
    let favourites = new Map(); // code -> favourite
    let outbox = [];            // [{ op: 'add' | 'remove', item }]
    let listeners = [];
    let registering = null;
    let retryTimer = null;
    let retryDelay = 0;

    // ── localStorage helpers, all failure tolerant.

    function readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {
            // Private mode or a full quota. The in-memory copy still works.
        }
    }

    function persist() {
        writeJSON(SYNC_FAV_KEY, Array.from(favourites.values()));
        writeJSON(SYNC_OUTBOX_KEY, outbox);
    }

    function emit() {
        listeners.forEach((cb) => {
            try {
                cb();
            } catch (_) {}
        });
    }

    // ── Normalising an LTA record down to what we store.

    function toFavourite(item) {
        return {
            code: String(item.Description ?? item.code ?? '').trim(),
            description: String(item.Description ?? item.description ?? '').trim(),
            rack_type: item.RackType ?? item.rack_type ?? null,
            rack_count: item.RackCount ?? item.rack_count ?? null,
            sheltered:
                item.sheltered !== undefined
                    ? Boolean(item.sheltered)
                    : item.ShelterIndicator === 'Y',
            latitude: item.Latitude ?? item.latitude ?? null,
            longitude: item.Longitude ?? item.longitude ?? null,
        };
    }

    /** Turn a stored favourite back into the shape the cards and map expect. */
    function toResult(fav) {
        return {
            Description: fav.description || fav.code,
            RackType: fav.rack_type || 'Racks',
            RackCount: fav.rack_count ?? 0,
            ShelterIndicator: fav.sheltered ? 'Y' : 'N',
            Latitude: fav.latitude,
            Longitude: fav.longitude,
            _favourite: true,
        };
    }

    // ── Server calls.

    async function api(path, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (device) {
            headers['X-Device-Id'] = device.id;
            headers['X-Device-Secret'] = device.secret;
        }
        const res = await fetch(path, { ...options, headers });
        const text = await res.text();
        const body = text ? JSON.parse(text) : {};
        if (!res.ok) {
            const err = new Error(body.error || `Request failed with ${res.status}`);
            err.status = res.status;
            err.body = body;
            throw err;
        }
        return body;
    }

    /** Register this browser on first need. Concurrent callers share one call. */
    async function ensureDevice() {
        if (device) return device;
        if (registering) return registering;

        registering = (async () => {
            const body = await api('/api/device', { method: 'POST' });
            device = { id: body.device_id, secret: body.device_secret };
            writeJSON(SYNC_DEVICE_KEY, device);
            return device;
        })().finally(() => {
            registering = null;
        });

        return registering;
    }

    // ── Outbox. Queued writes survive a reload and a flat network.

    function queue(op, item) {
        // A later write on the same code supersedes anything queued before it.
        outbox = outbox.filter((entry) => entry.item.code !== item.code);
        outbox.push({ op, item });
        persist();
    }

    /** Returns true when the outbox drained completely. */
    async function flushOutbox() {
        if (!outbox.length) return true;
        await ensureDevice();

        const pending = outbox.slice();
        for (const entry of pending) {
            try {
                if (entry.op === 'add') {
                    await api('/api/favourites', {
                        method: 'POST',
                        body: JSON.stringify(entry.item),
                    });
                } else {
                    await api(
                        `/api/favourites?code=${encodeURIComponent(entry.item.code)}`,
                        { method: 'DELETE' }
                    );
                }
                outbox = outbox.filter((e) => e !== entry);
                persist();
            } catch (err) {
                // Leave this entry and everything after it for the next attempt.
                if (err.status === 401) {
                    // The stored credentials no longer match anything. Drop them
                    // and keep the local favourites, which are the real copy.
                    device = null;
                    try {
                        localStorage.removeItem(SYNC_DEVICE_KEY);
                    } catch (_) {}
                }
                return false;
            }
        }
        return true;
    }

    /** Replace the local list with whatever the server holds. */
    async function pull() {
        if (!device) return null;
        const body = await api('/api/favourites');
        favourites = new Map((body.favourites || []).map((f) => [f.code, f]));
        persist();
        emit();
        return body;
    }

    /**
     * Push everything local up, then take the server's answer as the truth.
     *
     * Anything left undone schedules a retry with a widening gap. Without that
     * a flush attempted while offline would sit there until the next page load,
     * because the outbox has no other trigger while the tab stays open.
     */
    async function reconcile() {
        let complete = false;
        try {
            complete = await flushOutbox();
            if (device) await pull();
        } catch (_) {
            // Offline is a normal state here, not an error worth surfacing.
            complete = false;
        }

        if (complete) {
            retryDelay = 0;
        } else {
            scheduleRetry();
        }
        return complete;
    }

    function scheduleRetry() {
        if (retryTimer) return;
        retryDelay = retryDelay ? Math.min(retryDelay * 2, 300000) : 1000;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            reconcile();
        }, retryDelay);
    }

    // ── Public surface.

    return {
        init() {
            device = readJSON(SYNC_DEVICE_KEY, null);
            const stored = readJSON(SYNC_FAV_KEY, []);
            favourites = new Map(stored.map((f) => [f.code, f]));
            outbox = readJSON(SYNC_OUTBOX_KEY, []);

            emit();
            reconcile();

            // Coming back online is a reason to try again straight away rather
            // than waiting out whatever backoff had built up.
            window.addEventListener('online', () => this.refresh());
            return this;
        },

        onChange(cb) {
            listeners.push(cb);
        },

        isLinked: false,

        has(code) {
            return favourites.has(String(code).trim());
        },

        count() {
            return favourites.size;
        },

        /** Stored favourites in the shape the list and map renderers want. */
        list() {
            return Array.from(favourites.values()).map(toResult);
        },

        /**
         * Save or unsave. The local change lands immediately and the return
         * value is the new state, so callers can repaint without waiting.
         */
        toggle(item) {
            const fav = toFavourite(item);
            if (!fav.code) return false;

            const saving = !favourites.has(fav.code);
            if (saving) {
                favourites.set(fav.code, fav);
            } else {
                favourites.delete(fav.code);
            }
            persist();
            emit();

            queue(saving ? 'add' : 'remove', fav);
            ensureDevice()
                .then(flushOutbox)
                .catch(() => {});

            return saving;
        },

        // ── Linking.

        async status() {
            if (!device) return { linked: false, favourites: favourites.size };
            const body = await api('/api/link');
            this.isLinked = Boolean(body.linked);
            return body;
        },

        /** Mint a token and hand back the deep link for the bot. */
        async startLink() {
            await ensureDevice();
            await flushOutbox();
            return api('/api/link', { method: 'POST' });
        },

        async unlink() {
            await ensureDevice();
            const body = await api('/api/link', { method: 'DELETE' });
            await pull();
            return body;
        },

        /** Poll after sending someone off to Telegram, so the UI catches up. */
        async waitForLink({ attempts = 40, interval = 3000 } = {}) {
            for (let i = 0; i < attempts; i += 1) {
                await new Promise((r) => setTimeout(r, interval));
                try {
                    const body = await this.status();
                    if (body.linked) {
                        await pull();
                        return body;
                    }
                } catch (_) {}
            }
            return null;
        },

        // ── Backup codes.

        async requestBackupCodes() {
            await ensureDevice();
            return api('/api/backup-codes', {
                method: 'POST',
                body: JSON.stringify({ action: 'request' }),
            });
        },

        async pollBackupCodes(requestId) {
            return api(`/api/backup-codes?request_id=${encodeURIComponent(requestId)}`);
        },

        async redeemBackupCode(code) {
            await ensureDevice();
            const body = await api('/api/backup-codes', {
                method: 'POST',
                body: JSON.stringify({ action: 'redeem', code }),
            });
            await pull();
            return body;
        },

        /** An explicit sync. Cancels any pending backoff and starts clean. */
        refresh() {
            clearTimeout(retryTimer);
            retryTimer = null;
            retryDelay = 0;
            return reconcile();
        },
    };
})();

window.Sync = Sync;
