'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Zoho Data Centers
// ---------------------------------------------------------------------------
const DATA_CENTERS = {
    US: { accounts: 'https://accounts.zoho.com',       api: 'https://www.zohoapis.com' },
    EU: { accounts: 'https://accounts.zoho.eu',        api: 'https://www.zohoapis.eu' },
    IN: { accounts: 'https://accounts.zoho.in',        api: 'https://www.zohoapis.in' },
    AU: { accounts: 'https://accounts.zoho.com.au',    api: 'https://www.zohoapis.com.au' },
    JP: { accounts: 'https://accounts.zoho.jp',        api: 'https://www.zohoapis.jp' },
    CA: { accounts: 'https://accounts.zohocloud.ca',   api: 'https://www.zohoapis.ca' },
};

// ---------------------------------------------------------------------------
// Load Zoho credentials from zoho-config.json (deployed with the function)
// ---------------------------------------------------------------------------
let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'zoho-config.json'), 'utf8'));
} catch (err) {
    console.error('Missing or invalid zoho-config.json:', err.message);
    config = null;
}

// In-memory token cache (refreshed automatically)
let accessToken = null;
let tokenExpiry = 0;

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------
async function refreshAccessToken() {
    if (!config || !config.refreshToken) {
        throw new Error('Zoho credentials not configured. Update zoho-config.json and redeploy.');
    }

    const dc = DATA_CENTERS[config.dataCenter];
    if (!dc) throw new Error(`Unknown data center: ${config.dataCenter}`);

    const response = await fetch(`${dc.accounts}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: config.refreshToken,
        }),
    });

    const data = await response.json();
    if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

    accessToken = data.access_token;
    tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000);
}

async function ensureToken() {
    if (!accessToken || Date.now() > tokenExpiry - 300000) {
        await refreshAccessToken();
    }
}

// ---------------------------------------------------------------------------
// Zoho CRM API helper
// ---------------------------------------------------------------------------
async function zohoApi(apiPath, options = {}) {
    await ensureToken();

    const dc = DATA_CENTERS[config.dataCenter];
    const url = dc.api + apiPath;

    const response = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

    // Retry once on 401
    if (response.status === 401) {
        await refreshAccessToken();
        const retry = await fetch(url, {
            ...options,
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        });
        if (retry.status === 204) return { data: [] };
        return retry.json();
    }

    if (response.status === 204) return { data: [] };
    return response.json();
}

// ---------------------------------------------------------------------------
// Config check middleware
// ---------------------------------------------------------------------------
function requireConfig(req, res, next) {
    if (!config || !config.refreshToken) {
        return res.status(503).json({
            error: 'not_configured',
            message: 'Zoho credentials not configured. Update zoho-config.json and redeploy.',
        });
    }
    next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health / status check
app.get('/status', (req, res) => {
    res.json({
        configured: !!(config && config.refreshToken),
        dataCenter: config ? config.dataCenter : null,
    });
});

// GET /users — list active Zoho CRM users
app.get('/users', requireConfig, async (req, res) => {
    try {
        const data = await zohoApi('/crm/v2/users?type=ActiveUsers&per_page=200');
        res.json(data);
    } catch (err) {
        console.error('GET /users error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /accounts?q=searchterm — search accounts via COQL
app.get('/accounts', requireConfig, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });

    try {
        const safeQ = q.replace(/'/g, "\\'");
        const data = await zohoApi('/crm/v2/coql', {
            method: 'POST',
            body: JSON.stringify({
                select_query: `SELECT Account_Name, id FROM Accounts WHERE Account_Name like '%${safeQ}%' ORDER BY Account_Name ASC LIMIT 200`,
            }),
        });
        res.json(data);
    } catch (err) {
        console.error('COQL search failed, trying fallback:', err.message);
        try {
            const data = await zohoApi(
                `/crm/v2/Accounts/search?word=${encodeURIComponent(q)}&per_page=200&fields=Account_Name,id`
            );
            res.json(data);
        } catch (err2) {
            console.error('Fallback search failed:', err2);
            res.status(500).json({ error: err2.message });
        }
    }
});

// POST /checkin — create a check-in note on an account
app.post('/checkin', requireConfig, async (req, res) => {
    const { accountId, userName, noteContent } = req.body;

    if (!accountId || !userName || !noteContent) {
        return res.status(400).json({ error: 'accountId, userName, and noteContent are required.' });
    }

    const noteTitle = `Executive leader Check-in by ${userName}`;

    try {
        const data = await zohoApi('/crm/v2/Notes', {
            method: 'POST',
            body: JSON.stringify({
                data: [{
                    Note_Title: noteTitle,
                    Note_Content: noteContent,
                    '$se_module': 'Accounts',
                    Parent_Id: accountId,
                }],
            }),
        });
        res.json(data);
    } catch (err) {
        console.error('POST /checkin error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;
