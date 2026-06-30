// Minimal fetch-based Supabase REST (PostgREST) client.
// Avoids adding @supabase/supabase-js as a dependency — only supports
// the query shapes used by uwu-request-signing-server.js.

export function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    const baseHeaders = {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
    };

    function from(table) {
        const restUrl = `${url}/rest/v1/${table}`;

        return {
            select(cols) {
                const filters = [];
                const builder = {
                    eq(col, val) {
                        filters.push(`${col}=eq.${encodeURIComponent(val)}`);
                        return builder;
                    },
                    async single() {
                        const res = await fetch(`${restUrl}?select=${cols}&${filters.join('&')}`, {
                            headers: { ...baseHeaders, Accept: 'application/vnd.pgrst.object+json' },
                        });
                        if (!res.ok) return { data: null, error: await res.text() };
                        return { data: await res.json(), error: null };
                    },
                    async maybeSingle() {
                        const res = await fetch(`${restUrl}?select=${cols}&${filters.join('&')}`, {
                            headers: baseHeaders,
                        });
                        if (!res.ok) return { data: null, error: await res.text() };
                        const rows = await res.json();
                        return { data: rows[0] || null, error: null };
                    },
                };
                return builder;
            },
            async insert(row) {
                const res = await fetch(restUrl, {
                    method: 'POST',
                    headers: { ...baseHeaders, Prefer: 'return=minimal' },
                    body: JSON.stringify(row),
                });
                if (!res.ok) return { data: null, error: await res.text() };
                return { data: null, error: null };
            },
        };
    }

    return { from };
}
