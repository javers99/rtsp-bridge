const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const LOG_FILE = 'bridge_log.txt';
fs.writeFileSync(LOG_FILE, ''); // Clear log

function log(msg) {
    const formatted = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    fs.appendFileSync(LOG_FILE, formatted + '\n');
}

process.on('uncaughtException', (err) => {
    log(`[CRASH] Uncaught Exception: ${err.stack}`);
    process.exit(1);
});
process.on('unhandledRejection', (reason, p) => {
    log(`[CRASH] Unhandled Rejection: ${reason}`);
    process.exit(1);
});

// --- CONFIGURATION ---
const REOLINK_IP = process.env.REOLINK_IP;
const REOLINK_PORT = process.env.REOLINK_PORT || 554;
const REOLINK_USER = process.env.REOLINK_USER || 'admin';
const REOLINK_PASS = process.env.REOLINK_PASS;
const RTSP_PATH = process.env.RTSP_PATH || '/h264Preview_01_sub';
const BASE_URL = `rtsp://${REOLINK_IP}:${REOLINK_PORT}${RTSP_PATH}`;

const BACKCHANNEL_GAIN = parseFloat(process.env.BACKCHANNEL_GAIN || '1.5');

const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8080');

// --- STATE ---
let cseq = 1;
let sessionId = null;
let authRealm = null;
let authNonce = null;
let contentBase = BASE_URL;
let isPlaying = false;
let asteriskSocket = null;
let rtspSocket = null;
let tracks = []; // { type: 'audio'|'backchannel', control: '', setup: false, socket: dgram.Socket, remoteRtpPort: 0, remoteAddress: '' }
let serverRtpPort = parseInt(process.env.RTP_PORT || '50000');
let incomingBuffer = Buffer.alloc(0);
let lastSendTime = Date.now();
let silenceInterval = null;
let keepAliveInterval = null;
let baseTs = 0;
let baseSeq = 0;

// --- RTSP HELPERS ---

function getDigestResponse(method, uri, realm, nonce) {
    const ha1 = crypto.createHash('md5').update(`${REOLINK_USER}:${realm}:${REOLINK_PASS}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
    const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
    return `Digest username="${REOLINK_USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
}

function sendRtsp(method, urlOrPath, headers = {}) {
    if (!rtspSocket || rtspSocket.destroyed) return;
    let msg = `${method} ${urlOrPath} RTSP/1.0\r\n`;
    msg += `CSeq: ${cseq++}\r\n`;
    msg += `User-Agent: Lavf58.29.100\r\n`;
    if (sessionId) msg += `Session: ${sessionId}\r\n`;

    // Add Authorization if we have credentials
    if (authRealm && authNonce && !headers['Authorization']) {
        headers['Authorization'] = getDigestResponse(method, urlOrPath, authRealm, authNonce);
    }

    for (const [k, v] of Object.entries(headers)) {
        msg += `${k}: ${v}\r\n`;
    }
    msg += `\r\n`;
    rtspSocket.write(msg);
    log(`[RTSP] OUT [CSeq:${cseq - 1}]:\n${msg.trim()}`);
}

// --- G.711 TABLES ---
const pcmToAlawTable = new Uint8Array(65536);
const pcmToUlawTable = new Uint8Array(65536);
for (let i = -32768; i < 32768; i++) {
    // Alaw
    let s = (i < 0) ? ~i >> 4 : i >> 4;
    let seg = 0;
    if (s >= 512) { s >>= 1; seg = 1; }
    if (s >= 512) { s >>= 1; seg = 2; }
    if (s >= 512) { s >>= 1; seg = 3; }
    if (s >= 512) { s >>= 1; seg = 4; }
    if (s >= 512) { s >>= 1; seg = 5; }
    if (s >= 512) { s >>= 1; seg = 6; }
    if (s >= 512) { s >>= 1; seg = 7; }
    let val = (seg << 4) | (s & 0x0F);
    if (i >= 0) val |= 0x80;
    pcmToAlawTable[i + 32768] = val ^ 0xD5;

    // Ulaw
    let mag = (i < 0) ? ~i : i;
    mag += 0x84;
    if (mag > 0x7FFF) mag = 0x7FFF;
    let u_seg = 0;
    if (mag >= 0x4000) { mag >>= 1; u_seg = 1; }
    if (mag >= 0x4000) { mag >>= 1; u_seg = 2; }
    if (mag >= 0x4000) { mag >>= 1; u_seg = 3; }
    if (mag >= 0x4000) { mag >>= 1; u_seg = 4; }
    if (mag >= 0x4000) { mag >>= 1; u_seg = 5; }
    if (mag >= 0x4000) { mag >>= 1; u_seg = 6; }
    if (mag >= 0x4000) { mag >>= 1; u_seg = 7; }
    let u_val = (u_seg << 4) | ((mag >> 3) & 0x0F);
    pcmToUlawTable[i + 32768] = (i < 0) ? ~u_val : ~(u_val | 0x80);
}
const alawToPcmTable = new Int16Array(256);
const ulawToPcmTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    // Alaw to PCM
    let val = i ^ 0xD5;
    let t = (val & 0x0F) << 4;
    let seg = (val & 0x70) >> 4;
    if (seg > 0) t += 256;
    if (seg > 1) t <<= (seg - 1);
    alawToPcmTable[i] = (val & 0x80) ? t : -t;

    // Ulaw to PCM
    let u_val = ~i;
    let u_seg = (u_val & 0x70) >> 4;
    let u_t = (u_val & 0x0F) << 3;
    u_t += 0x84;
    if (u_seg > 0) u_t <<= u_seg;
    u_t -= 0x84;
    ulawToPcmTable[i] = (u_val & 0x80) ? u_t : -u_t;
}

