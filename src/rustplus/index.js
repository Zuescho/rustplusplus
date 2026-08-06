/*
    Vendored fork of the rustplus.js library.

    Upstream: https://github.com/liamcottle/rustplus.js (MIT, (c) Liam Cottle)
    Previously consumed as `@liamcottle/rustplus.js` pinned to an
    alexemanuelol fork commit. It is vendored here so that:

      - the bot no longer depends on a git URL pointing at an unmaintained
        third-party fork (which blocked dependency bumps),
      - the protobuf schema can be kept in sync with the live Rust+ API
        (e.g. the TravelingVendor marker type), and
      - the websocket/protobuf layer can be hardened without patching
        node_modules.

    Behavioural changes vs upstream (all backwards compatible with the
    events/methods rustplusplus already relies on):

      - the .proto is parsed once per process instead of on every connect
        (reconnect loops were re-reading and re-compiling it every time),
      - inbound frames are decoded once instead of twice,
      - a malformed frame, or a throwing response callback, no longer takes
        the whole process down with an uncaught exception inside the `ws`
        message handler — it is surfaced as an `error` event instead,
      - a failed `protobuf.load` is surfaced as an `error` event instead of
        being swallowed by an unhandled promise rejection,
      - `sendRequestAsync` removes its callback when the request times out,
        so lost responses no longer leak entries in `seqCallbacks` forever,
      - `isConnected()` no longer throws when called before `connect()`.
*/

"use strict";

const Path = require('path');
const WebSocket = require('ws');
const Protobuf = require('protobufjs');
const { EventEmitter } = require('events');

const Camera = require('./camera.js');

const PROTO_PATH = Path.resolve(__dirname, 'rustplus.proto');

/* The schema is static — compile it once and share the result between every
   RustPlus instance (the bot can hold one instance per guild, plus a "lite"
   instance per team leader, and each of those reconnects on its own timer). */
let protoRootPromise = null;
function loadProtoRoot() {
    if (protoRootPromise === null) {
        protoRootPromise = Protobuf.load(PROTO_PATH).catch((e) => {
            /* Don't cache the failure — a transient FS error shouldn't
               permanently break every future reconnect attempt. */
            protoRootPromise = null;
            throw e;
        });
    }
    return protoRootPromise;
}

class RustPlus extends EventEmitter {

    /**
     * @param server The ip address or hostname of the Rust Server
     * @param port The port of the Rust Server (app.port in server.cfg)
     * @param playerId SteamId of the Player
     * @param playerToken Player Token from Server Pairing
     * @param useFacepunchProxy True to use secure websocket via Facepunch's proxy, or false to directly connect to
     *                          the Rust Server
     *
     * Events emitted by the RustPlus class instance
     * - connecting: When we are connecting to the Rust Server.
     * - connected: When we are connected to the Rust Server.
     * - message: When an AppMessage has been received from the Rust Server.
     * - request: When an AppRequest has been sent to the Rust Server.
     * - disconnected: When we are disconnected from the Rust Server.
     * - error: When something goes wrong.
     */
    constructor(server, port, playerId, playerToken, useFacepunchProxy = false) {
        super();

        this.server = server;
        this.port = port;
        this.playerId = playerId;
        this.playerToken = playerToken;
        this.useFacepunchProxy = useFacepunchProxy;

        this.websocket = null;
        this.seq = 0;
        this.seqCallbacks = [];
    }

