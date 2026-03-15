const net = require('net');
const http = require('http');
const { spawn, execSync } = require('child_process');

// --- PRE-FLIGHT CLEANUP ---
try {
    execSync('Stop-Process -Name go2rtc, ffmpeg -Force -ErrorAction SilentlyContinue', { shell: 'powershell.exe' });
} catch (e) { }

const PORT = 8080;
const AUDIO_RELAY_PORT = 9998;       // Local TCP port for Asterisk audio passthrough to ffmpeg
const GO2RTC_API = 'localhost';
const GO2RTC_PORT = 1984;
const RTSP_URL = "rtsp://admin:X1GG0lfT6U86mA3XThzG@192.168.16.220:554/h264Preview_01_sub";

// --- WRITE go2rtc CONFIG ---
const fs = require('fs');
const go2rtcConfigPath = "c:\\scripts\\go2rtc.yaml";
const go2rtcConfig = `streams:\n  doorbell:\n    - ${RTSP_URL}#backchannel=1\n`;
fs.writeFileSync(go2rtcConfigPath, go2rtcConfig, 'utf8');

// --- go2rtc API helpers ---
function go2rtcPost(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: GO2RTC_API, port: GO2RTC_PORT, path, method: 'POST' }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                console.log(`go2rtc API [${res.statusCode}] ${path}: ${body.trim()}`);
                resolve(res.statusCode);
            });
        });
        req.on('error', (e) => {
            console.error(`go2rtc API error: ${e.message}`);
            reject(e);
        });
        req.end();
    });
}

function startBackchannel() {
    // Tell go2rtc to run ffmpeg (full path) reading from our TCP relay, output PCMA to camera backchannel.
    // We use exec: source (not ffmpeg:) so we can specify the full path to ffmpeg.exe.
    // go2rtc #audio=pcma/8000 labels the output track so it is routed to the Reolink RTSP backchannel.
    const ffmpegCmd = [
        'c:\\scripts\\ffmpeg.exe',
        '-loglevel error',
        '-f s16le -ar 8000 -ac 1',
        `-i tcp://127.0.0.1:${AUDIO_RELAY_PORT}`,
        '-acodec pcm_alaw -ar 8000 -ac 1',
        '-f alaw',
        'pipe:1',
    ].join(' ');
    const src = encodeURIComponent(`exec:${ffmpegCmd}#audio=pcma/8000`);
    console.log(`Starting backchannel: exec:${ffmpegCmd}#audio=pcma/8000`);
    return go2rtcPost(`/api/streams?dst=doorbell&src=${src}`);
}

function stopBackchannel() {
    return go2rtcPost(`/api/streams?dst=doorbell&src=`);
}

// --- AUDIO RELAY SERVER ---
// go2rtc's ffmpeg source will connect here; we pipe Asterisk audio into connected socket(s)
let relayClients = new Set();

const relayServer = net.createServer((relaySocket) => {
    console.log('go2rtc ffmpeg connected to audio relay');
    relayClients.add(relaySocket);
    relaySocket.on('close', () => {
        console.log('go2rtc ffmpeg disconnected from audio relay');
        relayClients.delete(relaySocket);
    });
    relaySocket.on('error', (err) => {
        console.error('Relay socket error:', err.message);
        relayClients.delete(relaySocket);
    });
});

relayServer.listen(AUDIO_RELAY_PORT, '127.0.0.1', () => {
    console.log(`Audio relay server listening on port ${AUDIO_RELAY_PORT}`);
});

