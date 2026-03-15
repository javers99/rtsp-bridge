const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

// --- CONFIGURATION ---
const MODE = 'WHIP';             // 'WHIP' (WebRTC) or 'HTTP' (Legacy Relay)
const LISTEN_PORT = 8080;        // Asterisk AudioSocket connects here
const HTTP_RELAY_PORT = 9998;    // Used ONLY in HTTP mode
const BRIDGE_HOST = '192.168.16.27';
const GO2RTC_HOST = '192.168.16.1';
const GO2RTC_API_PORT = 1984;
const GO2RTC_RTSP_PORT = 8554;
const STREAM_NAME = 'doorbell_sub';
const FFMPEG_PATH = 'c:\\scripts\\ffmpeg.exe';

const RTSP_URL = `rtsp://${GO2RTC_HOST}:${GO2RTC_RTSP_PORT}/${STREAM_NAME}`;
const PUSH_STREAM_NAME = 'doorbell_voice';
const WHIP_URL = `http://${GO2RTC_HOST}:${GO2RTC_API_PORT}/api/webrtc?dst=${PUSH_STREAM_NAME}`;

// --- GO2RTC API HELPER ---

function go2rtcPost(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: GO2RTC_HOST,
            port: GO2RTC_API_PORT,
            path,
            method: 'POST'
        }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
                else reject(new Error(`Status ${res.statusCode}: ${body}`));
            });
        });
        req.on('error', (e) => reject(e));
        req.end();
    });
}

// --- HTTP RELAY (For HTTP mode fallback) ---
let httpClients = new Set();
if (MODE === 'HTTP') {
    const httpServer = http.createServer((req, res) => {
        console.log(`[HTTP] go2rtc connected from ${req.socket.remoteAddress}`);
        res.writeHead(200, {
            'Content-Type': 'audio/x-alaw-basic',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });
        httpClients.add(res);
        req.on('close', () => httpClients.delete(res));
    });
    httpServer.listen(HTTP_RELAY_PORT, '0.0.0.0', () => {
        console.log(`[HTTP Relay] Listening on port ${HTTP_RELAY_PORT}`);
    });
}

// --- MAIN AUDIOSOCKET SERVER ---

