export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const {
        lat,
        long,
        dist
    } = req.query;

    if (!lat || !long) {
        return res.status(400).json({
            error: 'lat and long are required'
        });
    }

    const apiKey = process.env.LTA_ACCOUNT_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: 'LTA API key not configured'
        });
    }

    const params = new URLSearchParams({
        Lat: lat,
        Long: long
    });
    if (dist) params.append('Dist', dist);

    try {
        const response = await fetch(
            `https://datamall2.mytransport.sg/ltaodataservice/BicycleParkingv2?${params}`, {
                headers: {
                    AccountKey: apiKey,
                    accept: 'application/json',
                },
            }
        );

        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({
                error: `LTA API error: ${text}`
            });
        }

        const data = await response.json();

        // Cache for 6 hours — data is updated monthly
        res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({
            error: err.message
        });
    }
}