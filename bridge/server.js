'use strict';



const http      = require('http');
const WebSocket = require('ws');

// Latest orientation snapshot (radians)
let orientation = { azimuth: 0, pitch: 0, roll: 0 };

// HTTP server
const httpServer = http.createServer((req, res) => {

    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    // Health check
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', latest: orientation }));
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const json = JSON.parse(body);
                parseSensorPayload(json);
            } catch (e) {
                console.warn('[bridge] JSON parse error:', e.message);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }

    res.writeHead(405); res.end();
});

/**
 * Parse Sensor Logger JSON payload.
 *
 * Expected format:
 * {
 *   "payload": [
 *     {
 *       "name": "Orientation",
 *       "values": {
 *         "yaw":   number,
 *         "pitch": number,
 *         "roll":  number,
 *         "qw": number, "qx": number, "qy": number, "qz": number
 *       }
 *     }
 *   ]
 * }
 */
function parseSensorPayload(json) {
    if (json.payload && Array.isArray(json.payload)) {
        for (const entry of json.payload) {
            const n = (entry.name || '').toLowerCase();
            if (n === 'orientation' || n === 'attitude') {
                const v = entry.values || {};
                orientation.azimuth = toRad(v.yaw   ?? v.azimuth ?? 0);
                orientation.pitch   = toRad(v.pitch ?? 0);
                orientation.roll    = toRad(v.roll  ?? 0);
                console.log(
                    `[sensor] yaw=${orientation.azimuth.toFixed(3)}` +
                    `  pitch=${orientation.pitch.toFixed(3)}` +
                    `  roll=${orientation.roll.toFixed(3)}`
                );
                return;
            }
        }
        return;
    }

    // Flat format fallback: { yaw, pitch, roll }
    if ('yaw' in json || 'pitch' in json || 'roll' in json) {
        orientation.azimuth = toRad(json.yaw   ?? json.azimuth ?? 0);
        orientation.pitch   = toRad(json.pitch ?? 0);
        orientation.roll    = toRad(json.roll  ?? 0);
    }
}

/** If value looks like degrees (outside ±2π range) convert to radians, else pass through */
function toRad(val) {
    if (Math.abs(val) > Math.PI * 2 + 0.1) return val * Math.PI / 180;
    return val;
}

// WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[bridge] WebSocket connected from ${ip}`);
    ws.send(JSON.stringify(orientation));
    ws.on('close', () => console.log(`[bridge] WebSocket disconnected from ${ip}`));
    ws.on('error', err  => console.warn('[bridge] WS error:', err.message));
});

// Broadcast every 20 ms (50 Hz)
setInterval(() => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(orientation);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}, 20);

// Start
const PORT = process.env.PORT || 8765;
httpServer.listen(PORT, '0.0.0.0', () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const ips  = [];
    for (const list of Object.values(nets))
        for (const i of list)
            if (i.family === 'IPv4' && !i.internal) ips.push(i.address);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║        PA2 — Sensor Bridge  (iOS / iPhone)       ║');
    console.log('╠══════════════════════════════════════════════════╣');
    ips.forEach(ip => {
        console.log(`║  POST URL  →  http://${ip}:${PORT}/data`);
        console.log(`║  WebSocket →  ws://${ip}:${PORT}/`);
    });
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║  Sensor Logger settings:                         ║');
    console.log('║    Module   → Orientation                        ║');
    console.log('║    Push URL → http://<IP above>:8765/data        ║');
    console.log('║    Interval → max available                      ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
});