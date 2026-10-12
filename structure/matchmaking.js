const Express = require("express");
const express = Express.Router();
const fs = require("fs");
const path = require("path");
const iniparser = require("ini");
const config = iniparser.parse(fs.readFileSync(path.join(__dirname, "..", "Config", "config.ini")).toString());
const functions = require("./functions.js");
const { randomUUID } = require("crypto");
const jwt = require('jsonwebtoken');

let currentSessionId = randomUUID();
const gamesessions = [];

express.get("/fortnite/api/matchmaking/session/findPlayer/*", async (req, res) => {
    res.status(200);
    res.end();
});

express.get("/fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId", async (req, res) => {
    res.cookie("currentbuildUniqueId", req.query.bucketId.split(":")[0]);

    const query = req.query;
    const accountId = req.params.accountId;

    console.log(query);

    const partyQuery = query.partyPlayerIds || "";

    const tokenPayload = {
        accountId: accountId,
        bucketId: query.bucketId,
        region: query.bucketId.split(":")[2],
        version: '19.10',
        playlist: query.bucketId.split(":")[3],
        party: query.partyPlayerIds,
        buildUniqueId: query.bucketId.split(":")[0],
        bIsFill: query['player.option.fillTeam'],
    };

    const tokenString = jwt.sign(tokenPayload, "123", { algorithm: 'HS256' });

    res.json({
        "serviceUrl": "ws://127.0.0.1:2053",
        "ticketType": "Flipped",
        "payload": tokenString.split(".")[0] + "." + tokenString.split(".")[1],
        "signature": tokenString.split(".")[2],
    });
    res.end();
});

// Encryption key exchange for session - must reliably return the key for both client & server
express.get(
  "/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId",
  async (req, res) => {
    return res.status(200).json({
      accountId: req.params.accountId,
      sessionId: req.params.sessionId,
      key: "AOJEv8uTFmUh7XM2328kq9rlAzeQ5xzWzPIiyKn2s7s=",
    });
  },
);

// 1. Literal / Specific POST routes MUST come before /:session_id
express.post(
    "/fortnite/api/matchmaking/session/matchMakingRequest",
    async (req, res) => {
        if (!gamesessions.length) {
            console.log("No game sessions available.");
            return res.status(200).json([]);
        }

        // Return array of sessions
        return res.status(200).json(gamesessions);
    },
);

express.post("/fortnite/api/matchmaking/session/*/join", async (req, res) => {
    res.status(204);
    res.end();
});

// Dedicated server registers / updates session
express.post("/fortnite/api/matchmaking/session", async (req, res) => {
    const body = req.body;
    // CRITICAL: Preserve session ID across dedicated server restarts/map reloads
    // so the client's reserved session ID matches the server's session ID!
    const id = body.id || body.sessionId || (gamesessions.length > 0 ? gamesessions[0].id : currentSessionId);
    currentSessionId = id;

    console.log(body);

    const session = {
        id: id,
        ownerId: body.ownerId,
        ownerName: body.ownerName,
        serverName: body.serverName,
        openPrivatePlayers: body.openPrivatePlayers ?? 0,
        openPublicPlayers: body.openPublicPlayers ?? 0,
        maxPublicPlayers: body.maxPublicPlayers ?? 0,
        maxPrivatePlayers: body.maxPrivatePlayers ?? 0,
        shouldAdvertise: body.shouldAdvertise ?? true,
        allowJoinInProgress: body.allowJoinInProgress ?? true,
        isDedicated: body.isDedicated ?? true,
        usesStats: body.usesStats ?? false,
        allowInvites: body.allowInvites ?? true,
        usesPresence: body.usesPresence ?? false,
        allowJoinViaPresence: body.allowJoinViaPresence ?? true,
        allowJoinViaPresenceFriendsOnly:
            body.allowJoinViaPresenceFriendsOnly ?? false,
        buildUniqueId: body.buildUniqueId,
        attributes: body.attributes || {},
        serverPort: body.serverPort ?? 7777,
        sortWeight: body.sortWeight ?? 0,
        started: body.started ?? false,
        publicPlayers: body.publicPlayers || [],
        privatePlayers: body.privatePlayers || [],
        lastUpdated: new Date().toISOString(),
        serverAddress: "127.0.0.1",
    };
    gamesessions.length = 0;
    gamesessions.push(session);

    res.status(200).json(session);
});