    /**
     * This sets everything up and then connects to the Rust Server via WebSocket.
     */
    connect() {
        loadProtoRoot().then((root) => {
            /* Make sure an existing connection is disconnected before connecting again. */
            if (this.websocket) {
                this.disconnect();
            }

            /* Load proto types. */
            this.AppRequest = root.lookupType("rustplus.AppRequest");
            this.AppMessage = root.lookupType("rustplus.AppMessage");

            /* Fire event as we are connecting. */
            this.emit('connecting');

            const address = this.useFacepunchProxy ?
                `wss://companion-rust.facepunch.com/game/${this.server}/${this.port}` :
                `ws://${this.server}:${this.port}`;

            const websocket = new WebSocket(address);
            this.websocket = websocket;

            websocket.on('open', () => {
                this.emit('connected');
            });

            websocket.on('error', (e) => {
                this.emit('error', e);
            });

            websocket.on('message', (data) => {
                let message;
                try {
                    message = this.AppMessage.decode(data);
                }
                catch (e) {
                    /* A frame we can't parse must not escape as an uncaught
                       exception from the ws callback — that would take the
                       whole bot down. */
                    this.emit('error', e);
                    return;
                }

                /* Check if the received message is a response we have a callback registered for. */
                const seq = message.response ? message.response.seq : null;
                if (seq && this.seqCallbacks[seq]) {
                    const callback = this.seqCallbacks[seq];
                    delete this.seqCallbacks[seq];

                    let result;
                    try {
                        result = callback(message);
                    }
                    catch (e) {
                        this.emit('error', e);
                        return;
                    }

                    /* If the callback returns true, don't fire the message event. */
                    if (result) return;
                }

                this.emit('message', message);
            });

            websocket.on('close', () => {
                this.emit('disconnected');
            });
        }).catch((e) => {
            /* Previously an unhandled promise rejection: the caller had no way
               of knowing the connection attempt never even started. */
            this.emit('error', e);
        });
    }

    /**
     * Disconnect from the Rust Server.
     */
    disconnect() {
        if (this.websocket) {
            this.websocket.terminate();
            this.websocket = null;
        }
        /* Any request still waiting on a response will never get one. The
           pending `sendRequestAsync` promises still reject via their own
           timeout (callers depend on that specific error), we just stop
           holding on to the closures. */
        this.seqCallbacks = [];
    }

    /**
     * Check if RustPlus is connected to the server.
     * @returns {boolean}
     */
    isConnected() {
        return this.websocket !== null && this.websocket !== undefined &&
            this.websocket.readyState === WebSocket.OPEN;
    }

    /**
     * Send a Request to the Rust Server with an optional callback when a Response is received.
     * @param data this should contain valid data for the AppRequest packet in the rustplus.proto schema file
     * @param callback
     * @returns {number} the sequence number the request was sent with
     */
    sendRequest(data, callback) {
        if (!this.websocket || !this.AppRequest) {
            throw new Error('Not connected to the Rust server');
        }

        /* Increment sequence number. */
        const currentSeq = ++this.seq;

        /* Save callback if provided. */
        if (callback) {
            this.seqCallbacks[currentSeq] = callback;
        }

        /* Create protobuf from AppRequest packet. */
        const request = this.AppRequest.fromObject({
            seq: currentSeq,
            playerId: this.playerId,
            playerToken: this.playerToken,
            ...data, /* Merge in provided data for AppRequest. */
        });

        try {
            this.websocket.send(this.AppRequest.encode(request).finish());
        }
        catch (e) {
            delete this.seqCallbacks[currentSeq];
            throw e;
        }

        /* Fire event when request has been sent, this is useful for logging. */
        this.emit('request', request);

        return currentSeq;
    }

    /**
     * Send a Request to the Rust Server and return a Promise
     * @param data this should contain valid data for the AppRequest packet defined in the rustplus.proto schema file
     * @param timeoutMilliseconds milliseconds before the promise will be rejected. Defaults to 10 seconds.
     */
    sendRequestAsync(data, timeoutMilliseconds = 10000) {
        return new Promise((resolve, reject) => {
            let seq = null;

            const timeout = setTimeout(() => {
                /* Drop the orphaned callback — without this, a response that
                   never arrives leaks its closure for the lifetime of the
                   connection. */
                if (seq !== null) delete this.seqCallbacks[seq];
                reject(new Error('Timeout reached while waiting for response'));
            }, timeoutMilliseconds);

            try {
                seq = this.sendRequest(data, (message) => {
                    clearTimeout(timeout);

                    if (message.response.error) {
                        /* Reject promise if server returns an AppError for this request. */
                        reject(message.response.error);
                    }
                    else {
                        resolve(message.response);
                    }
                });
            }
            catch (e) {
                clearTimeout(timeout);
                reject(e);
            }
        });
    }