// --- MAIN ASTERISK AudioSocket SERVER ---
const server = net.createServer((socket) => {
    console.log(`Asterisk connected: ${socket.remoteAddress}:${socket.remotePort}`);
    let cleanupDone = false;
    let procGo2Rtc, procOut;
    let silenceInterval = null;

    const cleanup = () => {
        if (cleanupDone) return;
        cleanupDone = true;
        console.log("Cleaning up processes...");
        if (silenceInterval) clearInterval(silenceInterval);
        if (procOut) procOut.kill('SIGKILL');
        if (procGo2Rtc) procGo2Rtc.kill('SIGKILL');

        // Stop the backchannel in go2rtc
        stopBackchannel().catch(() => { });

        try {
            execSync('Stop-Process -Name go2rtc, ffmpeg -Force -ErrorAction SilentlyContinue', { shell: 'powershell.exe' });
        } catch (e) { }
    };

    socket.on('error', (err) => {
        console.error("Socket error:", err.message);
        socket.destroy();
    });

    socket.on('close', () => {
        console.log("Asterisk disconnected.");
        cleanup();
    });

    // --- ASTERISK -> CAMERA: parse AudioSocket frames, write to relay clients ---
    let incomingBuffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        incomingBuffer = Buffer.concat([incomingBuffer, data]);

        while (incomingBuffer.length >= 3) {
            const headerType = incomingBuffer[0];
            if (headerType === 0x00) { // Hangup
                console.log("Asterisk hung up (0x00)");
                socket.destroy();
                return;
            }

            const payloadLen = (incomingBuffer[1] << 8) | incomingBuffer[2];
            const totalLen = 3 + payloadLen;

            if (incomingBuffer.length >= totalLen) {
                const payload = incomingBuffer.slice(3, totalLen);
                incomingBuffer = incomingBuffer.slice(totalLen);

                // Audio frame: forward raw s16le PCM to all connected relay clients (go2rtc ffmpeg)
                if (headerType >= 0x10 && relayClients.size > 0) {
                    for (const client of relayClients) {
                        if (!client.destroyed) client.write(payload);
                    }
                }
            } else {
                break;
            }
        }
    });

    // --- LAUNCH GO2RTC ---
    procGo2Rtc = spawn("c:\\scripts\\go2rtc\\go2rtc.exe", ["-config", go2rtcConfigPath], { windowsHide: true });

    procGo2Rtc.on('error', (err) => console.error(`go2rtc error: ${err.message}`));
    procGo2Rtc.stdout?.on('data', (d) => console.log(`go2rtc: ${d}`));
    procGo2Rtc.stderr?.on('data', (d) => console.error(`go2rtc err: ${d}`));

    // Give go2rtc time to start and connect to camera
    setTimeout(() => {
        if (cleanupDone || socket.destroyed) return;

        // --- CAMERA -> ASTERISK: ffmpeg pulls stream from go2rtc RTSP ---
        procOut = spawn("c:\\scripts\\ffmpeg.exe", [
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-i", "rtsp://localhost:8554/doorbell",
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "8000",
            "-ac", "1",
            "-f", "s16le",
            "pipe:1"
        ], { windowsHide: true });

        procOut.on('error', (err) => console.error(`ffmpeg out error: ${err.message}`));
        procOut.stderr?.on('data', (d) => console.error(`ffmpeg out stderr: ${d}`));

        // --- CAMERA -> ASTERISK THREAD ---
        let lastSend = Date.now();
        let outBuffer = Buffer.alloc(0);

        procOut.stdout.on('data', (chunk) => {
            if (socket.destroyed || !socket.writable) return;
            outBuffer = Buffer.concat([outBuffer, chunk]);

            while (outBuffer.length >= 320) {
                const header = Buffer.from([0x10, 0x01, 0x40]); // Frame type + 320 bytes len
                const payload = outBuffer.slice(0, 320);
                socket.write(Buffer.concat([header, payload]));
                lastSend = Date.now();
                outBuffer = outBuffer.slice(320);
            }
        });

        // Silence keepalive (prevents Asterisk AudioSocket timeout)
        silenceInterval = setInterval(() => {
            if (socket.destroyed || !socket.writable) {
                clearInterval(silenceInterval);
                return;
            }
            if (Date.now() - lastSend >= 500) {
                const header = Buffer.from([0x10, 0x01, 0x40]);
                const silence = Buffer.alloc(320, 0);
                socket.write(Buffer.concat([header, silence]));
                lastSend = Date.now();
            }
        }, 100);

        // --- ASTERISK -> CAMERA: call go2rtc API to start backchannel ---
        // Give ffmpeg a moment to open the RTSP stream first, which activates the doorbell backchannel
        setTimeout(() => {
            if (cleanupDone || socket.destroyed) return;
            console.log("Starting go2rtc backchannel...");
            startBackchannel()
                .then(() => console.log("Backchannel started — doorbell should now hear Asterisk audio"))
                .catch((e) => console.error("Failed to start backchannel:", e.message));
        }, 1500);

    }, 3000); // 3s for go2rtc to connect to camera
});

server.listen(PORT, () => {
    console.log(`--- Node.js AudioSocket Relay Active on ${PORT} ---`);
    console.log(`--- Audio relay listening on ${AUDIO_RELAY_PORT} ---`);
});