express.post(
  "/fortnite/api/matchmaking/session/:session_id/start",
  async (req, res) => {
    const session = gamesessions.find((x) => x.id === req.params.session_id);

    if (!session) {
      return res.status(404).json({
        error: "Session not found",
      });
    }

    session.started = true;
    session.lastUpdated = new Date().toISOString();

    return res.status(200).json(session);
  },
);

express.post(
  "/fortnite/api/matchmaking/session/:sessionId/heartbeat",
  async (req, res) => {
    const session = gamesessions.find((x) => x.id === req.params.sessionId);

    if (!session) {
      return res.status(404).end();
    }

    session.lastUpdated = new Date().toISOString();

    return res.status(200).json(session);
  },
);

express.put(
  "/fortnite/api/matchmaking/session/:sessionId",
  async (req, res) => {
    const session = gamesessions.find((x) => x.id === req.params.sessionId);

    if (!session) {
      return res.status(404).json({
        error: "Session not found",
      });
    }

    Object.assign(session, req.body || {});
    session.id = req.params.sessionId;
    session.lastUpdated = new Date().toISOString();

    return res.status(200).json(session);
  },
);

// Destroy session endpoint (called when server restarts/shuts down)
express.delete(
  "/fortnite/api/matchmaking/session/:sessionId",
  async (req, res) => {
    return res.status(204).end();
  },
);

express.post(
  "/fortnite/api/matchmaking/session/:sessionId/players",
  async (req, res) => {
    const session = gamesessions.find((x) => x.id === req.params.sessionId);

    if (!session) {
      return res.status(404).json({
        error: "Session not found",
      });
    }

    session.publicPlayers = req.body?.publicPlayers ?? [];
    session.privatePlayers = req.body?.privatePlayers ?? [];

    session.openPublicPlayers = Math.max(
      0,
      (session.maxPublicPlayers ?? 0) - session.publicPlayers.length,
    );

    session.openPrivatePlayers = Math.max(
      0,
      (session.maxPrivatePlayers ?? 0) - session.privatePlayers.length,
    );

    session.lastUpdated = new Date().toISOString();

    return res.status(200).json({
      maxPublicPlayers: session.maxPublicPlayers,
      openPublicPlayers: session.openPublicPlayers,
      maxPrivatePlayers: session.maxPrivatePlayers,
      openPrivatePlayers: session.openPrivatePlayers,
      publicPlayers: session.publicPlayers,
      privatePlayers: session.privatePlayers,
    });
  },
);

// Parameterized POST fallback for /:session_id
express.post("/fortnite/api/matchmaking/session/:session_id", async (req, res) => {
    const body = req.body;
    currentSessionId = req.params.session_id;

    const session = {
        id: req.params.session_id,
        ownerId: body.ownerId,
        ownerName: body.ownerName,
        serverName: body.serverName,
        openPrivatePlayers: body.openPrivatePlayers ?? 0,
        openPublicPlayers: body.openPublicPlayers ?? 0,
        maxPublicPlayers: body.maxPublicPlayers ?? 0,
        maxPrivatePlayers: body.maxPrivatePlayers ?? 0,
        shouldAdvertise: body.shouldAdvertise ?? true,
        allowJoinInProgress: body.allowJoinInProgress ?? true,
        isDedicated: body.isDedicated ?? true,
        usesStats: body.usesStats ?? false,
        allowInvites: body.allowInvites ?? true,
        usesPresence: body.usesPresence ?? false,
        allowJoinViaPresence: body.allowJoinViaPresence ?? true,
        allowJoinViaPresenceFriendsOnly:
            body.allowJoinViaPresenceFriendsOnly ?? false,
        buildUniqueId: body.buildUniqueId,
        attributes: body.attributes || {},
        serverPort: body.serverPort ?? 7777,
        sortWeight: body.sortWeight ?? 0,
        started: body.started ?? false,
        publicPlayers: body.publicPlayers || [],
        privatePlayers: body.privatePlayers || [],
        lastUpdated: new Date().toISOString(),
        serverAddress: "127.0.0.1",
    };

    const index = gamesessions.findIndex((x) => x.id === req.params.session_id);

    if (index === -1) {
        gamesessions.push(session);
    } else {
        gamesessions[index] = session;
    }

    return res.json(session);
});

