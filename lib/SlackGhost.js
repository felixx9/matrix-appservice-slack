"use strict";

var rp = require('request-promise');

// How long in msec to cache avatar URL lookups from slack
var AVATAR_CACHE_TIMEOUT = 10 * 60 * 1000;  // 10 minutes

function SlackGhost(opts) {
    this._bridge = opts.bridge;

    this._user_id = opts.user_id;
    this._display_name = opts.display_name;
    this._avatar_url = opts.avatar_url;

    this._intent = opts.intent;
}

SlackGhost.fromEntry = function(bridge, entry, intent) {
    return new SlackGhost({
        bridge: bridge,

        user_id: entry.id,
        display_name: entry.display_name,
        avatar_url: entry.avatar_url,

        intent: intent,
    });
};

SlackGhost.prototype.toEntry = function() {
    var entry = {
        id: this._user_id,
        display_name: this._display_name,
        avatar_url: this._avatar_url,
    };

    return entry;
};

SlackGhost.prototype.getIntent = function() {
    return this._intent;
};

SlackGhost.prototype.update = function(message) {
    return Promise.all([
        this.updateDisplayname(message).catch((e) => {
            console.log("Failed to update ghost displayname:", e);
        }),
        this.updateAvatar(message).catch((e) => {
            console.log("Failed to update ghost avatar:", e);
        }),
    ]);
};

SlackGhost.prototype.updateDisplayname = function(message) {
    var display_name = message.user_name;
    if (!display_name) return Promise.resolve();
    if (this._display_name === display_name) return Promise.resolve();

    return this.getIntent().setDisplayName(display_name).then(() => {
        this._display_name = display_name;
        return this._bridge.putUserToStore(this);
    });
};

SlackGhost.prototype.lookupAvatarUrl = function(user_id, team_token) {
    if (this._avatar_url_cache) return Promise.resolve(this._avatar_url_cache);

    return rp({
        uri: 'https://slack.com/api/users.info',
        qs: {
            token: team_token,
            user: user_id,
        },
        json: true,
    }).then((response) => {
        if (!response.user || !response.user.profile) return;
        var profile = response.user.profile;

        // Pick the original image if we can, otherwise pick the largest image
        // that is defined
        var avatar_url = profile.image_original ||
            profile.image_1024 || profile.image_512 || profile.image_192 ||
            profile.image_72 || profile.image_48;

        this._avatar_url_cache = avatar_url;
        setTimeout(() => { this._avatar_url_cache = null }, AVATAR_CACHE_TIMEOUT);

        return avatar_url;
    });
};

SlackGhost.prototype.updateAvatar = function(message) {
    var team_token = this._bridge.getTeamToken(message.team_domain);
    if (!team_token) return Promise.resolve();

    return this.lookupAvatarUrl(message.user_id, team_token).then((avatar_url) => {
        if (this._avatar_url === avatar_url) return;

        var shortname = avatar_url.match(/\/([^\/]+)$/)[1];

        return rp({
            uri: avatar_url,
            resolveWithFullResponse: true,
            encoding: null,
        }).then((response) => {
            return this.uploadContent({
                _content: response.body,
                title: shortname,
                mimetype: response.headers["content-type"],
            });
        }).then((content_uri) => {
            this.getIntent().setAvatarUrl(content_uri);
        }).then(() => {
            this._avatar_url = avatar_url;
            this._bridge.putUserToStore(this);
        });
    });
};

SlackGhost.prototype.sendText = function(room_id, text) {
    this.getIntent().sendText(room_id, text).then(() => {
        this._bridge.incCounter("sent_messages", {side: "matrix"});
    });
};

SlackGhost.prototype.sendMessage = function(room_id, msg) {
    this.getIntent().sendMessage(room_id, msg).then(() => {
        this._bridge.incCounter("sent_messages", {side: "matrix"});
    });
};

SlackGhost.prototype.uploadContent = function(file) {
    return this.getIntent().getClient().uploadContent({
            stream: new Buffer(file._content, "binary"),
            name: file.title,
            type: file.mimetype,
    }).then((response) => {
        var content_uri = JSON.parse(response).content_uri;

        console.log("Media uploaded to " + content_uri);
        return content_uri;
    });
};

module.exports = SlackGhost;