const Express = require("express");
const express = Express.Router();
const fs = require("fs");
const functions = require("./functions.js");

const DEFAULT_PLOT_TEMPLATE = "CreativePlot:temperate_medium";
const DEFAULT_MAX_ISLAND_PLOTS = 25;

function GetCreativeProfile() {
    const profile = require("./../profiles/creative.json");

    if (!profile.rvn) profile.rvn = 0;
    if (!profile.items) profile.items = {};
    if (!profile.stats) profile.stats = {};
    if (!profile.stats.attributes) profile.stats.attributes = {};
    if (!profile.commandRevision) profile.commandRevision = 0;
    if (!Array.isArray(profile.stats.attributes.permissions)) profile.stats.attributes.permissions = [];
    if (!profile.stats.attributes.permissions.includes("fortnite:creative:beta:creatorportal")) profile.stats.attributes.permissions.push("fortnite:creative:beta:creatorportal");
    if (!profile.stats.attributes.max_island_plots) profile.stats.attributes.max_island_plots = DEFAULT_MAX_ISLAND_PLOTS;

    return profile;
}

function SaveCreativeProfile(profile) {
    fs.writeFileSync("./profiles/creative.json", JSON.stringify(profile, null, 2));
}

function GetPlots(profile) {
    return Object.entries(profile.items).filter(([, item]) => typeof item.templateId == "string" && item.templateId.toLowerCase().startsWith("creativeplot:"));
}

function GetNextIslandIndex(profile) {
    const usedIndexes = GetPlots(profile).map(([, item]) => item.attributes?.islandIndex).filter((index) => typeof index == "number");

    let nextIndex = 1;
    while (usedIndexes.includes(nextIndex)) nextIndex++;

    return nextIndex;
}

function MakePlot(profile, templateId, locale, title) {
    return {
        "templateId": templateId || DEFAULT_PLOT_TEMPLATE,
        "attributes": {
            "islandIndex": GetNextIslandIndex(profile),
            "locale": locale || "en",
            "title": title || "",
            "tagline": "",
            "descriptionTags": [],
            "introduction": "",
            "last_used_date": new Date().toISOString(),
            "level": 1,
            "item_seen": false,
            "favorite": false
        },
        "quantity": 1
    };
}

function SendItemNotFound(res, itemId) {
    res.status(404).json({
        "errorCode": "errors.com.epicgames.fortnite.item_not_found",
        "errorMessage": `Item ${itemId} not found`,
        "messageVars": [itemId],
        "numericErrorCode": 16006,
        "originatingService": "fortnite",
        "intent": "prod"
    });
}

function SendPlotLimitReached(res, maxPlots) {
    res.status(400).json({
        "errorCode": "errors.com.epicgames.fortnite.creative.plot_limit_reached",
        "errorMessage": `You can only have ${maxPlots} islands`,
        "messageVars": [String(maxPlots)],
        "numericErrorCode": 16150,
        "originatingService": "fortnite",
        "intent": "prod"
    });
}

function SendProfileResponse(req, res, profile, ApplyProfileChanges, BaseRevision) {
    const QueryRevision = req.query.rvn || -1;

    if (QueryRevision != BaseRevision) {
        ApplyProfileChanges = [{
            "changeType": "fullProfileUpdate",
            "profile": profile
        }];
    }

    res.json({
        "profileRevision": profile.rvn || 0,
        "profileId": "creative",
        "profileChangesBaseRevision": BaseRevision,
        "profileChanges": ApplyProfileChanges,
        "profileCommandRevision": profile.commandRevision || 0,
        "serverTime": new Date().toISOString(),
        "responseVersion": 1
    });
}

function CommitChanges(profile) {
    profile.rvn += 1;
    profile.commandRevision += 1;
    SaveCreativeProfile(profile);
}

function SetAttribute(profile, itemId, attributeName, attributeValue, ApplyProfileChanges) {
    profile.items[itemId].attributes[attributeName] = attributeValue;

    ApplyProfileChanges.push({
        "changeType": "itemAttrChanged",
        "itemId": itemId,
        "attributeName": attributeName,
        "attributeValue": attributeValue
    });
}

function CreativeCommand(command, handler) {
    express.post([
        `/fortnite/api/game/v2/profile/*/dedicated_server/${command}`,
        `/fortnite/api/game/v2/profile/*/client/${command}`
    ], async (req, res) => {
        if ((req.query.profileId || "creative") != "creative") {
            return res.status(400).json({
                "errorCode": "errors.com.epicgames.modules.profiles.invalid_command",
                "errorMessage": `${command} is not valid on profile ${req.query.profileId}`,
                "messageVars": [command, req.query.profileId],
                "numericErrorCode": 12801,
                "originatingService": "fortnite",
                "intent": "prod"
            });
        }

        const profile = GetCreativeProfile();
        const BaseRevision = profile.rvn || 0;
        const ApplyProfileChanges = [];

        const bHandled = handler(req, res, profile, ApplyProfileChanges);
        if (bHandled === false) return;

        if (ApplyProfileChanges.length > 0) CommitChanges(profile);

        SendProfileResponse(req, res, profile, ApplyProfileChanges, BaseRevision);
    });
}