// GET session by ID
express.get("/fortnite/api/matchmaking/session/:session_id", async (req, res) => {
    const existing = gamesessions.find((x) => x.id === req.params.session_id);
    if (existing) {
        return res.status(200).json(existing);
    }

    res.json({
        "id": req.params.session_id,
        "ownerId": functions.MakeID().replace(/-/ig, "").toUpperCase(),
        "ownerName": gamesessions[0]?.ownerName || "LawinServer",
        "serverName": gamesessions[0]?.serverName || "LawinServer",
        "serverAddress": "127.0.0.1",
        "serverPort": 7777,
        "maxPublicPlayers": 220,
        "openPublicPlayers": 175,
        "maxPrivatePlayers": 0,
        "openPrivatePlayers": 0,
        "attributes": {
            "REGION_s": "NAE",
            "GAMEMODE_s": "FORTATHENA",
            "ALLOWBROADCASTING_b": true,
            "SUBREGION_s": "GB",
            "DCID_s": "FORTNITE-LIVEEUGCEC1C2E30UBRCORE0A-14840880",
            "tenant_s": "Fortnite",
            "MATCHMAKINGPOOL_s": "Any",
            "STORMSHIELDDEFENSETYPE_i": 0,
            "HOTFIXVERSION_i": 0,
            "PLAYLISTNAME_s": gamesessions[0]?.attributes?.PLAYLISTNAME_s || "Playlist_DefaultSolo",
            "SESSIONKEY_s": functions.MakeID().replace(/-/ig, "").toUpperCase(),
            "TENANT_s": "Fortnite",
            "BEACONPORT_i": 15009
        },
        "publicPlayers": [],
        "privatePlayers": [],
        "totalPlayers": 45,
        "allowJoinInProgress": false,
        "shouldAdvertise": false,
        "isDedicated": false,
        "usesStats": false,
        "allowInvites": false,
        "usesPresence": false,
        "allowJoinViaPresence": true,
        "allowJoinViaPresenceFriendsOnly": false,
        "buildUniqueId": req.cookies.currentbuildUniqueId || "0",
        "lastUpdated": new Date().toISOString(),
        "started": false
    });
});

express.post("/fortnite/api/game/v2/world/validate", async (req, res) => {
  const { theaterId, theaterMissionId, zoneThemeClass, worldId } = req.body;

  if (!theaterId || !theaterMissionId || !zoneThemeClass)
    return res.status(400).end();

  if (typeof worldInfo === "undefined" || !worldInfo.missions) {
    return res.status(404).end();
  }

  const theater = worldInfo.missions.find(
    (theater) => theater.theaterId === theaterId,
  );
  if (!theater) return res.status(404).end();

  const mission = theater.availableMissions.find(
    (mission) => mission.missionGuid === theaterMissionId,
  );
  if (!mission) return res.status(404).end();

  const missionData = {
    worldId,
    theaterId,
    theaterMissionId,
    zoneThemeClass,
    missionRewards: mission.missionRewards,
    missionGenerator: mission.missionGenerator,
    zoneDifficultyInfo: mission.missionDifficultyInfo,
    tileIndex: mission.tileIndex,
    zoneModifiers: [],
  };

  res.json(missionData);
});

express.get("/fortnite/api/game/v2/matchmakingservice/ticket/session/:sessionId", async (req, res) => {
    const body = req.body;
    const params = req.params;
    const query = req.query;
    console.log(params);
    res.status(200);
    console.log(body);
    console.log(query);
    const now = Math.floor(Date.now() / 1000);
    const expirationTime = now + 3600;
    const sessionId = params.sessionId;
    const bucketIds = query.bucketIds;
    const excludedBucketIds = query.excludedBucketIds;

    if (!bucketIds || typeof bucketIds !== "string") {
        return res.status(400).json({
            errorCode: "errors.com.epicgames.bad_request",
            errorMessage: "Missing or invalid bucketIds",
        });
    }

    const bucketParts = bucketIds.split(":");

    const payload = {
        buildUniqueId: query.bucketIds.split(":")[0],
        exp: expirationTime,
        iat: now,
        jti: randomUUID(),
        bucketId: query.bucketIds,
        region: query.bucketIds.split(":")[2],
        version: '19.10',
    };
    const tokenString = jwt.sign(payload, "123", { algorithm: 'HS256' });

    res.json({
        ServiceUrl: "ws://127.0.0.1:30213",
        ticketType: "Flipped-Sessions",
        payload: JSON.stringify(sessionId),
        signature: tokenString,
    });
});

module.exports = express;
