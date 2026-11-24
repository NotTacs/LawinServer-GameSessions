

const dgram = require("dgram");
const crypto = require("crypto");

const vivox = require("./vivox.js");
const REALM = vivox.REALM || "viv.local";
const PORT = vivox.SIP_PORT || 5060;
const MEDIA_IP = vivox.SIP_HOST || "127.0.0.1";

function lookup3(key) {
    const d = Buffer.from(String(key), "latin1");
    let len = d.length, i = 0;
    const rot = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const u32 = (o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
    let a, b, c; a = b = c = (0xdeadbeef + len) >>> 0;
    while (len > 12) {
        a = (a + u32(i)) >>> 0; b = (b + u32(i + 4)) >>> 0; c = (c + u32(i + 8)) >>> 0;
        a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
        b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
        c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
        a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
        b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
        c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
        i += 12; len -= 12;
    }
    const g = (o) => (o < d.length ? d[o] : 0);
    switch (len) {
        case 12: c = (c + (g(i + 11) << 24)) >>> 0;
        case 11: c = (c + (g(i + 10) << 16)) >>> 0;
        case 10: c = (c + (g(i + 9) << 8)) >>> 0;
        case 9: c = (c + g(i + 8)) >>> 0;
        case 8: b = (b + (g(i + 7) << 24)) >>> 0;
        case 7: b = (b + (g(i + 6) << 16)) >>> 0;
        case 6: b = (b + (g(i + 5) << 8)) >>> 0;
        case 5: b = (b + g(i + 4)) >>> 0;
        case 4: a = (a + (g(i + 3) << 24)) >>> 0;
        case 3: a = (a + (g(i + 2) << 16)) >>> 0;
        case 2: a = (a + (g(i + 1) << 8)) >>> 0;
        case 1: a = (a + g(i)) >>> 0; break;
        case 0: return c >>> 0;
    }
    c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
    return c >>> 0;
}

const RTP_BASE_PORT = 16000;
const RTP_MAX_PORT = 17000;
let nextRtpPort = RTP_BASE_PORT;

const channels = new Map();

const dialogs = new Map();

let sipSock = null;

function parseSip(text) {
    const parts = text.split("\r\n\r\n");
    const head = parts[0];
    const body = parts.slice(1).join("\r\n\r\n");
    const lines = head.split("\r\n");
    const startLine = lines.shift() || "";
    const headers = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (!(key in headers)) headers[key] = value;
    }
    const m = startLine.match(/^([A-Za-z]+)\s+(\S+)\s+SIP\/2\.0$/);
    return { method: m ? m[1].toUpperCase() : null, uri: m ? m[2] : null, headers, body };
}

function buildResponse(req, statusLine, rinfo, extraHeaders = [], toTag = null, body = null) {
    const h = req.headers;
    const lines = [`SIP/2.0 ${statusLine}`];
    if (h["via"] !== undefined) {
        let via = h["via"];
        if (!/;received=/i.test(via)) via += `;received=${rinfo.address}`;
        if (!/;rport=/i.test(via)) via += `;rport=${rinfo.port}`;
        lines.push(`Via: ${via}`);
    }
    if (h["from"] !== undefined) lines.push(`From: ${h["from"]}`);
    if (h["to"] !== undefined) {
        let to = h["to"];
        if (!/;tag=/i.test(to)) to += `;tag=${toTag || crypto.randomBytes(6).toString("hex")}`;
        lines.push(`To: ${to}`);
    }
    if (h["call-id"] !== undefined) lines.push(`Call-ID: ${h["call-id"]}`);
    if (h["cseq"] !== undefined) lines.push(`CSeq: ${h["cseq"]}`);
    for (const extra of extraHeaders) lines.push(extra);
    if (body !== null) {
        lines.push("Content-Type: application/sdp");
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
        lines.push("");
        lines.push(body);
    } else {
        lines.push("Content-Length: 0");
        lines.push("");
        lines.push("");
    }
    return lines.join("\r\n");
}

function send(msg, rinfo) {
    sipSock.send(msg, rinfo.port, rinfo.address);
}

function parseSdpOffer(sdp) {
    const out = { ip: null, port: null, payloads: [], rtpmap: {}, fmtp: {}, telephoneEvent: null, vxAttrs: [] };
    for (const raw of sdp.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("c=IN IP4 ")) out.ip = line.slice("c=IN IP4 ".length).trim();
        else if (line.startsWith("m=audio ")) {
            const parts = line.split(/\s+/);
            out.port = parseInt(parts[1], 10);
            out.payloads = parts.slice(3).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
        } else {
            const rm = line.match(/^a=rtpmap:(\d+)\s+(\S+)/i);
            if (rm) {
                const pt = parseInt(rm[1], 10);
                out.rtpmap[pt] = rm[2];
                if (/^telephone-event\//i.test(rm[2])) out.telephoneEvent = pt;
            }
            const fm = line.match(/^a=fmtp:(\d+)\s+(.+)$/i);
            if (fm) out.fmtp[parseInt(fm[1], 10)] = fm[2];

            if (/^a=vx_/i.test(line)) out.vxAttrs.push(line);
        }
    }
    return out;
}