function getAdtsHeader(length, sampleRateIdx) {
    const objType = 2; // AAC LC
    const chanCfg = 1; // Mono
    const frameLen = length + 7;
    const header = Buffer.alloc(7);
    header[0] = 0xFF;
    header[1] = 0xF1; // 0xF9 for MPEG2, 0xF1 for MPEG4
    header[2] = ((objType - 1) << 6) | (sampleRateIdx << 2) | (chanCfg >> 2);
    header[3] = ((chanCfg & 3) << 6) | (frameLen >> 11);
    header[4] = (frameLen >> 3) & 0xFF;
    header[5] = ((frameLen & 7) << 5) | 0x1F;
    header[6] = 0xFC;
    return header;
}

// --- MAIN BRIDGING LOGIC ---

function startRtsp() {
    rtspSocket = new net.Socket();
    rtspSocket.on('error', (e) => {
        console.error(`[RTSP] Socket error: ${e.message}`);
        setTimeout(startRtsp, 5000);
    });

    rtspSocket.connect(REOLINK_PORT, REOLINK_IP, () => {
        log(`[RTSP] Connected to ${REOLINK_IP}`);
        sendRtsp('DESCRIBE', BASE_URL, {
            'Accept': 'application/sdp',
            'Require': 'www.onvif.org/ver20/backchannel'
        });
    });

    rtspSocket.on('data', (data) => {
        const resp = data.toString();
        log(`[RTSP] IN:\n${resp.trim()}`);

        const lines = resp.split('\r\n');
        const statusMatch = lines[0].match(/RTSP\/1\.0 (\d+)/);
        if (!statusMatch) return;
        const statusCode = parseInt(statusMatch[1]);

        if (statusCode === 454 || statusCode === 455) {
            log(`[RTSP] Session error ${statusCode}. Resetting...`);
            resetRtspSession();
            return;
        }

        if (statusCode === 401) {
            const wwwAuth = resp.match(/WWW-Authenticate: Digest realm="([^"]+)", nonce="([^"]+)"/);
            if (wwwAuth) {
                authRealm = wwwAuth[1];
                authNonce = wwwAuth[2];
                const lastLine = lines.find(l => l.startsWith('CSeq:'));
                const lastCseq = lastLine ? parseInt(lastLine.split(': ')[1]) : cseq - 1;

                // We need to know which method failed. For now assume DESCRIBE if cseq matches.
                const lastMethod = 'DESCRIBE';
                sendRtsp(lastMethod, BASE_URL, { 'Accept': 'application/sdp', 'Require': 'www.onvif.org/ver20/backchannel' });
            }
            return;
        }

        if (statusCode === 200) {
            // Update Session ID if present
            const sessionMatch = resp.match(/Session: ([^; \r\n]+)/);
            if (sessionMatch) sessionId = sessionMatch[1];

            if (resp.includes('Content-Type: application/sdp')) {
                // Parse Content-Base for proper track URL resolution
                const baseMatch = resp.match(/Content-Base: ([^\r\n]+)/);
                if (baseMatch) {
                    contentBase = baseMatch[1].trim();
                    if (!contentBase.endsWith('/')) contentBase += '/';
                }

                const sdpStart = resp.indexOf('\r\n\r\n') + 4;
                const sdp = resp.substring(sdpStart);
                parseSdp(sdp);
            } else {
                const transportMatch = resp.match(/server_port=(\d+)-(\d+)/);
                if (transportMatch) {
                    const track = tracks.find(t => t.setup && !t.remoteRtpPort);
                    if (track) {
                        track.remoteRtpPort = parseInt(transportMatch[1]);
                        track.remoteAddress = REOLINK_IP;
                        console.log(`[RTSP] Track ${track.type} remote RTP port: ${track.remoteRtpPort}`);
                    }
                }

                const pending = tracks.find(t => !t.setup);
                if (pending) {
                    setupTrack(pending);
                } else if (!isPlaying) {
                    isPlaying = true;
                    // Extract base TS/Seq for backchannel if available
                    const info = resp.match(/url=rtsp:[^;]+track3;seq=(\d+);rtptime=(\d+)/);
                    if (info) {
                        baseSeq = parseInt(info[1]);
                        baseTs = parseInt(info[2]);
                        log(`[RTSP] Backchannel base: seq=${baseSeq} ts=${baseTs}`);
                    }
                    sendRtsp('PLAY', BASE_URL, { 'Require': 'www.onvif.org/ver20/backchannel' });

                    // Start Keep-Alive
                    if (keepAliveInterval) clearInterval(keepAliveInterval);
                    keepAliveInterval = setInterval(() => {
                        if (rtspSocket && !rtspSocket.destroyed && sessionId) {
                            sendRtsp('OPTIONS', BASE_URL);
                        }
                    }, 20000);
                }
            }
        }
    });
}