function AddPlot(req, res, profile, ApplyProfileChanges, plot) {
    const maxPlots = profile.stats.attributes.max_island_plots || DEFAULT_MAX_ISLAND_PLOTS;
    const activePlots = GetPlots(profile).filter(([, item]) => !item.attributes?.deleted_at);

    if (activePlots.length >= maxPlots) {
        SendPlotLimitReached(res, maxPlots);
        return false;
    }

    const itemId = functions.MakeID();
    profile.items[itemId] = plot;

    ApplyProfileChanges.push({
        "changeType": "itemAdded",
        "itemId": itemId,
        "item": plot
    });

    return true;
}

CreativeCommand("CreateNewIsland", (req, res, profile, ApplyProfileChanges) => {
    const plot = MakePlot(profile, req.body.templateId, req.body.locale, req.body.title);
    return AddPlot(req, res, profile, ApplyProfileChanges, plot);
});

CreativeCommand("CreateNewIslandFromLinkCode", (req, res, profile, ApplyProfileChanges) => {
    const plot = MakePlot(profile, DEFAULT_PLOT_TEMPLATE, req.body.locale, req.body.title);
    plot.attributes.island_code = req.body.linkCode || "";
    return AddPlot(req, res, profile, ApplyProfileChanges, plot);
});

CreativeCommand("DuplicateIsland", (req, res, profile, ApplyProfileChanges) => {
    const source = profile.items[req.body.islandId];
    if (!source) {
        SendItemNotFound(res, req.body.islandId);
        return false;
    }

    const plot = MakePlot(profile, source.templateId, req.body.locale || source.attributes.locale, req.body.newTitle);
    plot.attributes.tagline = source.attributes.tagline || "";
    plot.attributes.descriptionTags = [...(source.attributes.descriptionTags || [])];
    plot.attributes.introduction = source.attributes.introduction || "";

    return AddPlot(req, res, profile, ApplyProfileChanges, plot);
});

CreativeCommand("DeleteIsland", (req, res, profile, ApplyProfileChanges) => {
    if (!profile.items[req.body.plotItemId]) {
        SendItemNotFound(res, req.body.plotItemId);
        return false;
    }

    SetAttribute(profile, req.body.plotItemId, "deleted_at", new Date().toISOString(), ApplyProfileChanges);
});

CreativeCommand("RestoreDeletedIsland", (req, res, profile, ApplyProfileChanges) => {
    const plot = profile.items[req.body.plotItemId];
    if (!plot) {
        SendItemNotFound(res, req.body.plotItemId);
        return false;
    }

    delete plot.attributes.deleted_at;
    plot.attributes.last_used_date = new Date().toISOString();

    ApplyProfileChanges.push({
        "changeType": "itemRemoved",
        "itemId": req.body.plotItemId
    });
    ApplyProfileChanges.push({
        "changeType": "itemAdded",
        "itemId": req.body.plotItemId,
        "item": plot
    });
});

CreativeCommand("SetCreativePlotMetadata", (req, res, profile, ApplyProfileChanges) => {
    if (!profile.items[req.body.plotItemId]) {
        SendItemNotFound(res, req.body.plotItemId);
        return false;
    }

    SetAttribute(profile, req.body.plotItemId, "locale", req.body.locale || "en", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "title", req.body.title || "", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "tagline", req.body.tagline || "", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "descriptionTags", req.body.descriptionTags || [], ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "introduction", req.body.introduction || "", ApplyProfileChanges);
});

CreativeCommand("SetLastUsedCreativePlot", (req, res, profile, ApplyProfileChanges) => {
    if (!profile.items[req.body.plotItemId]) {
        SendItemNotFound(res, req.body.plotItemId);
        return false;
    }

    SetAttribute(profile, req.body.plotItemId, "last_used_date", new Date().toISOString(), ApplyProfileChanges);
});

CreativeCommand("SetLastUsedProject", (req, res, profile, ApplyProfileChanges) => {
    profile.stats.attributes.last_used_project = req.body.projectId || "";

    ApplyProfileChanges.push({
        "changeType": "statModified",
        "name": "last_used_project",
        "value": profile.stats.attributes.last_used_project
    });
});

CreativeCommand("ModifyCreativePlotPermissions", (req, res, profile, ApplyProfileChanges) => {
    if (!profile.items[req.body.plotItemId]) {
        SendItemNotFound(res, req.body.plotItemId);
        return false;
    }

    SetAttribute(profile, req.body.plotItemId, "permissions", {
        "permission": req.body.permission || "Private",
        "whitelist": req.body.accountIds || []
    }, ApplyProfileChanges);
});

CreativeCommand("UpdatePlotPublishInfo", (req, res, profile, ApplyProfileChanges) => {
    if (!profile.items[req.body.plotItemId]) {
        SendItemNotFound(res, req.body.plotItemId);
        return false;
    }

    SetAttribute(profile, req.body.plotItemId, "island_code", req.body.linkCode || "", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "vk_project_id", req.body.vkProjectId || "", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "vk_module_id", req.body.vkModuleId || "", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "last_published_version", req.body.linkVersion || 0, ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "moderation_code", req.body.moderationLinkCode || "", ApplyProfileChanges);
    SetAttribute(profile, req.body.plotItemId, "last_published_date", new Date().toISOString(), ApplyProfileChanges);
});

module.exports = express;
