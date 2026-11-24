const Express = require("express");
const express = Express.Router();
const crypto = require("crypto");
const xmlbuilder = require("xmlbuilder");

function xmlSafe(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

const sessions = new Map();
const channels = new Map();

const REALM = "viv.local";

const SIP_HOST = "26.108.63.150";
const SIP_PORT = 5060;
const SIP_PROXY = `${SIP_HOST}:${SIP_PORT}`;
const STUN_SERVER = "127.0.0.1:3478";

const VIVOX_ISSUER = "lawinserver";
const VIVOX_SIGNING_KEY = "lawinserver-secret";

function b64url(buf) {
    return Buffer.from(buf).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let vivoxSerial = Math.floor(Date.now() / 1000);

function makeVivoxToken({ action, from, to }) {
    const payload = {
        iss: VIVOX_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 90,
        vxa: action,
        vxi: vivoxSerial++,
        f: from,
    };
    if (to) payload.t = to;

    const payloadB64 = b64url(JSON.stringify(payload));
    const sig = b64url(
        crypto.createHmac("sha256", VIVOX_SIGNING_KEY).update(payloadB64).digest()
    );
    return `e30.${payloadB64}.${sig}`;
}

function xmlResponse(rootObj) {
    const root = xmlbuilder.create("response", { encoding: "utf-8" });

    function addNodes(parent, obj) {
        for (const [key, val] of Object.entries(obj)) {
            if (val && typeof val === "object" && !Array.isArray(val)) {
                const child = parent.ele(key);
                addNodes(child, val);
            } else {
                parent.ele(key, {}, String(val));
            }
        }
    }

    addNodes(root, rootObj);
    return root.end({ pretty: true });
}

function sendXml(res, obj) {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(xmlResponse(obj));
}

function voiceLogin(req, res) {
    const accountId = req.params.accountId || "";
    const from = `sip:.${accountId}.@${REALM}`;
    const token = makeVivoxToken({ action: "login", from });

    console.log(`\x1b[35m[VOICE]\x1b[0m login token requested for ${accountId}`);
    res.json({ token });
}

function voiceJoin(req, res) {
    const accountId = req.params.accountId || "";

    const channel = req.params.channelId || req.query.channel || req.body.channel || "";
    const from = `sip:.${accountId}.@${REALM}`;

    const to = channel ? `sip:confctl-g-Party-${channel}@${REALM}` : undefined;
    const token = makeVivoxToken({ action: "join", from, to });

    console.log(`\x1b[35m[VOICE]\x1b[0m join token requested for ${accountId} channel=${channel || "(none)"}`);
    res.json({ token });
}

express.get("/fortnite/api/game/v2/voice/:accountId/login", voiceLogin);
express.post("/fortnite/api/game/v2/voice/:accountId/login", voiceLogin);

express.get("/fortnite/api/game/v2/voice/:accountId/join/:channelId", voiceJoin);
express.post("/fortnite/api/game/v2/voice/:accountId/join/:channelId", voiceJoin);

express.get("/fortnite/api/game/v2/voice/:accountId/createJoinToken", voiceJoin);
express.post("/fortnite/api/game/v2/voice/:accountId/createJoinToken", voiceJoin);
express.get("/fortnite/api/game/v2/voice/:accountId/createLoginToken", voiceLogin);
express.post("/fortnite/api/game/v2/voice/:accountId/createLoginToken", voiceLogin);

express.post("/api2/viv_get_prelogin.php", (req, res) => {
    sendXml(res, {
        status: "OK",
        code: "200",
        VCConfiguration: {
            PermittedCodecs: "0x7f",
            DefaultSTUNServer: STUN_SERVER,
            DefaultAttemptUseSTUN: "0",
            DefaultSTUNTimeout: "5000",
            DefaultSIPProxy: SIP_PROXY,
            DefaultRealm: REALM,
            DefaultWatson: "",
            DefaultDyson: "",
            DefaultEureka: "",
            DysonSampleRate: "0",
            DefaultPublicKey: "",
            ServerPresenceEnabled: "0",
            CompactHeaders: "0",
            enableAGC: "1",
            enableAEC: "1",
            enableSRTP: "0",
            enableDeflate: "0",
        },
    });
});

express.get("/api2/viv_get_prelogin.php", (req, res) => {
    sendXml(res, {
        status: "OK",
        code: "200",
        VCConfiguration: {
            PermittedCodecs: "0x7f",
            DefaultSTUNServer: STUN_SERVER,
            DefaultAttemptUseSTUN: "0",
            DefaultSTUNTimeout: "5000",
            DefaultSIPProxy: SIP_PROXY,
            DefaultRealm: REALM,
            DefaultWatson: "",
            DefaultDyson: "",
            DefaultEureka: "",
            DysonSampleRate: "0",
            DefaultPublicKey: "",
            ServerPresenceEnabled: "0",
            CompactHeaders: "0",
            enableAGC: "1",
            enableAEC: "1",
            enableSRTP: "0",
            enableDeflate: "0",
        },
    });
});

function accountIdFromToken(tok) {
    try {
        const parts = String(tok).split(".");
        if (parts.length < 2) return null;
        let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        const m = String(payload.f || "").match(/sip:\.(.+?)\.@/i);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

express.post("/api2/viv_signin.php", (req, res) => {

    const accessToken = req.body.access_token || req.body.auth_token || req.body.token || req.body.access || "";
    const userid = req.body.userid || "";
    const displayname = req.body.displayname || "Player";

    let accountId = accountIdFromToken(accessToken);
    if (!accountId) {
        if (userid) accountId = xmlSafe(userid);
        else if (accessToken) accountId = crypto.createHash("sha256").update(accessToken).digest("hex").substring(0, 16);
        else accountId = crypto.randomBytes(8).toString("hex");
    }
    console.log(`\x1b[35m[VOICE]\x1b[0m signin -> sip user .${accountId}. (from token: ${accountIdFromToken(accessToken) ? "yes" : "no"})`);

    const sipUser = `.${accountId}.`;
    const sipUri = `sip:${sipUser}@${REALM}`;
    const sipPassword = crypto.randomBytes(16).toString("hex");
    const ha1 = crypto
        .createHash("md5")
        .update(`${sipUser}:${REALM}:${sipPassword}`)
        .digest("hex");

    sessions.set(accountId, {
        sipUri,
        sipPassword,
        ha1,
        displayname: xmlSafe(displayname),
        loginTime: Date.now(),
    });

    sendXml(res, {
        status: "OK",
        code: "200",
        account_id: sipUser,
        displayname: xmlSafe(displayname),
        sip_uri: sipUri,
        sip_password: sipPassword,
        sip_ha1: ha1,
        sip_proxy: SIP_PROXY,
        enableAGC: "1",
        enableAEC: "1",
        enableSRTP: "0",
        CompactHeaders: "0",
    });
});

express.post("/api2/viv_chan_cmd.php", (req, res) => {
    const mode = xmlSafe(req.body.mode || "");
    const chanUri = xmlSafe(req.body.chan_uri || "");
    const userUri = xmlSafe(req.body.user_uri || "");

    if (mode === "add_text" && chanUri) {
        if (!channels.has(chanUri)) channels.set(chanUri, new Set());
        channels.get(chanUri).add(userUri);
    } else if (mode === "remove_text" && chanUri) {
        if (channels.has(chanUri)) {
            channels.get(chanUri).delete(userUri);
            if (channels.get(chanUri).size === 0) channels.delete(chanUri);
        }
    }

    sendXml(res, { status: "OK", code: "200" });
});

express.post("/api2/viv_multi_chan_cmd.php", (req, res) => {
    const mode = xmlSafe(req.body.mode || "");
    const chanUri = xmlSafe(req.body.chan_uri || "");
    const toUri = xmlSafe(req.body.to_uri || "");

    if (mode === "remove" && chanUri) {
        if (channels.has(chanUri)) {
            channels.get(chanUri).delete(toUri);
            if (channels.get(chanUri).size === 0) channels.delete(chanUri);
        }
    }

    sendXml(res, { status: "OK", code: "200" });
});

express.post("/api2/viv_signout.php", (req, res) => {
    sendXml(res, { status: "OK", code: "200" });
});

const stubEndpoints = [
    "viv_client_events.php",
    "viv_call_stats.php",
    "viv_log_client_diags.php",
    "viv_report_config.php",
    "viv_buddy.php",
    "viv_watcher.php",
    "viv_buddy_set.php",
    "viv_buddy_group_set.php",
    "viv_buddy_delete.php",
    "viv_buddy_group_delete.php",
    "viv_chan_dir.php",
    "viv_chan_mod.php",
    "viv_channel_fav.php",
    "viv_channel_fav_set.php",
    "viv_chan_search.php",
    "viv_channel_fav_delete.php",
    "viv_channel_fav_group_set.php",
    "viv_channel_fav_group_delete.php",
    "viv_acct_search.php",
    "viv_set_acct.php",
    "viv_get_acct.php",
    "viv_sms_send.php",
    "viv_adm_new_font.php",
    "viv_chan_owner_set.php",
    "viv_chan_users.php",
    "viv_session_fonts.php",
    "viv_template_fonts.php",
    "viv_request_password.php",
];

for (const endpoint of stubEndpoints) {
    express.all(`/api2/${endpoint}`, (req, res) => {
        sendXml(res, { status: "OK", code: "200" });
    });
}

express.all("/api2/viv_*.php", (req, res) => {
    sendXml(res, { status: "OK", code: "200" });
});

express.sessions = sessions;
express.REALM = REALM;
express.SIP_HOST = SIP_HOST;
express.SIP_PORT = SIP_PORT;

module.exports = express;