function stopRtsp() {
    log("[RTSP] Stopping session");
    if (sessionId && isPlaying) {
        try { sendRtsp('TEARDOWN', BASE_URL); } catch (e) { }
    }
    isPlaying = false;
    sessionId = null;
    baseTs = 0;
    baseSeq = 0;
    if (keepAliveInterval) clearInterval(keepAliveInterval);

    for (const track of tracks) {
        if (track.socket) {
            try { track.socket.close(); } catch (e) { }
        }
        if (track.decoder) {
            try { track.decoder.kill(); } catch (e) { }
        }
        if (track.encoder) {
            try { track.encoder.kill(); } catch (e) { }
        }
    }
    tracks = [];
    serverRtpPort = parseInt(process.env.RTP_PORT || '50000');
    if (rtspSocket) {
        rtspSocket.destroy();
        rtspSocket = null;
    }
}

function resetRtspSession() {
    log("[RTSP] Performing session reset");
    stopRtsp();
    startRtsp();
}

function parseSdp(sdp) {
    log(`[SDP] Received:\n${sdp}`);
    const lines = sdp.split(/\r?\n/);
    let current = null;
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('m=audio')) {
            current = { type: 'audio', control: '', setup: false, codec: 'AAC', sampleRateIdx: 8 };
            tracks.push(current);
        } else if (line.startsWith('a=rtpmap:') && current) {
            if (line.includes('PCMU')) current.codec = 'PCMU';
            else if (line.includes('PCMA')) current.codec = 'PCMA';
            else if (line.includes('MPEG4-GENERIC')) {
                current.codec = 'AAC';
                const match = line.match(/\/(\d+)/);
                if (match) {
                    const sr = parseInt(match[1]);
                    const srMap = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11 };
                    if (srMap[sr] !== undefined) current.sampleRateIdx = srMap[sr];
                }
            }
        } else if (line.startsWith('a=control:') && current) {
            const ctrl = line.substring(10);
            if (ctrl === '*') {
                current.control = contentBase;
            } else {
                current.control = ctrl.startsWith('rtsp://') ? ctrl : (contentBase + ctrl);
            }
        } else if (line.startsWith('a=sendonly') && current) {
            // Reolink mark backchannel as sendonly
            current.type = 'backchannel';
        } else if (line.startsWith('a=recvonly') && current) {
            // Reolink mark camera->client as recvonly
            current.type = 'audio';
        }
    }
    log(`[SDP] Parsed tracks: \n${JSON.stringify(tracks.map(t => ({ type: t.type, control: t.control, codec: t.codec })), null, 2)}`);
    if (tracks.length > 0) setupTrack(tracks[0]);
    else log('[SDP] No audio tracks found in SDP!');
}