const CODEC_PREFERENCE = ["VIVOXVANI", "VANI", "SIREN14", "SIREN", "G7221", "G722", "OPUS", "PCMU", "PCMA"];

function chooseCodec(offer) {
    for (const want of CODEC_PREFERENCE) {
        for (const pt of offer.payloads) {
            const map = offer.rtpmap[pt];
            if (!map) continue;
            const name = map.split("/")[0].toUpperCase();
            if (name.startsWith(want) || name === want) return { pt, rtpmap: map, name };
        }
    }

    if (offer.payloads.includes(0)) return { pt: 0, rtpmap: "PCMU/8000", name: "PCMU" };
    if (offer.payloads.includes(8)) return { pt: 8, rtpmap: "PCMA/8000", name: "PCMA" };
    return null;
}

function buildSdpAnswer(localRtpPort, codec, offer) {
    const pts = [codec.pt];
    if (offer.telephoneEvent != null) pts.push(offer.telephoneEvent);
    const lines = [
        "v=0",
        `o=- 0 0 IN IP4 ${MEDIA_IP}`,
        "s=LawinServer",
        `c=IN IP4 ${MEDIA_IP}`,
        "t=0 0",
        `m=audio ${localRtpPort} RTP/AVP ${pts.join(" ")}`,
        `a=rtpmap:${codec.pt} ${codec.rtpmap}`,
    ];
    if (offer.fmtp[codec.pt]) lines.push(`a=fmtp:${codec.pt} ${offer.fmtp[codec.pt]}`);
    if (offer.telephoneEvent != null) {
        const tmap = offer.rtpmap[offer.telephoneEvent] || "telephone-event/8000";
        lines.push(`a=rtpmap:${offer.telephoneEvent} ${tmap}`);
        lines.push(`a=fmtp:${offer.telephoneEvent} ${offer.fmtp[offer.telephoneEvent] || "0-16"}`);
    }

    for (const a of (offer.vxAttrs || [])) lines.push(a);
    lines.push("a=setup:active");
    lines.push("a=sendrecv");
    lines.push("");
    return lines.join("\r\n");
}

function allocatePortPair() {
    if (nextRtpPort > RTP_MAX_PORT) nextRtpPort = RTP_BASE_PORT;
    const port = nextRtpPort;
    nextRtpPort += 2;
    return port;
}

function channelKey(uri) {

    const m = (uri || "").match(/sip:([^@;>]+)/i);
    return m ? m[1] : uri;
}

function makeRelaySocket(participant, kind ) {
    const sock = dgram.createSocket("udp4");
    sock.on("error", () => {});
    sock.on("message", (buf, rinfo) => {

        participant[kind + "Remote"] = { address: rinfo.address, port: rinfo.port };

        participant[kind + "Count"] = (participant[kind + "Count"] || 0) + 1;
        if (participant[kind + "Count"] === 1)
            console.log(`\x1b[36m[RTP]\x1b[0m first ${kind} from ${participant.key} (${rinfo.address}:${rinfo.port}) on :${participant.localRtpPort}`);

        if (kind === "rtp") {

            if (buf.length >= 20 && !participant.userHash) {
                participant.userHash = Buffer.from(buf.subarray(16, 20));

                participant.userHashVal = buf.readUInt32BE(16);
                participant.ssrc = buf.readUInt32BE(8);
                participant.sipUri = `sip:${participant.key}@${REALM}`;
                console.log(`\x1b[35m[ROSTER]\x1b[0m learned userHash for ${participant.key}: ${participant.userHash.toString("hex")} (val ${participant.userHashVal.toString(16)}) ssrc=${participant.ssrc.toString(16)} uri=${participant.sipUri}`);
            }

            const big = buf.length > 60;
            if (big) participant.rtpBig = (participant.rtpBig || 0) + 1;
            if (participant.rtpCount <= 2 || (big && participant.rtpBig <= 4)) {
                const hex = buf.toString("hex");
                const ascii = buf.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
                console.log(`\x1b[36m[MTIDEBUG]\x1b[0m ${participant.key} #${participant.rtpCount} len=${buf.length} ${hex.slice(0, 500)}`);
                if (/\.[a-f0-9]{16}\.|sip:|diddy|cumware|confctl/i.test(ascii))
                    console.log(`\x1b[36m[MTIDEBUG]\x1b[0m   ascii: ${ascii.slice(12, 120)}`);
            }
        }

        let outBuf = buf;
        if (kind === "rtp" && buf.length > 14 && buf[12] === 0x60
            && participant.userHashVal != null && participant.sessionHash != null) {
            const item = buildRosterItem(participant.userHashVal, participant.sessionHash, participant.sipUri);
            outBuf = Buffer.concat([buf, item]);
            if (!participant._rosterLogged) {
                participant._rosterLogged = true;
                console.log(`\x1b[35m[ROSTER]\x1b[0m appending identity for ${participant.key} (idA/session ${participant.sessionHash.toString(16)}, idB/user ${participant.userHashVal.toString(16)}, uri ${participant.sipUri}, +${item.length}B)`);
            }
        }
        const chan = channels.get(participant.channelId);
        if (!chan) return;
        for (const peer of chan.values()) {
            if (peer === participant) continue;
            const dest = peer[kind + "Remote"];
            const outSock = peer[kind + "Sock"];
            if (dest && outSock) {
                try {
                    outSock.send(outBuf, dest.port, dest.address);
                    if (participant[kind + "Count"] === 1)
                        console.log(`\x1b[32m[RTP]\x1b[0m relaying ${participant.key} -> ${peer.key} (${dest.address}:${dest.port})`);
                } catch (e) {}
            }
        }

    });
    return sock;
}