    /**
     * Send a Request to the Rust Server to set the Entity Value.
     * @param entityId the entity id to set the value for
     * @param value the value to set on the entity
     * @param callback
     */
    setEntityValue(entityId, value, callback) {
        this.sendRequest({
            entityId: entityId,
            setEntityValue: {
                value: value,
            },
        }, callback);
    }

    /**
     * Turn a Smart Switch On
     * @param entityId the entity id of the smart switch to turn on
     * @param callback
     */
    turnSmartSwitchOn(entityId, callback) {
        this.setEntityValue(entityId, true, callback);
    }

    /**
     * Turn a Smart Switch Off
     * @param entityId the entity id of the smart switch to turn off
     * @param callback
     */
    turnSmartSwitchOff(entityId, callback) {
        this.setEntityValue(entityId, false, callback);
    }

    /**
     * Quickly turn on and off a Smart Switch as if it were a Strobe Light.
     * You will get rate limited by the Rust Server after a short period.
     */
    strobe(entityId, timeoutMilliseconds = 100, value = true) {
        this.setEntityValue(entityId, value);
        setTimeout(() => {
            this.strobe(entityId, timeoutMilliseconds, !value);
        }, timeoutMilliseconds);
    }

    /**
     * Send a message to Team Chat
     * @param message the message to send to team chat
     * @param callback
     */
    sendTeamMessage(message, callback) {
        this.sendRequest({
            sendTeamMessage: {
                message: message,
            },
        }, callback);
    }

    /**
     * Get info for an Entity
     * @param entityId the id of the entity to get info of
     * @param callback
     */
    getEntityInfo(entityId, callback) {
        this.sendRequest({
            entityId: entityId,
            getEntityInfo: {},
        }, callback);
    }

    /**
     * Get the Map
     */
    getMap(callback) {
        this.sendRequest({
            getMap: {},
        }, callback);
    }

    /**
     * Get the ingame time
     */
    getTime(callback) {
        this.sendRequest({
            getTime: {},
        }, callback);
    }

    /**
     * Get all map markers
     */
    getMapMarkers(callback) {
        this.sendRequest({
            getMapMarkers: {},
        }, callback);
    }

    /**
     * Get the server info
     */
    getInfo(callback) {
        this.sendRequest({
            getInfo: {},
        }, callback);
    }

    /**
     * Get team info
     */
    getTeamInfo(callback) {
        this.sendRequest({
            getTeamInfo: {},
        }, callback);
    }

    /**
     * Subscribes to a Camera
     * @param identifier Camera Identifier, such as OILRIG1 (or custom name)
     * @param callback
     */
    subscribeToCamera(identifier, callback) {
        this.sendRequest({
            cameraSubscribe: {
                cameraId: identifier,
            },
        }, callback);
    }

    /**
     * Unsubscribes from a Camera
     * @param callback
     */
    unsubscribeFromCamera(callback) {
        this.sendRequest({
            cameraUnsubscribe: {},
        }, callback);
    }

    /**
     * Sends camera input to the server (mouse movement)
     * @param buttons The buttons that are currently pressed
     * @param x The x delta of the mouse movement
     * @param y The y delta of the mouse movement
     * @param callback
     */
    sendCameraInput(buttons, x, y, callback) {
        this.sendRequest({
            cameraInput: {
                buttons: buttons,
                mouseDelta: {
                    x: x,
                    y: y,
                },
            },
        }, callback);
    }

    /**
     * Get a camera instance for controlling CCTV Cameras, PTZ Cameras and Auto Turrets
     * @param identifier Camera Identifier, such as DOME1, OILRIG1L1, (or a custom camera id)
     * @returns {Camera}
     */
    getCamera(identifier) {
        return new Camera(this, identifier);
    }

}

module.exports = RustPlus;