function setupTrack(track) {
    const rtpPort = serverRtpPort;
    serverRtpPort += 2;
    track.rtpPort = rtpPort;
    track.setup = true;
    track.packetsRead = 0;
    track.decoder = null;
    track.encoder = null;
    track.backPkts = 0;

    const socket = dgram.createSocket('udp4');
    socket.on('error', (e) => log(`[UDP] Socket error on track ${track.type}: ${e.message}`));
    socket.bind(rtpPort);
    track.socket = socket;

    const headers = { 'Transport': `RTP/AVP;unicast;client_port=${rtpPort}-${rtpPort + 1}` };
    if (track.type === 'backchannel') headers['Require'] = 'www.onvif.org/ver20/backchannel';

    sendRtsp('SETUP', track.control, headers);

    socket.on('message', (msg) => {
        if (msg.length <= 12) return;

        const version = (msg[0] & 0xC0) >> 6;
        if (version !== 2) return;

        const x = (msg[0] & 0x10) >> 4;
        const cc = msg[0] & 0x0F;
        let offset = 12 + (cc * 4);

        if (x) {
            if (msg.length < offset + 4) return;
            const extLen = msg.readUInt16BE(offset + 2);
            offset += 4 + (extLen * 4);
        }

        if (msg.length <= offset) return;
        const payload = msg.slice(offset);

        // Verbose logging for first few packets
        if (track.packetsRead < 5) {
            log(`[UDP] ${track.type} packet #${track.packetsRead} length: ${msg.length} hex: ${payload.slice(0, 8).toString('hex')}`);
            track.packetsRead++;
        }

        if (track.type === 'audio' && asteriskSocket && !asteriskSocket.destroyed) {
            if (track.codec === 'AAC') {
                if (!track.decoder) {
                    log(`[Audio] Starting AAC decoder (ffmpeg)`);
                    track.decoder = spawn(FFMPEG_PATH, [
                        '-f', 'aac',
                        '-i', 'pipe:0',
                        '-f', 's16le', '-ac', '1', '-ar', '8000',
                        'pipe:1'
                    ]);
                    track.pcmBuffer = Buffer.alloc(0);
                    track.decoder.stdout.on('data', (pcm) => {
                        if (!asteriskSocket || asteriskSocket.destroyed) return;
                        track.pcmBuffer = Buffer.concat([track.pcmBuffer, pcm]);
                        while (track.pcmBuffer.length >= 320) {
                            const chunk = track.pcmBuffer.slice(0, 320);
                            track.pcmBuffer = track.pcmBuffer.slice(320);
                            const header = Buffer.from([0x10, (chunk.length >> 8) & 0xFF, chunk.length & 0xFF]);
                            asteriskSocket.write(Buffer.concat([header, chunk]));
                            lastSendTime = Date.now();
                        }
                    });
                    track.decoder.on('error', (e) => log(`[Audio] Decoder error: ${e.message}`));
                }
                // Parse AU-Header
                if (payload.length > 2) {
                    const auHeadersLenBits = payload.readUInt16BE(0);
                    const auHeadersLenBytes = Math.ceil(auHeadersLenBits / 8.0);
                    const headerLen = 2 + auHeadersLenBytes;
                    if (payload.length > headerLen) {
                        const aacFrame = payload.slice(headerLen);
                        const adts = getAdtsHeader(aacFrame.length, track.sampleRateIdx);
                        track.decoder.stdin.write(Buffer.concat([adts, aacFrame]));
                    }
                }
            } else {
                const outBuf = Buffer.alloc(payload.length * 2);
                const table = track.codec === 'PCMU' ? ulawToPcmTable : alawToPcmTable;
                for (let i = 0; i < payload.length; i++) {
                    outBuf.writeInt16LE(table[payload[i]], i * 2);
                }
                track.pcmBuffer = track.pcmBuffer || Buffer.alloc(0);
                track.pcmBuffer = Buffer.concat([track.pcmBuffer, outBuf]);
                while (track.pcmBuffer.length >= 320) {
                    const chunk = track.pcmBuffer.slice(0, 320);
                    track.pcmBuffer = track.pcmBuffer.slice(320);
                    if (asteriskSocket && !asteriskSocket.destroyed) {
                        const header = Buffer.from([0x10, (chunk.length >> 8) & 0xFF, chunk.length & 0xFF]);
                        asteriskSocket.write(Buffer.concat([header, chunk]));
                        lastSendTime = Date.now();
                    }
                }
            }
        }
    });
}

