/*
 * RemoteSlideSocket - a small WebSocket client for the Remote Slide protocol.
 *
 * Shipped as a plain script (no module system) because it has to run in three
 * very different places: the website, a Chrome extension content script, and a
 * presentation page that the bookmarklet injected it into. It exposes a single
 * global, RemoteSlideSocket.
 *
 *   var socket = new RemoteSlideSocket("https://remote-sli.de");
 *   socket.on("init", function (data) { ... });
 *   socket.connect({session: "abcdefghij", role: "host", injector: "bookmark"});
 *   socket.emit("slideInfo", {data: {...}});
 *
 * Every frame on the wire is a JSON object with an "event" name; the remaining
 * keys are the payload. Handlers registered with on() receive that payload.
 * Besides the server's events the client emits a few of its own:
 *   "connect"                     the socket is open
 *   "disconnect" ({code, reason}) the connection was lost; it will be retried
 *   "rejected" ({code, reason})   the server closed it on purpose (4xxx codes:
 *                                 session not found, replaced by a newer
 *                                 connection, ...); it will NOT be retried
 *   "reconnecting" ({attempt, delay})
 *   "latency" ({latency})         a heartbeat round trip, in milliseconds
 */
(function (root) {
    "use strict";

    var HEARTBEAT_INTERVAL = 2000;
    var HEARTBEAT_TIMEOUT = 10000;
    // Must match the server's auto-response exactly so the heartbeat is answered
    // without waking the session's Durable Object.
    var HEARTBEAT_FRAME = '{"event":"latency"}';
    var RECONNECT_MIN = 1000;
    var RECONNECT_MAX = 10000;

    function RemoteSlideSocket(baseUrl) {
        this.baseUrl = baseUrl || (root.location && root.location.origin) || "https://remote-sli.de";
        this.connected = false;
        this.latency = 0;
        this.target = null;

        this._handlers = {};
        this._ws = null;
        this._attempt = 0;
        this._reconnectTimer = null;
        this._heartbeatTimer = null;
        this._heartbeatSentAt = 0;
        this._lastHeartbeatReply = 0;
        this._closedByUser = false;
    }

    RemoteSlideSocket.prototype.on = function (event, handler) {
        (this._handlers[event] = this._handlers[event] || []).push(handler);
        return this;
    };

    RemoteSlideSocket.prototype.off = function (event, handler) {
        var list = this._handlers[event];
        if (!list) return this;
        if (!handler) {
            delete this._handlers[event];
            return this;
        }
        var index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
        return this;
    };

    /** URL the socket connects to for the current target. */
    RemoteSlideSocket.prototype.url = function () {
        var base = this.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
        var url = base + "/ws/" + encodeURIComponent(this.target.session) + "?as=" + encodeURIComponent(this.target.role);
        if (this.target.injector) {
            url += "&injector=" + encodeURIComponent(this.target.injector);
        }
        return url;
    };

    /**
     * Joins a session. options: {session, role ("host" | "remote" | "observer"), injector}.
     * Calling it again replaces the current connection.
     */
    RemoteSlideSocket.prototype.connect = function (options) {
        if (!options || !options.session || !options.role) {
            throw new Error("RemoteSlideSocket.connect needs a session and a role");
        }
        this.disconnect();
        this._closedByUser = false;
        this._attempt = 0;
        this.target = {session: options.session, role: options.role, injector: options.injector};
        this._open();
        return this;
    };

    RemoteSlideSocket.prototype.disconnect = function () {
        this._closedByUser = true;
        this._clearTimers();
        var ws = this._ws;
        this._ws = null;
        if (ws) {
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try {
                ws.close(1000, "Client closed");
            } catch (ignored) {
            }
        }
        this.connected = false;
        return this;
    };

    /** Sends an event. Returns false (and drops the frame) if not connected. */
    RemoteSlideSocket.prototype.emit = function (event, data) {
        if (!this.connected || !this._ws) {
            return false;
        }
        var frame = {};
        if (data && typeof data === "object") {
            for (var key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    frame[key] = data[key];
                }
            }
        }
        frame.event = event;
        try {
            this._ws.send(JSON.stringify(frame));
            return true;
        } catch (error) {
            console.warn("[RemoteSlideSocket] send failed", error);
            return false;
        }
    };

    RemoteSlideSocket.prototype._open = function () {
        var self = this;
        var ws;
        try {
            ws = new WebSocket(this.url());
        } catch (error) {
            console.warn("[RemoteSlideSocket] could not open socket", error);
            this._scheduleReconnect(1006, "Could not open socket");
            return;
        }
        this._ws = ws;

        ws.onopen = function () {
            if (self._ws !== ws) return;
            self.connected = true;
            self._attempt = 0;
            self._lastHeartbeatReply = Date.now();
            self._startHeartbeat();
            self._dispatch("connect", {});
        };
        ws.onmessage = function (message) {
            if (self._ws !== ws) return;
            var frame;
            try {
                frame = JSON.parse(message.data);
            } catch (error) {
                console.warn("[RemoteSlideSocket] dropping unparsable frame", message.data);
                return;
            }
            if (!frame || typeof frame.event !== "string") return;
            if (frame.event === "latency") {
                self._lastHeartbeatReply = Date.now();
                if (self._heartbeatSentAt) {
                    self.latency = Date.now() - self._heartbeatSentAt;
                    self._heartbeatSentAt = 0;
                }
                self._dispatch("latency", {latency: self.latency});
                return;
            }
            self._dispatch(frame.event, frame);
        };
        ws.onclose = function (event) {
            if (self._ws !== ws) return;
            self._ws = null;
            self._clearTimers();
            var wasConnected = self.connected;
            self.connected = false;
            if (self._closedByUser) {
                return;
            }
            // 4xxx codes are deliberate rejections by the server (session not found, replaced...)
            if (event.code >= 4000) {
                self._dispatch("rejected", {code: event.code, reason: event.reason});
                return;
            }
            if (wasConnected) {
                self._dispatch("disconnect", {code: event.code, reason: event.reason});
            }
            self._scheduleReconnect();
        };
        ws.onerror = function () {
            // The close event that follows carries the details.
        };
    };

    RemoteSlideSocket.prototype._scheduleReconnect = function () {
        var self = this;
        if (this._closedByUser || this._reconnectTimer) return;
        var delay = Math.min(RECONNECT_MAX, RECONNECT_MIN * Math.pow(2, this._attempt));
        delay += Math.floor(Math.random() * 500);
        this._attempt++;
        this._dispatch("reconnecting", {attempt: this._attempt, delay: delay});
        this._reconnectTimer = setTimeout(function () {
            self._reconnectTimer = null;
            if (!self._closedByUser) {
                self._open();
            }
        }, delay);
    };

    RemoteSlideSocket.prototype._startHeartbeat = function () {
        var self = this;
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(function () {
            if (!self._ws || !self.connected) return;
            if (Date.now() - self._lastHeartbeatReply > HEARTBEAT_TIMEOUT) {
                console.warn("[RemoteSlideSocket] heartbeat timed out, reconnecting");
                try {
                    self._ws.close(4000, "Heartbeat timed out");
                } catch (ignored) {
                }
                // Browsers may delay the close event on a dead connection; handle it ourselves.
                var ws = self._ws;
                self._ws = null;
                self._clearTimers();
                self.connected = false;
                ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
                self._dispatch("disconnect", {code: 4000, reason: "Heartbeat timed out"});
                self._scheduleReconnect();
                return;
            }
            self._heartbeatSentAt = Date.now();
            try {
                self._ws.send(HEARTBEAT_FRAME);
            } catch (ignored) {
            }
        }, HEARTBEAT_INTERVAL);
    };

    RemoteSlideSocket.prototype._clearTimers = function () {
        clearInterval(this._heartbeatTimer);
        clearTimeout(this._reconnectTimer);
        this._heartbeatTimer = null;
        this._reconnectTimer = null;
        this._heartbeatSentAt = 0;
    };

    RemoteSlideSocket.prototype._dispatch = function (event, data) {
        var list = this._handlers[event];
        if (!list) return;
        list.slice().forEach(function (handler) {
            try {
                handler(data);
            } catch (error) {
                console.error("[RemoteSlideSocket] handler for '" + event + "' failed", error);
            }
        });
    };

    root.RemoteSlideSocket = RemoteSlideSocket;
})(typeof window !== "undefined" ? window : this);