function createParticipant(channelId, pkey, callId, offer) {
    const localRtpPort = allocatePortPair();
    const participant = {
        key: pkey,
        channelId,
        callId,
        localRtpPort,
        rtpSock: null,
        rtcpSock: null,

        rtpRemote: offer.ip && offer.port ? { address: offer.ip, port: offer.port } : null,
        rtcpRemote: offer.ip && offer.port ? { address: offer.ip, port: offer.port + 1 } : null,
    };
    participant.rtpSock = makeRelaySocket(participant, "rtp");
    participant.rtcpSock = makeRelaySocket(participant, "rtcp");
    participant.rtpSock.bind(localRtpPort, "0.0.0.0");
    participant.rtcpSock.bind(localRtpPort + 1, "0.0.0.0");

    let chan = channels.get(channelId);
    if (!chan) { chan = new Map(); channels.set(channelId, chan); }
    chan.set(pkey, participant);
    dialogs.set(callId, participant);
    return participant;
}

function destroyParticipant(participant) {
    if (!participant) return;
    try { participant.rtpSock && participant.rtpSock.close(); } catch (e) {}
    try { participant.rtcpSock && participant.rtcpSock.close(); } catch (e) {}
    const chan = channels.get(participant.channelId);
    if (chan) {
        chan.delete(participant.key);
        if (chan.size === 0) channels.delete(participant.channelId);
    }
    dialogs.delete(participant.callId);
}

const ROSTER_FLAGS = 0x00000001 | 0x00020000 | 0x00040000;
function buildRosterItem(userHashVal, sessionHash, uri) {
    const u = Buffer.from(String(uri || "").slice(0, 48), "latin1");

    const region = Buffer.concat([
        u, Buffer.from([0x00]),
        Buffer.from([0x00]),
        Buffer.from([u.length]), u,
    ]);

    const entry = Buffer.alloc(16 + region.length);
    entry.writeUInt32BE(region.length, 0);
    entry.writeUInt32BE(ROSTER_FLAGS, 4);
    entry.writeUInt32BE(sessionHash >>> 0, 8);
    entry.writeUInt32BE(userHashVal >>> 0, 12);
    region.copy(entry, 16);

    const block = Buffer.alloc(16);
    block.writeUInt32BE(0x40, 12);

    const v15 = 2 + block.length + entry.length;
    const b0 = (v15 >> 2) & 0xff;
    const b1 = (((v15 & 3) << 6) | 0x01) & 0xff;
    return Buffer.concat([Buffer.from([b0, b1]), block, entry]);
}