const server = net.createServer((socket) => {
    console.log(`[Asterisk] Connected: ${socket.remoteAddress}:${socket.remotePort}`);

    let procOut = null; // Camera -> Asterisk
    let procIn = null;  // Asterisk -> Camera
    let cleanupDone = false;
    let silenceInterval = null;
    let lastSend = Date.now();
    let hasSentBackchannel = false;

    const cleanup = () => {
        if (cleanupDone) return;
        cleanupDone = true;
        console.log("[Bridge] Cleaning up session...");

        if (silenceInterval) clearInterval(silenceInterval);
        if (procOut) procOut.kill('SIGKILL');
        if (procIn) {
            try { procIn.stdin.end(); } catch (e) { }
            procIn.kill('SIGKILL');
        }

        // Remove the dynamic link on go2rtc
        go2rtcPost(`/api/streams?dst=${STREAM_NAME}&src=`).catch(() => { });
        socket.destroy();
    };

    socket.on('error', (err) => {
        console.error("[Asterisk] Socket error:", err.message);
        cleanup();
    });

    socket.on('close', () => {
        console.log("[Asterisk] Disconnected.");
        cleanup();
    });

    // --- CAMERA -> ASTERISK (Inbound) ---
    procOut = spawn(FFMPEG_PATH, [
        '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-i', RTSP_URL,
        '-vn',
        '-acodec', 'pcm_s16le', '-ar', '8000', '-ac', '1',
        '-f', 's16le',
        'pipe:1'
    ], { windowsHide: true });

    let outBuffer = Buffer.alloc(0);
    procOut.stdout.on('data', (chunk) => {
        if (cleanupDone) return;
        outBuffer = Buffer.concat([outBuffer, chunk]);
        while (outBuffer.length >= 320) {
            socket.write(Buffer.concat([Buffer.from([0x10, 0x01, 0x40]), outBuffer.slice(0, 320)]));
            lastSend = Date.now();
            outBuffer = outBuffer.slice(320);
        }
    });

    // --- ASTERISK -> CAMERA (Outbound) ---
    if (MODE === 'WHIP') {
        console.log(`[Bridge] Starting WHIP push to ${WHIP_URL}...`);
        procIn = spawn(FFMPEG_PATH, [
            '-loglevel', 'error', '-re',
            '-f', 's16le', '-ar', '8000', '-ac', '1',
            '-i', 'pipe:0',
            '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '2', '-application', 'voip',
            '-f', 'whip', WHIP_URL
        ], { windowsHide: true });
    } else {
        console.log(`[Bridge] Using HTTP Relay Mode (PCMA)...`);
        procIn = spawn(FFMPEG_PATH, [
            '-loglevel', 'error',
            '-f', 's16le', '-ar', '8000', '-ac', '1',
            '-i', 'pipe:0',
            '-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1',
            '-f', 'alaw', 'pipe:1'
        ], { windowsHide: true });

        procIn.stdout.on('data', (chunk) => {
            for (const res of httpClients) res.write(chunk);
        });
    }

    // Protection against EPIPE crashes
    if (procIn.stdin) {
        procIn.stdin.on('error', (err) => {
            if (!cleanupDone) console.error(`[Bridge] Outbound pipe error: ${err.message}`);
        });
    }

    // Linker with Retries
    const linkWithRetry = async (attempt = 1) => {
        if (cleanupDone) return;
        try {
            const src = (MODE === 'WHIP') ? PUSH_STREAM_NAME : `http://${BRIDGE_HOST}:${HTTP_RELAY_PORT}/audio.pcma#audio=pcma`;
            console.log(`[Bridge] Linking ${STREAM_NAME} to ${src} (Attempt ${attempt})...`);
            await go2rtcPost(`/api/streams?dst=${STREAM_NAME}&src=${encodeURIComponent(src)}`);
            console.log(`[Bridge] Backchannel linked!`);
        } catch (e) {
            if (attempt < 5) {
                console.log(`[Bridge] Link failed (Waiting...), retrying...`);
                setTimeout(() => linkWithRetry(attempt + 1), 1000);
            } else {
                console.error("[Bridge] Failed to link after 5 attempts:", e.message);
            }
        }
    };
    setTimeout(() => linkWithRetry(), 2000);

    procIn.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('Protocol tcp is not supported')) {
            console.error("[Bridge] CRITICAL: Your FFmpeg doesn't support TCP WebRTC candidates.");
            console.error("[Bridge] FIX: Set 'ice_tcp: false' in go2rtc.yaml ON THE SERVER AT 192.168.16.1.");
            console.error("[Bridge] OR: Switch MODE to 'HTTP' at the top of this script.");
        } else if (!msg.includes('bad cseq')) {
            console.error("[FFmpeg Out] stderr:", msg.trim());
        }
        if (!hasSentBackchannel && (msg.includes('Audio: opus') || msg.includes('Audio: pcm_alaw'))) {
            console.log("[Bridge] Outbound audio stream ready!");
            hasSentBackchannel = true;
        }
    });

    procIn.on('close', (code) => {
        console.log(`[FFmpeg] Outbound process exited with code ${code}`);
        if (!cleanupDone) cleanup();
    });

    socket.on('data', (data) => {
        // Simple AudioSocket framing logic
        let i = 0;
        while (i < data.length) {
            if (data[i] === 0x00) { cleanup(); return; }
            if (i + 2 >= data.length) break;
            const len = (data[i + 1] << 8) | data[i + 2];
            if (i + 3 + len > data.length) break;
            if (data[i] >= 0x10 && procIn && procIn.stdin.writable) {
                try { procIn.stdin.write(data.slice(i + 3, i + 3 + len)); } catch (e) { }
            }
            i += 3 + len;
        }
    });

    silenceInterval = setInterval(() => {
        if (cleanupDone) return;
        if (Date.now() - lastSend >= 500) {
            socket.write(Buffer.from([0x10, 0x01, 0x40, ...new Array(320).fill(0)]));
            lastSend = Date.now();
        }
    }, 100);
});

console.log(`--- Doorbell Bridge (${MODE} Mode) ---`);
server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`Listening for Asterisk on port ${LISTEN_PORT}`);
});
