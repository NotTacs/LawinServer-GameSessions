// Hono-style request logger:
//   <-- POST /fortnite/api/game/v2/profile/.../QueryProfile?profileId=campaign
//   --> POST /fortnite/api/game/v2/profile/.../QueryProfile?profileId=campaign 200 4ms
// Requests that fall through to the 404 handler in index.js are tagged UNHANDLED (and their body is printed) so missing
// endpoints stand out. Set LOG_BODY=1 to print every request body.

const colors = {
    reset: "\x1b[0m",
    gray: "\x1b[90m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m"
};

function statusColor(status) {
    if (status >= 500) return colors.red;
    if (status >= 400) return colors.yellow;
    if (status >= 300) return colors.cyan;
    if (status >= 200) return colors.green;
    return colors.gray;
}

function time() {
    return new Date().toTimeString().slice(0, 8);
}

function formatBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === "object" && Object.keys(body).length === 0) return null;
    if (typeof body === "string") return body.length ? body : null;
    try {
        return JSON.stringify(body);
    } catch {
        return String(body);
    }
}

function logger(req, res, next) {
    const start = process.hrtime.bigint();
    const url = req.originalUrl || req.url;
    let logged = false;

    console.log(`${colors.gray}${time()}${colors.reset} ${colors.gray}<--${colors.reset} ${req.method} ${url}`);

    const done = (aborted) => {
        if (logged) return;
        logged = true;

        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const duration = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
        const status = aborted && !res.headersSent ? `${colors.red}aborted${colors.reset}` : `${statusColor(res.statusCode)}${res.statusCode}${colors.reset}`;
        const unhandled = res.locals.unhandled ? ` ${colors.magenta}UNHANDLED${colors.reset}` : "";

        console.log(`${colors.gray}${time()}${colors.reset} ${colors.gray}-->${colors.reset} ${req.method} ${url} ${status} ${colors.gray}${duration}${colors.reset}${unhandled}`);

        if (res.locals.unhandled || process.env.LOG_BODY === "1") {
            const body = formatBody(req.body);
            if (body) console.log(`    ${colors.gray}body:${colors.reset} ${body}`);
        }
    };

    res.on("finish", () => done(false));
    res.on("close", () => done(true));

    next();
}

module.exports = logger;