// --- ASTERISK SERVER ---

const server = net.createServer((socket) => {
    log(`[Asterisk] Connected: ${socket.remoteAddress}:${socket.remotePort}`);
    asteriskSocket = socket;
    incomingBuffer = Buffer.alloc(0);
    lastSendTime = Date.now();

    // Start RTSP Handshake on Connect
    if (rtspSocket) stopRtsp();
    startRtsp();

    if (silenceInterval) clearInterval(silenceInterval);
    silenceInterval = setInterval(() => {
        if (!asteriskSocket || asteriskSocket.destroyed) return;
        if (Date.now() - lastSendTime > 400) {
            // Send 320 bytes of silence to keep AudioSocket alive
            const header = Buffer.from([0x10, 0x01, 0x40]);
            const silence = Buffer.alloc(320, 0);
            asteriskSocket.write(Buffer.concat([header, silence]));
            lastSendTime = Date.now();
        }
    }, 100);

    socket.on('data', (data) => {
        incomingBuffer = Buffer.concat([incomingBuffer, data]);
        while (incomingBuffer.length >= 3) {
            const type = incomingBuffer[0];
            if (type === 0x00) {
                log("[Asterisk] Hangup received");
                socket.destroy();
                return;
            }
            const len = (incomingBuffer[1] << 8) | incomingBuffer[2];
            if (incomingBuffer.length < 3 + len) break;

            const payload = incomingBuffer.slice(3, 3 + len);
            incomingBuffer = incomingBuffer.slice(3 + len);

            if (type >= 0x10) {
                const back = tracks.find(t => t.type === 'backchannel');
                if (back && back.remoteRtpPort) {
                    if (!back.encoder) {
                        log(`[Backchannel] Starting PCMU encoder (ffmpeg)`);
                        back.encoder = spawn(FFMPEG_PATH, [
                            '-f', 's16le', '-ar', '8000', '-ac', '1',
                            '-i', 'pipe:0',
                            '-f', 'mulaw', '-ar', '8000', '-ac', '1',
                            'pipe:1'
                        ]);
                        back.encoder.stdout.on('data', (pcmu) => {
                            const rtp = Buffer.alloc(12 + pcmu.length);
                            rtp[0] = 0x80;
                            rtp[1] = 0x00; // PCMU
                            rtp.writeUInt16BE(baseSeq++ & 0xFFFF, 2);
                            rtp.writeUInt32BE(baseTs, 4);
                            rtp.writeUInt32BE(0x12345678, 8);
                            pcmu.copy(rtp, 12);

                            if (back.backPkts < 10) {
                                log(`[Backchannel] Sent RTP pkt #${back.backPkts} ts:${baseTs} len:${pcmu.length}`);
                            }
                            back.backPkts++;

                            baseTs += pcmu.length;
                            back.socket.send(rtp, back.remoteRtpPort, back.remoteAddress);
                        });
                        back.encoder.stderr.on('data', (d) => log(`[Backchannel] FFmpeg: ${d.toString().trim()}`));
                        back.encoder.on('error', (e) => log(`[Backchannel] Encoder error: ${e.message}`));
                    }

                    // Apply gain before sending to ffmpeg
                    const boosted = Buffer.alloc(payload.length);
                    for (let i = 0; i < payload.length / 2; i++) {
                        let val = payload.readInt16LE(i * 2);
                        val = Math.max(-32768, Math.min(32767, Math.round(val * BACKCHANNEL_GAIN)));
                        boosted.writeInt16LE(val, i * 2);
                    }
                    back.encoder.stdin.write(boosted);
                }
            }
        }
    });

    socket.on('close', () => {
        log("[Asterisk] Disconnected.");
        asteriskSocket = null;
        if (silenceInterval) clearInterval(silenceInterval);

        stopRtsp(); // Full cleanup on disconnect
    });

    socket.on('error', (e) => {
        log(`[Asterisk] Socket error: ${e.message}`);
    });
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    log(`[Bridge] AudioSocket listening on ${LISTEN_PORT}`);
    // Wait for Asterisk to start RTSP
});