function handleInvite(req, rinfo) {
    const callId = req.headers["call-id"];
    const channelId = channelKey(req.uri);
    const fromUser = ((req.headers["from"] || "").match(/sip:([^@;>]+)/i) || [])[1] || "unknown";
    const pkey = fromUser;

    const offer = parseSdpOffer(req.body || "");
    const offered = offer.payloads.map((pt) => `${pt}:${(offer.rtpmap[pt] || "?").split("/")[0]}`).join(" ");
    console.log(`\x1b[36m[SIP]\x1b[0m   offered codecs: ${offered}`);

    console.log(`\x1b[36m[PCDEBUG]\x1b[0m INVITE headers: ${JSON.stringify(req.headers)}`);
    const codec = chooseCodec(offer);
    if (!codec || !offer.port) {
        console.log(`\x1b[33m[SIP]\x1b[0m INVITE ${channelId} from ${fromUser}: no relayable codec -> 488`);
        send(buildResponse(req, "488 Not Acceptable Here", rinfo), rinfo);
        return;
    }

    let participant = dialogs.get(callId);
    if (!participant) participant = createParticipant(channelId, pkey, callId, offer);
    else if (offer.ip && offer.port) {
        participant.rtpRemote = { address: offer.ip, port: offer.port };
        participant.rtcpRemote = { address: offer.ip, port: offer.port + 1 };
    }

    const toUri = ((req.headers["to"] || "").match(/sip:[^>;\s]+/i) || [])[0];
    if (toUri && participant.sessionHash == null) {
        participant.sessionHash = lookup3(toUri);
        console.log(`\x1b[35m[ROSTER]\x1b[0m session ${toUri} -> hash ${participant.sessionHash.toString(16)}`);
    }

    const sdp = buildSdpAnswer(participant.localRtpPort, codec, offer);
    const contact = `Contact: <sip:${MEDIA_IP}:${PORT}>`;

    send(buildResponse(req, "100 Trying", rinfo), rinfo);
    send(buildResponse(req, "200 OK", rinfo, [contact], participant.key, sdp), rinfo);

    const peers = (channels.get(channelId) || new Map()).size;
    console.log(`\x1b[32m[SIP]\x1b[0m INVITE ${channelId} from ${fromUser} -> 200 OK (${codec.name}, relay :${participant.localRtpPort}, ${peers} in channel)`);
}

function handleBye(req, rinfo) {
    const callId = req.headers["call-id"];
    const participant = dialogs.get(callId);
    if (participant) {
        console.log(`\x1b[35m[SIP]\x1b[0m BYE ${participant.channelId} from ${participant.key} -> 200 OK (left)`);
        destroyParticipant(participant);
    }
    send(buildResponse(req, "200 OK", rinfo), rinfo);
}

function start() {
    const sock = dgram.createSocket("udp4");
    sipSock = sock;

    sock.on("error", (err) => {
        if (err && err.code === "EADDRINUSE")
            console.log(`\x1b[31m[SIP]\x1b[0m port ${PORT} is already in use — SIP server not started.`);
        else
            console.log(`\x1b[31m[SIP]\x1b[0m socket error: ${err && err.message}`);
    });

    sock.on("message", (buf, rinfo) => {
        const req = parseSip(buf.toString("utf8"));
        if (!req.method) return;
        const from = rinfo.address + ":" + rinfo.port;

        switch (req.method) {
            case "REGISTER":
                if (!req.headers["authorization"]) {
                    const nonce = crypto.randomBytes(16).toString("hex");
                    console.log(`\x1b[35m[SIP]\x1b[0m REGISTER from ${from} -> 401 challenge`);
                    send(buildResponse(req, "401 Unauthorized", rinfo,
                        [`WWW-Authenticate: Digest realm="${REALM}", nonce="${nonce}", algorithm=MD5`]), rinfo);
                } else {
                    const contact = req.headers["contact"]
                        ? `Contact: ${req.headers["contact"]};expires=3600`
                        : `Contact: <sip:${rinfo.address}:${rinfo.port}>;expires=3600`;
                    console.log(`\x1b[32m[SIP]\x1b[0m REGISTER from ${from} -> 200 OK (registered)`);
                    send(buildResponse(req, "200 OK", rinfo, [contact]), rinfo);
                }
                break;

            case "INVITE":
                handleInvite(req, rinfo);
                break;

            case "BYE":
                handleBye(req, rinfo);
                break;

            case "ACK":
                break;

            case "MESSAGE":
            case "NOTIFY":
            case "INFO":
            case "SUBSCRIBE": {

                const ct = req.headers["content-type"] || "(none)";
                const to = req.headers["to"] || "";
                const hasEvent = /<Event/i.test(req.body || "");
                console.log(`\x1b[36m[PCDEBUG]\x1b[0m ${req.method} to=${to} content-type=${ct} event=${hasEvent} len=${(req.body || "").length}`);
                if (hasEvent) console.log(`\x1b[36m[PCDEBUG]\x1b[0m   body: ${(req.body || "").replace(/\r?\n/g, " ").slice(0, 400)}`);
                send(buildResponse(req, "200 OK", rinfo), rinfo);
                break;
            }

            case "OPTIONS":
            case "CANCEL":
            default:
                send(buildResponse(req, "200 OK", rinfo), rinfo);
                break;
        }
    });

    sock.bind(PORT, "0.0.0.0", () => {
        console.log(`SIP + media relay listening on UDP port ${PORT} (RTP ${RTP_BASE_PORT}-${RTP_MAX_PORT}, media IP ${MEDIA_IP})`);
    });

    return sock;
}

module.exports = { start };
