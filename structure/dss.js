const Express = require("express");
const express = Express.Router();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DSS_ROOT = path.resolve(__dirname, "..", "DSS");
const META_HEADER_PREFIX = "x-epic-meta-";

express.use("/api/dss/v1", Express.raw({ type: () => true, limit: "512mb" }));

function SendDssError(res, status, errorCode, errorMessage) {
    res.status(status).json({
        "errorCode": `errors.com.epicgames.dss.${errorCode}`,
        "errorMessage": errorMessage,
        "messageVars": [],
        "numericErrorCode": status,
        "originatingService": "dss",
        "intent": "prod"
    });
}

function ResolveFile(appName, filePath) {
    const fullPath = path.resolve(DSS_ROOT, appName, filePath);
    if (!fullPath.startsWith(DSS_ROOT + path.sep)) return null;

    return fullPath;
}

function ReadState(fullPath) {
    try {
        return JSON.parse(fs.readFileSync(`${fullPath}.state.json`, "utf8"));
    } catch {
        return { "meta": {}, "checkoutGuid": null };
    }
}

function WriteState(fullPath, state) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(`${fullPath}.state.json`, JSON.stringify(state, null, 2));
}

function GetMetaFromRequest(req) {
    const meta = {};

    for (const [header, value] of Object.entries(req.headers)) {
        if (header.startsWith(META_HEADER_PREFIX)) meta[header.substring(META_HEADER_PREFIX.length)] = value;
    }

    return meta;
}

function GetBody(req) {
    return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function WriteFile(fullPath, state, data, meta) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);

    state.meta = { ...state.meta, ...meta };
    state.md5 = crypto.createHash("md5").update(data).digest("hex");
    state.size = data.length;
    state.updated = new Date().toISOString();
}

function SendFile(res, fullPath, state) {
    for (const [key, value] of Object.entries(state.meta || {})) {
        res.setHeader(`X-Epic-Meta-${key}`, value);
    }

    res.setHeader("Content-Type", "application/octet-stream");

    if (fs.existsSync(fullPath)) {
        res.status(200).send(fs.readFileSync(fullPath));
    } else {
        res.status(200).send(Buffer.alloc(0));
    }
}

function GetCheckoutGuid(req) {
    return req.headers["x-epic-checkoutguid"] || null;
}

express.get(/^\/api\/dss\/v1\/([^/]+)\/(.+)$/, (req, res) => {
    const fullPath = ResolveFile(req.params[0], req.params[1]);
    if (!fullPath) return SendDssError(res, 400, "invalid_path", "Invalid file path");

    if (!fs.existsSync(fullPath)) return SendDssError(res, 404, "file_not_found", `File ${req.params[1]} not found`);

    SendFile(res, fullPath, ReadState(fullPath));
});

express.post(/^\/api\/dss\/v1\/([^/]+)\/(.+)\/checkout$/, (req, res) => {
    const fullPath = ResolveFile(req.params[0], req.params[1]);
    if (!fullPath) return SendDssError(res, 400, "invalid_path", "Invalid file path");

    const state = ReadState(fullPath);
    const checkoutGuid = GetCheckoutGuid(req);

    state.checkoutGuid = checkoutGuid || crypto.randomUUID();
    WriteState(fullPath, state);

    if (String(req.query.dl).toLowerCase() == "true") return SendFile(res, fullPath, state);

    res.status(200).end();
});

express.post(/^\/api\/dss\/v1\/([^/]+)\/(.+)\/checkin$/, (req, res) => {
    const fullPath = ResolveFile(req.params[0], req.params[1]);
    if (!fullPath) return SendDssError(res, 400, "invalid_path", "Invalid file path");

    const state = ReadState(fullPath);
    const checkoutGuid = GetCheckoutGuid(req);

    if (state.checkoutGuid && checkoutGuid && state.checkoutGuid != checkoutGuid) {
        return SendDssError(res, 409, "invalid_checkout_guid", `File ${req.params[1]} is checked out by someone else`);
    }

    const data = GetBody(req);
    if (data.length > 0) WriteFile(fullPath, state, data, GetMetaFromRequest(req));

    state.checkoutGuid = null;
    WriteState(fullPath, state);

    res.status(200).end();
});

express.post(/^\/api\/dss\/v1\/([^/]+)\/(.+)\/restore$/, (req, res) => {
    const fullPath = ResolveFile(req.params[0], req.params[1]);
    if (!fullPath) return SendDssError(res, 400, "invalid_path", "Invalid file path");

    if (!fs.existsSync(fullPath)) return SendDssError(res, 404, "file_not_found", `File ${req.params[1]} not found`);

    SendFile(res, fullPath, ReadState(fullPath));
});

express.put(/^\/api\/dss\/v1\/([^/]+)\/(.+)$/, (req, res) => {
    const fullPath = ResolveFile(req.params[0], req.params[1]);
    if (!fullPath) return SendDssError(res, 400, "invalid_path", "Invalid file path");

    const state = ReadState(fullPath);
    const checkoutGuid = GetCheckoutGuid(req);
    const bAutoLock = String(req.query.autolock).toLowerCase() == "true";

    if (state.checkoutGuid && state.checkoutGuid != checkoutGuid) {
        return SendDssError(res, 409, "file_checked_out", `File ${req.params[1]} is checked out`);
    }

    if (bAutoLock) state.checkoutGuid = checkoutGuid || crypto.randomUUID();

    WriteFile(fullPath, state, GetBody(req), GetMetaFromRequest(req));
    WriteState(fullPath, state);

    res.status(200).end();
});

module.exports = express;
