/*
    Copyright (C) 2022 Alexander Emanuelsson (alexemanuelol)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

*/

const Fs = require('fs');
const Path = require('path');
const RustPlusLib = require('@liamcottle/rustplus.js');
const Translate = require('translate');

const Client = require('../../index.ts');
const Constants = require('../util/constants.js');
const Decay = require('../util/decay.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const InGameChatHandler = require('../handlers/inGameChatHandler.js');
const InstanceUtils = require('../util/instanceUtils.js');
const Languages = require('../util/languages.js');
const Logger = require('./Logger.js');
const Map = require('../util/map.js');
const RustPlusLite = require('../structures/RustPlusLite');
const TeamHandler = require('../handlers/teamHandler.js');
const Timer = require('../util/timer.js');

const TOKENS_LIMIT = 24;        /* Per player */
const TOKENS_REPLENISH = 3;     /* Per second */

class RustPlus extends RustPlusLib {
    constructor(guildId, serverIp, appPort, steamId, playerToken) {
        super(serverIp, appPort, steamId, playerToken);

        this.serverId = `${this.server}-${this.port}`;
        this.guildId = guildId;

        this.leaderRustPlusInstance = null;
        this.uptimeServer = null;

        /* Status flags */
        this.isOperational = false;         /* Connected to the server, and request is verified. */
        this.isDeleted = false;             /* Is the rustplus instance deleted? */
        this.isNewConnection = false;       /* Is it an actively selected connection (pressed CONNECT button)? */
        this.isFirstPoll = true;            /* Is this the first poll since connection started? */

        /* Interval ids */
        this.pollingTaskId = 0;             /* The id of the main polling mechanism of the rustplus instance. */
        this.tokensReplenishTaskId = 0;     /* The id of the replenish task for rustplus tokens. */

        /* Other variable initializations */
        this.tokens = 24;                           /* The amount of tokens that is available at start. */
        this.timers = new Object();                 /* Stores all custom timers that are created. */
        this.markers = new Object();                /* Stores all custom markers that are created. */
        this.storageMonitors = new Object();        /* Contain content information of paired storage monitors. */
        this.currentSwitchTimeouts = new Object();  /* Stores timer ids for auto ON/OFF Smart Switch timeouts. */
        this.passedFirstSunriseOrSunset = false;    /* Becomes true when first sunrise/sunset. */
        this.startTimeObject = new Object();        /* Stores in-game time points before first sunrise/sunset. */
        this.informationIntervalCounter = 0;        /* Counter to decide when information should be updated. */
        this.storageMonitorIntervalCounter = 0;     /* Counter to decide when storage monitors should be updated */
        this.smartSwitchIntervalCounter = 10;       /* Counter to decide when smart switches should be updated */
        this.smartAlarmIntervalCounter = 20;        /* Counter to decide when smart alarms should be updated */
        this.interactionSwitches = [];              /* Stores the ids of smart switches that are interacted in-game. */
        this.messagesSentByBot = [];                /* Stores the last messages sent by the bot to the team chat */

        /* Chat handler variables */
        this.inGameChatQueue = [];
        this.inGameChatTimeout = null;

        this.allConnections = [];
        this.playerConnections = new Object();
        this.allDeaths = [];
        this.playerDeaths = new Object();
        this.events = {
            all: [],
            cargo: [],
            heli: [],
            small: [],
            large: [],
            chinook: [],
            travelingVendor: [],
            deepSea: []
        };
        this.patrolHelicopterTracers = new Object();
        this.cargoShipTracers = new Object();

        /* Rustplus structures */
        this.map = null;            /* Stores the Map structure. */
        this.info = null;           /* Stores the Info structure. */
        this.time = null;           /* Stores the Time structure. */
        this.team = null;           /* Stores the Team structure. */
        this.mapMarkers = null;     /* Stores the MapMarkers structure. */

        this.loadRustPlusEvents();
    }

    loadRustPlusEvents() {
        const eventFiles = Fs.readdirSync(
            Path.join(__dirname, '..', 'rustplusEvents')).filter(file => file.endsWith('.js'));
        for (const file of eventFiles) {
            const event = require(`../rustplusEvents/${file}`);
            this.on(event.name, (...args) => event.execute(this, Client.client, ...args));
        }
    }

    loadMarkers() {
        const instance = Client.client.getInstance(this.guildId);

        for (const [name, location] of Object.entries(instance.serverList[this.serverId].markers)) {
            this.markers[name] = { x: location.x, y: location.y, location: location.location };
        }
    }

    build() {
        const instance = Client.client.getInstance(this.guildId);

        /* Setup the logger */
        this.logger = new Logger(Path.join(__dirname, '..', '..', `logs/${this.guildId}.log`), 'guild');
        this.logger.setGuildId(this.guildId);
        this.logger.serverName = instance.serverList[this.serverId].title;

        /* Setup settings */
        this.generalSettings = instance.generalSettings;
        this.notificationSettings = instance.notificationSettings;

        this.connect();
    }

    updateLeaderRustPlusLiteInstance() {
        if (this.leaderRustPlusInstance !== null) {
            if (Client.client.rustplusLiteReconnectTimers[this.guildId]) {
                clearTimeout(Client.client.rustplusLiteReconnectTimers[this.guildId]);
                Client.client.rustplusLiteReconnectTimers[this.guildId] = null;
            }
            this.leaderRustPlusInstance.isActive = false;
            this.leaderRustPlusInstance.disconnect();
            this.leaderRustPlusInstance = null;
        }

        const instance = Client.client.getInstance(this.guildId);
        const leader = this.team.leaderSteamId;
        if (leader === this.playerId) return;
        if (!(leader in instance.serverListLite[this.serverId])) return;
        const serverLite = instance.serverListLite[this.serverId][leader];

        this.leaderRustPlusInstance = new RustPlusLite(
            this.guildId,
            this.logger,
            this,
            serverLite.serverIp,
            serverLite.appPort,
            serverLite.steamId,
            serverLite.playerToken
        );
        this.leaderRustPlusInstance.connect();
    }

    isServerAvailable() {
        const instance = Client.client.getInstance(this.guildId);
        return instance.serverList.hasOwnProperty(this.serverId);
    }

    updateConnections(steamId, str) {
        const time = Timer.getCurrentDateTime();
        const savedString = `${time} - ${str}`;

        if (this.allConnections.length >= 10) {
            this.allConnections.pop();
        }
        this.allConnections.unshift(savedString)

        if (!this.playerConnections.hasOwnProperty(steamId)) {
            this.playerConnections[steamId] = [];
        }

        if (this.playerConnections[steamId].length >= 10) {
            this.playerConnections[steamId].pop();
        }
        this.playerConnections[steamId].unshift(savedString);
    }

    updateDeaths(steamId, data) {
        const time = Timer.getCurrentDateTime();
        data['time'] = time;

        if (this.allDeaths.length >= 10) {
            this.allDeaths.pop();
        }
        this.allDeaths.unshift(data)

        if (!this.playerDeaths.hasOwnProperty(steamId)) {
            this.playerDeaths[steamId] = [];
        }

        if (this.playerDeaths[steamId].length >= 10) {
            this.playerDeaths[steamId].pop();
        }
        this.playerDeaths[steamId].unshift(data);
    }

    updateEvents(event, message) {
        const eventAliases = {
            vendor: 'travelingVendor'
        };
        const eventKey = eventAliases[event] || event;
        const supportedEvents = ['cargo', 'heli', 'small', 'large', 'chinook', 'travelingVendor', 'deepSea'];
        if (!supportedEvents.includes(eventKey)) return;

        const str = `${Timer.getCurrentDateTime()} - ${message}`;

        if (this.events['all'].length >= 10) {
            this.events['all'].pop();
        }
        this.events['all'].unshift(str);

        if (this.events[eventKey].length >= 10) {
            this.events[eventKey].pop();
        }
        this.events[eventKey].unshift(str);
    }

    updateBotMessages(message) {
        if (this.messagesSentByBot.length >= Constants.BOT_MESSAGE_HISTORY_LIMIT) {
            this.messagesSentByBot.pop();
        }
        this.messagesSentByBot.unshift(message);
    }

    deleteThisRustplusInstance() {
        this.isDeleted = true;
        this.disconnect();

        if (Client.client.rustplusInstances.hasOwnProperty(this.guildId)) {
            if (Client.client.rustplusInstances[this.guildId].serverId === this.serverId) {
                delete Client.client.rustplusInstances[this.guildId];
                return true;
            }
        }
        return false;
    }

    log(title, text, level = 'info') {
        this.logger.log(title, text, level);
    }

    logInGameCommand(type = 'Default', message) {
        const args = new Object();
        args['type'] = type;
        args['command'] = message.broadcast.teamMessage.message.message;
        args['user'] = `${message.broadcast.teamMessage.message.name}`;
        args['user'] += ` (${message.broadcast.teamMessage.message.steamId.toString()})`;

        this.log(Client.client.intlGet(null, 'infoCap'), Client.client.intlGet(null, `logInGameCommand`, args));
    }

    sendInGameMessage(message, force = false) {
        InGameChatHandler.inGameChatHandler(this, Client.client, message, force);
    }

    async sendEvent(setting, text, event, embed_color, firstPoll = false, image = null) {
        const img = (image !== null) ? image : setting.image;

        this.updateEvents(event, text);

        if (!firstPoll && setting.discord) {
            await DiscordMessages.sendDiscordEventMessage(this.guildId, this.serverId, text, img, embed_color);
        }
        if (!firstPoll && setting.inGame) {
            await this.sendInGameMessage(`${text}`);
        }
        this.log(Client.client.intlGet(null, 'eventCap'), text);
    }

    replenishTokens() {
        this.tokens += TOKENS_REPLENISH;
        if (this.tokens > TOKENS_LIMIT) this.tokens = TOKENS_LIMIT;
    }

    async waitForAvailableTokens(cost) {
        let timeoutCounter = 0;
        while (this.tokens < cost) {
            if (timeoutCounter === 90) return false;

            await Timer.sleep(1000 / 3);
            timeoutCounter += 1;
        }
        this.tokens -= cost;
        return true;
    }

    async turnSmartSwitchAsync(id, value, timeout = 10000) {
        if (value) {
            return await this.turnSmartSwitchOnAsync(id, timeout);
        }
        else {
            return await this.turnSmartSwitchOffAsync(id, timeout);
        }
    }

    async turnSmartSwitchOnAsync(id, timeout = 10000) {
        try {
            return await this.setEntityValueAsync(id, true, timeout);
        }
        catch (e) {
            return e;
        }
    }

    async turnSmartSwitchOffAsync(id, timeout = 10000) {
        try {
            return await this.setEntityValueAsync(id, false, timeout);
        }
        catch (e) {
            return e;
        }
    }

    async setEntityValueAsync(id, value, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                setEntityValue: {
                    value: value
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async sendTeamMessageAsync(message, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(2))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                sendTeamMessage: {
                    message: message
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getEntityInfoAsync(id, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                getEntityInfo: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getMapAsync(timeout = 30000) {
        try {
            if (!(await this.waitForAvailableTokens(5))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getMap: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getTimeAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getTime: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getMapMarkersAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getMapMarkers: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getInfoAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getInfo: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getTeamInfoAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getTeamInfo: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async subscribeToCameraAsync(identifier, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                cameraSubscribe: {
                    cameraId: identifier
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async unsubscribeFromCameraAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                cameraUnsubscribe: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async sendCameraInputAsync(buttons, x, y, timeout = 1000) {
        try {
            if (!(await this.waitForAvailableTokens(0.01))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                cameraInput: {
                    buttons: buttons,
                    mouseDelta: {
                        x: x,
                        y: y
                    }
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async promoteToLeaderAsync(steamId, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                promoteToLeader: {
                    steamId: steamId
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getTeamChatAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getTeamChat: {}
            }, timeout).catch((e) => {
                return e;
            })
        }
        catch (e) {
            return e;
        }
    }

    async checkSubscriptionAsync(id, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                checkSubscription: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async setSubscriptionAsync(id, value, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                setSubscription: {
                    value: value
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getCameraFrameAsync(identifier, frame, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(2))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getCameraFrame: {
                    identifier: identifier,
                    frame: frame
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async isResponseValid(response) {
        if (response === undefined) {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseIsUndefined'), 'error');
            return false;
        }
        else if (response.toString() === 'Error: Timeout reached while waiting for response') {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseTimeout'), 'error');
            return false;
        }
        else if (response.hasOwnProperty('error')) {
            this.log(Client.client.intlGet(null, 'errorCap'), Client.client.intlGet(null, 'responseContainError', {
                error: response.error
            }), 'error');
            return false;
        }
        else if (Object.keys(response).length === 0) {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseIsEmpty'), 'error');
            clearInterval(this.pollingTaskId);
            return false;
        }
        return true;
    }

    /* Commands */

    getCommandAfk() {
        let string = '';
        for (const player of this.team.players) {
            if (player.isOnline) {
                if (player.getAfkSeconds() >= Constants.AFK_TIME_SECONDS) {
                    string += `${player.name} [${player.getAfkTime('dhs')}], `;
                }
            }
        }

        return string !== '' ? `${string.slice(0, -2)}.` : Client.client.intlGet(this.guildId, 'noOneIsAfk');
    }

    getCommandAlive(command) {
        const prefix = this.generalSettings.prefix;
        const commandAlive = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxAlive')}`;
        const commandAliveEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxAlive')}`;
        let name = null;

        if (command.toLowerCase() === `${commandAlive}` || command.toLowerCase() === `${commandAliveEn}`) {
            const player = this.team.getPlayerLongestAlive();
            return Client.client.intlGet(this.guildId, 'hasBeenAliveLongest', {
                name: player.name,
                time: player.getAliveTime()
            });
        }
        else if (command.toLowerCase().startsWith(`${commandAlive} `)) {
            name = command.slice(`${commandAlive} `.length).trim();
        }
        else if (command.toLowerCase().startsWith(`${commandAliveEn} `)) {
            name = command.slice(`${commandAliveEn} `.length).trim();
        }

        if (name === null) return null;

        for (const player of this.team.players) {
            if (player.name.includes(name)) {
                return Client.client.intlGet(this.guildId, 'playerHasBeenAliveFor', {
                    name: player.name,
                    time: player.getAliveTime()
                });
            }
        }

        return Client.client.intlGet(this.guildId, 'couldNotFindTeammate', {
            name: name
        });
    }

    /* ============================================================
       In-game !cargo command helpers (added in v1.27)
       Slim port of FaiThiX 421aa27: keeps the default `!cargo` summary
       and `!cargo timer`, drops the verbose `!cargo status` subcommand.
       ============================================================ */

    finalizeCargoCommandMessages(messages) {
        if (!Array.isArray(messages)) return messages;
        const filtered = messages.filter(m => typeof m === 'string' && m !== '');
        if (filtered.length === 0) return null;
        return filtered.length === 1 ? filtered[0] : filtered;
    }

    getCargoCommandActiveShips() {
        if (!this.mapMarkers || !Array.isArray(this.mapMarkers.cargoShips)) return [];
        return this.mapMarkers.cargoShips.filter(s => s?.location?.string);
    }

    getCargoCommandRemainingMsFromTimer(timer) {
        if (!timer || typeof timer.getStateRunning !== 'function' || !timer.getStateRunning()) return null;
        const ms = timer.getTimeLeft();
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    }

    getCargoCommandRemainingMsFromEndAt(endAtMs) {
        const parsed = Number(endAtMs);
        if (!Number.isFinite(parsed)) return null;
        const ms = Math.floor(parsed - Date.now());
        return ms > 0 ? ms : null;
    }

    getCargoCommandStatusText(cargoShip, cargoShipMeta) {
        if (cargoShip?.onItsWayOut || cargoShipMeta?.isLeaving === true) {
            return Client.client.intlGet(this.guildId, 'cargoInGameStatusLeaving');
        }
        switch (cargoShipMeta?.dockingStatus) {
            case 'docking': return Client.client.intlGet(this.guildId, 'cargoInGameStatusDocking');
            case 'docked': return Client.client.intlGet(this.guildId, 'cargoInGameStatusDocked');
            case 'undocking': return Client.client.intlGet(this.guildId, 'cargoInGameStatusUndocking');
            default: return Client.client.intlGet(this.guildId, 'cargoInGameStatusSailing');
        }
    }

    getCargoCommandTimerEntries(id) {
        if (!this.mapMarkers) return [];
        const cargoShip = this.mapMarkers.getMarkerByTypeId(this.mapMarkers.types.CargoShip, id);
        if (!cargoShip?.location?.string) return [];

        const entries = [];
        const push = (type, remainingMs) => {
            if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
            entries.push({ cargoShipId: id, location: cargoShip.location.string, remainingMs, type });
        };

        push('lockedCrate', this.getCargoCommandRemainingMsFromEndAt(
            this.mapMarkers.cargoShipLockedCrateNextSpawnTimes?.[id]));
        push('noLockedCratesLeft', this.getCargoCommandRemainingMsFromTimer(
            this.mapMarkers.cargoShipEgressAfterHarbor1Timers?.[id]));
        push('undockingSoon', this.getCargoCommandRemainingMsFromEndAt(
            this.mapMarkers.cargoShipUndockingNotificationEndTimes?.[id]));
        push('egress', this.getCargoCommandRemainingMsFromTimer(
            this.mapMarkers.cargoShipEgressTimers?.[id]));
        push('leavesMap', this.getCargoCommandRemainingMsFromTimer(
            this.mapMarkers.cargoShipEgressAfterHarbor2Timers?.[id]));

        entries.sort((a, b) => a.remainingMs - b.remainingMs);
        return entries;
    }

    getCargoCommandPrimaryTimerEntry(id) {
        const entries = this.getCargoCommandTimerEntries(id);
        const priority = ['leavesMap', 'undockingSoon', 'lockedCrate', 'egress'];
        for (const type of priority) {
            const entry = entries.find(e => e.type === type);
            if (entry) return entry;
        }
        return null;
    }

    getCargoCommandSummaryLine(cargoShip) {
        const meta = this.mapMarkers.getCargoShipMetaData(cargoShip.id);
        const status = this.getCargoCommandStatusText(cargoShip, meta);
        const primary = this.getCargoCommandPrimaryTimerEntry(cargoShip.id);

        if (!primary) {
            return Client.client.intlGet(this.guildId, 'cargoInGameSummaryNoEta', {
                location: cargoShip.location.string, status
            });
        }
        const time = Timer.secondsToFullScale(primary.remainingMs / 1000);

        switch (primary.type) {
            case 'leavesMap':
                return Client.client.intlGet(this.guildId,
                    meta?.isDepartureCertain === false
                        ? 'cargoInGameSummaryMayLeaveMap'
                        : 'cargoInGameSummaryLeavesMap',
                    { location: cargoShip.location.string, status, time });
            case 'undockingSoon':
                return Client.client.intlGet(this.guildId, 'cargoInGameSummaryUndockingSoon', {
                    location: cargoShip.location.string, status, time
                });
            case 'lockedCrate':
                return Client.client.intlGet(this.guildId, 'cargoInGameSummaryLockedCrate', {
                    location: cargoShip.location.string, status, time
                });
            case 'egress':
                return Client.client.intlGet(this.guildId, 'cargoInGameSummaryEgress', {
                    location: cargoShip.location.string, status, time
                });
            default:
                return Client.client.intlGet(this.guildId, 'cargoInGameSummaryNoEta', {
                    location: cargoShip.location.string, status
                });
        }
    }

    getCargoCommandTimerText(entry) {
        const args = {
            location: entry.location,
            time: Timer.secondsToFullScale(entry.remainingMs / 1000)
        };
        switch (entry.type) {
            case 'lockedCrate': return Client.client.intlGet(this.guildId, 'cargoInGameTimerLockedCrate', args);
            case 'noLockedCratesLeft': return Client.client.intlGet(this.guildId, 'cargoInGameTimerNoLockedCratesLeft', args);
            case 'undockingSoon': return Client.client.intlGet(this.guildId, 'cargoInGameTimerUndockingSoon', args);
            case 'egress': return Client.client.intlGet(this.guildId, 'cargoInGameTimerEgress', args);
            case 'leavesMap': return Client.client.intlGet(this.guildId, 'cargoInGameTimerLeavesMap', args);
            default: return null;
        }
    }

    getInGameCargoSummary() {
        const ships = this.getCargoCommandActiveShips();
        if (ships.length === 0) return this.getCommandCargo();
        return this.finalizeCargoCommandMessages(
            ships.map(s => this.getCargoCommandSummaryLine(s)));
    }

    getInGameCargoTimers() {
        const ships = this.getCargoCommandActiveShips();
        if (ships.length === 0) return this.getCommandCargo();
        const entries = [];
        for (const s of ships) entries.push(...this.getCargoCommandTimerEntries(s.id));
        if (entries.length === 0) return this.getInGameCargoSummary();
        entries.sort((a, b) => a.remainingMs - b.remainingMs);
        return this.finalizeCargoCommandMessages(entries.map(e => this.getCargoCommandTimerText(e)));
    }

    getInGameCommandCargo(command) {
        const prefix = this.generalSettings.prefix;
        const cmd = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxCargo')}`.toLowerCase();
        const cmdEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxCargo')}`.toLowerCase();
        const timer = `${Client.client.intlGet(this.guildId, 'commandSyntaxTimer')}`.toLowerCase();
        const timerEn = `${Client.client.intlGet('en', 'commandSyntaxTimer')}`.toLowerCase();

        let rest = command.toLowerCase().trim();
        if (rest.startsWith(`${cmd} `)) rest = rest.slice(cmd.length + 1).trim();
        else if (rest === cmd) rest = '';
        else if (rest.startsWith(`${cmdEn} `)) rest = rest.slice(cmdEn.length + 1).trim();
        else if (rest === cmdEn) rest = '';
        else return this.getCommandCargo();

        if (rest === '') return this.getInGameCargoSummary();

        const sub = rest.replace(/ .*/, '');
        if (sub === timer || sub === timerEn) return this.getInGameCargoTimers();
        /* Any other subcommand (including the upstream `status`) falls back
           to the default summary so users typing the old wording still get a useful reply. */
        return this.getInGameCargoSummary();
    }

    getCommandCargo(isInfoChannel = false) {
        const strings = [];
        const handled = new Set();
        /* Prefer the post-harbor timers (these fire when we know the ship has
           already finished its harbor rounds and is about to head off-map). */
        const pushCargoTimerString = (timerCollection, infoTextId, textId) => {
            for (const [id, timer] of Object.entries(timerCollection)) {
                const cargoShip = this.mapMarkers.getMarkerByTypeId(this.mapMarkers.types.CargoShip, parseInt(id));
                if (!cargoShip) continue;
                const time = Timer.getTimeLeftOfTimer(timer);
                if (!time) continue;

                handled.add(parseInt(id));
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, infoTextId, {
                        time: Timer.getTimeLeftOfTimer(timer, 's'),
                        location: cargoShip.location.string
                    });
                }
                strings.push(Client.client.intlGet(this.guildId, textId, {
                    time: time, location: cargoShip.location.string
                }));
            }
            return null;
        };

        const afterHarbor1Info = pushCargoTimerString(
            this.mapMarkers.cargoShipEgressAfterHarbor1Timers,
            'cargoLeavesInTime', 'timeBeforeCargoLeavesMap');
        if (afterHarbor1Info !== null) return afterHarbor1Info;

        const afterHarbor2Info = pushCargoTimerString(
            this.mapMarkers.cargoShipEgressAfterHarbor2Timers,
            'cargoLeavesInTime', 'timeBeforeCargoLeavesMap');
        if (afterHarbor2Info !== null) return afterHarbor2Info;

        for (const [id, timer] of Object.entries(this.mapMarkers.cargoShipEgressTimers)) {
            if (handled.has(parseInt(id))) continue;
            const cargoShip = this.mapMarkers.getMarkerByTypeId(this.mapMarkers.types.CargoShip, parseInt(id));
            if (!cargoShip) continue;
            const time = Timer.getTimeLeftOfTimer(timer);
            if (time) {
                handled.add(parseInt(id));
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'egressInTime', {
                        time: Timer.getTimeLeftOfTimer(timer, 's'),
                        location: cargoShip.location.string
                    });
                }
                strings.push(Client.client.intlGet(this.guildId, 'timeBeforeCargoEntersEgress', {
                    time: time, location: cargoShip.location.string
                }));
            }
        }

        let unhandled = this.mapMarkers.cargoShips.map(e => e.id).filter(id => !handled.has(id));

        if (unhandled.length > 0) {
            for (const id of unhandled) {
                const cargoShip = this.mapMarkers.getMarkerByTypeId(this.mapMarkers.types.CargoShip, id);
                const cargoShipMeta = this.mapMarkers.cargoShipMetaData[id];
                if (cargoShip.onItsWayOut || cargoShipMeta?.isLeaving === true) {
                    if (isInfoChannel) {
                        return Client.client.intlGet(this.guildId, 'leavingMapAt', {
                            location: cargoShip.location.string
                        });
                    }
                    strings.push(Client.client.intlGet(this.guildId, 'cargoLeavingMapAt', {
                        location: cargoShip.location.string
                    }));
                }
                else {
                    if (isInfoChannel) {
                        return Client.client.intlGet(this.guildId, 'cargoAt', {
                            location: cargoShip.location.string
                        });
                    }
                    strings.push(Client.client.intlGet(this.guildId, 'cargoLocatedAt', {
                        location: cargoShip.location.string
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceCargoShipWasOut === null) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'notActive');;
                }
                else {
                    return Client.client.intlGet(this.guildId, 'cargoNotCurrentlyOnMap');
                }
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceCargoShipWasOut) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'timeSinceCargoLeft', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
            }
        }

        return strings;
    }

    getCommandChinook(isInfoChannel = false) {
        const strings = [];
        for (const ch47 of this.mapMarkers.ch47s) {
            if (ch47.ch47Type === 'crate') {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'atLocation', {
                        location: ch47.location.string
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'chinook47Located', {
                        location: ch47.location.string
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceCH47WasOut === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                    Client.client.intlGet(this.guildId, 'chinook47NotOnMap');
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceCH47WasOut) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: Timer.secondsToFullScale(secondsSince, 's')
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeSinceChinook47OnMap', {
                        time: Timer.secondsToFullScale(secondsSince)
                    }));
                }
            }
        }

        return strings;
    }

    getCommandConnection(command) {
        const prefix = this.generalSettings.prefix;
        const commandConnection = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxConnection')}`;
        const commandConnectionEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxConnection')}`;
        const commandConnections = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxConnections')}`;
        const commandConnectionsEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxConnections')}`;

        if (command.toLowerCase().startsWith(`${commandConnections}`) ||
            command.toLowerCase().startsWith(`${commandConnectionsEn}`)) {
            let number = null;
            if (command.toLowerCase().startsWith(`${commandConnections}`)) {
                number = parseInt(command.slice(`${commandConnections}`.length).trim());
            }
            else {
                number = parseInt(command.slice(`${commandConnectionsEn}`.length).trim());
            }

            if (this.allConnections.length === 0) {
                return Client.client.intlGet(this.guildId, 'noRegisteredConnectionEvents');
            }

            const strings = [];
            let counter = 1;
            for (const event of this.allConnections) {
                if (counter === 6) break;
                if (number === counter) return event;

                strings.push(event);
                counter += 1;
            }

            return strings;
        }
        else if (command.toLowerCase().startsWith(`${commandConnection} `) ||
            command.toLowerCase().startsWith(`${commandConnectionEn} `)) {
            if (command.toLowerCase().startsWith(`${commandConnection} `)) {
                command = command.slice(`${commandConnection} `.length).trim();
            }
            else {
                command = command.slice(`${commandConnectionEn} `.length).trim();
            }
            const name = command.replace(/ .*/, '');
            const number = parseInt(command.slice(name.length + 1));

            for (const player of this.team.players) {
                if (player.name.includes(name)) {
                    if (!this.playerConnections.hasOwnProperty(player.steamId)) {
                        this.playerConnections[player.steamId] = [];
                    }

                    if (this.playerConnections[player.steamId].length === 0) {
                        return Client.client.intlGet(this.guildId, 'noRegisteredConnectionEventsUser', {
                            user: player.name
                        });
                    }

                    const strings = [];
                    let counter = 1;
                    for (const event of this.playerConnections[player.steamId]) {
                        if (counter === 6) break;
                        if (number === counter) return event;

                        strings.push(event);
                        counter += 1;
                    }

                    return strings;
                }
            }

            return Client.client.intlGet(this.guildId, 'couldNotFindTeammate', {
                name: name
            });
        }

        return null;
    }

    async getCommandDeath(command, callerSteamId) {
        const prefix = this.generalSettings.prefix;
        const commandDeath = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxDeath')}`;
        const commandDeathEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxDeath')}`;
        const commandDeaths = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxDeaths')}`;
        const commandDeathsEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxDeaths')}`;

        const teamInfo = await this.getTeamInfoAsync();
        if (!(await this.isResponseValid(teamInfo))) return null;
        TeamHandler.handler(this, Client.client, teamInfo.teamInfo);
        this.team.updateTeam(teamInfo.teamInfo);

        const caller = this.team.getPlayer(callerSteamId);

        if (command.toLowerCase().startsWith(`${commandDeaths}`) ||
            command.toLowerCase().startsWith(`${commandDeathsEn}`)) {
            let number = null;
            if (command.toLowerCase().startsWith(`${commandDeaths}`)) {
                number = parseInt(command.slice(`${commandDeaths}`.length).trim());
            }
            else {
                number = parseInt(command.slice(`${commandDeathsEn}`.length).trim());
            }

            if (this.allDeaths.length === 0) {
                return Client.client.intlGet(this.guildId, 'noRegisteredDeathEvents');
            }

            const strings = [];
            let counter = 1;
            for (const event of this.allDeaths) {
                if (counter === 6) break;
                const location = event.location;

                let str = `${event.time} - ${event.name}: `;
                if (event.location === null) {
                    if (counter === number) return `${str}${Client.client.intlGet(this.guildId, 'unknown')}`;
                    strings.push(`${str}${Client.client.intlGet(this.guildId, 'unknown')}`);
                }
                else {
                    const distance = Math.floor(Map.getDistance(caller.x, caller.y, location.x, location.y));
                    const direction = Map.getAngleBetweenPoints(caller.x, caller.y, location.x, location.y);
                    const grid = location.location;
                    str += Client.client.intlGet(this.guildId, 'distanceDirectionGrid', {
                        distance: distance, direction: direction, grid: grid
                    });
                    if (counter === number) return str;
                    strings.push(str);
                }

                counter += 1;
            }

            return strings;
        }

        if (command.toLowerCase().startsWith(`${commandDeath} `)) {
            command = command.slice(`${commandDeath} `.length).trim();
        }
        else {
            command = command.slice(`${commandDeathEn} `.length).trim();
        }
        const name = command.replace(/ .*/, '');
        const number = parseInt(command.slice(name.length + 1));

        for (const player of this.team.players) {
            if (player.name.includes(name)) {
                if (!this.playerDeaths.hasOwnProperty(player.steamId)) {
                    this.playerDeaths[player.steamId] = [];
                }

                if (this.playerDeaths[player.steamId].length === 0) {
                    return Client.client.intlGet(this.guildId, 'noRegisteredDeathEventsUser', {
                        user: player.name
                    });
                }

                const strings = [];
                let counter = 1;
                for (const event of this.playerDeaths[player.steamId]) {
                    if (counter === 6) break;
                    const location = event.location;

                    let str = `${event.time} - `;
                    if (event.location === null) {
                        if (counter === number) return `${str}${Client.client.intlGet(this.guildId, 'unknown')}`;
                        strings.push(`${str}${Client.client.intlGet(this.guildId, 'unknown')}`);
                    }
                    else {
                        const distance = Math.floor(Map.getDistance(caller.x, caller.y, location.x, location.y));
                        const direction = Map.getAngleBetweenPoints(caller.x, caller.y, location.x, location.y);
                        const grid = location.location;
                        str += Client.client.intlGet(this.guildId, 'distanceDirectionGrid', {
                            distance: distance, direction: direction, grid: grid
                        });
                        if (counter === number) return str;
                        strings.push(str);
                    }

                    counter += 1;
                }

                return strings;
            }
        }

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: name
        });
    }

    getCommandEvents(command) {
        const prefix = this.generalSettings.prefix;
        const commandEvents = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxEvents')}`;
        const commandEventsEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxEvents')}`;
        const commandCargo = `${Client.client.intlGet(this.guildId, 'commandSyntaxCargo')}`;
        const commandCargoEn = `${Client.client.intlGet('en', 'commandSyntaxCargo')}`;
        const commandHeli = `${Client.client.intlGet(this.guildId, 'commandSyntaxHeli')}`;
        const commandHeliEn = `${Client.client.intlGet('en', 'commandSyntaxHeli')}`;
        const commandSmall = `${Client.client.intlGet(this.guildId, 'commandSyntaxSmall')}`;
        const commandSmallEn = `${Client.client.intlGet('en', 'commandSyntaxSmall')}`;
        const commandLarge = `${Client.client.intlGet(this.guildId, 'commandSyntaxLarge')}`;
        const commandLargeEn = `${Client.client.intlGet('en', 'commandSyntaxLarge')}`;
        const commandChinook = `${Client.client.intlGet(this.guildId, 'commandSyntaxChinook')}`;
        const commandChinookEn = `${Client.client.intlGet('en', 'commandSyntaxChinook')}`;
        const commandTravelingVendor = `${Client.client.intlGet(this.guildId, 'commandSyntaxTravelingVendor')}`;
        const commandTravelingVendorEn = `${Client.client.intlGet('en', 'commandSyntaxTravelingVendor')}`;
        const commandDeepSea = `${Client.client.intlGet(this.guildId, 'commandSyntaxDeepSea')}`;
        const commandDeepSeaEn = `${Client.client.intlGet('en', 'commandSyntaxDeepSea')}`;

        const EVENTS = [commandCargo, commandCargoEn, commandHeli, commandHeliEn, commandSmall,
            commandSmallEn, commandLarge, commandLargeEn, commandChinook, commandChinookEn, 
            commandTravelingVendor, commandTravelingVendorEn, commandDeepSea, commandDeepSeaEn];

        if (command.toLowerCase().startsWith(`${commandEvents}`)) {
            command = command.slice(`${commandEvents}`.length).trim();
        }
        else {
            command = command.slice(`${commandEventsEn}`.length).trim();
        }

        let event = command.replace(/ .*/, '').toLowerCase();
        let number = command.slice(event.length + 1);

        if (event === '') {
            event = 'all';
            number = 5;
        }
        else if (event !== '' && EVENTS.includes(event)) {
            if (number === '') {
                number = 5;
            }
            else {
                number = parseInt(number);
                if (isNaN(number)) {
                    number = 5;
                }
            }
        }
        else if (event !== '' && !EVENTS.includes(event)) {
            number = parseInt(event);
            event = 'all';
            if (isNaN(number)) {
                number = 5;
            }
        }
        else {
            event = 'all';
            number = 5;
        }

        switch (event) {
            case commandCargoEn:
            case commandCargo: {
                event = 'cargo';
            } break;

            case commandHeliEn:
            case commandHeli: {
                event = 'heli';
            } break;

            case commandSmallEn:
            case commandSmall: {
                event = 'small';
            } break;

            case commandLargeEn:
            case commandLarge: {
                event = 'large';
            } break;

            case commandChinookEn:
            case commandChinook: {
                event = 'chinook';
            } break;

            case commandTravelingVendorEn:
            case commandTravelingVendor: {
                event = 'travelingVendor';
            } break;

            case commandDeepSeaEn:
            case commandDeepSea: {
                event = 'deepSea';
            } break;

            default: {
                event = 'all';
            } break;
        }

        const strings = [];
        let counter = 0;
        for (const e of this.events[event]) {
            if (counter === 5 || counter === number) break;
            strings.push(e);
            counter += 1;
        }

        if (strings.length === 0) {
            return Client.client.intlGet(this.guildId, 'noRegisteredEvents');
        }

        return strings;
    }

    getCommandHeli(isInfoChannel = false) {
        const strings = [];
        for (const patrolHelicopter of this.mapMarkers.patrolHelicopters) {
            if (isInfoChannel) {
                return Client.client.intlGet(this.guildId, 'atLocation', {
                    location: patrolHelicopter.location.string
                });
            }
            else {
                strings.push(Client.client.intlGet(this.guildId, 'patrolHelicopterLocatedAt', {
                    location: patrolHelicopter.location.string
                }));
            }
        }

        if (strings.length === 0) {
            const wasOnMap = this.mapMarkers.timeSincePatrolHelicopterWasOnMap;
            const wasDestroyed = this.mapMarkers.timeSincePatrolHelicopterWasDestroyed;

            if (wasOnMap == null && wasDestroyed === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                    Client.client.intlGet(this.guildId, 'patrolHelicopterNotCurrentlyOnMap');
            }
            else if (wasOnMap !== null && wasDestroyed === null) {
                const secondsSince = (new Date() - wasOnMap) / 1000;
                if (isInfoChannel) {
                    const timeSince = Timer.secondsToFullScale(secondsSince, 's');
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: timeSince
                    });
                }
                else {
                    const timeSince = Timer.secondsToFullScale(secondsSince);
                    return Client.client.intlGet(this.guildId, 'timeSincePatrolHelicopterWasOnMap', {
                        time: timeSince
                    });
                }
            }
            else if (wasOnMap !== null && wasDestroyed !== null) {
                if (isInfoChannel) {
                    const timeSinceOnMap = Timer.secondsToFullScale((new Date() - wasOnMap) / 1000, 's');
                    const timeSinceDestroyed = Timer.secondsToFullScale((new Date() - wasDestroyed) / 1000, 's');
                    return Client.client.intlGet(this.guildId, 'timeSinceLastSinceDestroyedShort', {
                        time1: timeSinceOnMap,
                        time2: timeSinceDestroyed,
                        location: this.mapMarkers.patrolHelicopterDestroyedLocation === null ? '' :
                            ` [${this.mapMarkers.patrolHelicopterDestroyedLocation}]`
                    });
                }
                else {
                    const timeSinceOnMap = Timer.secondsToFullScale((new Date() - wasOnMap) / 1000);
                    const timeSinceDestroyed = Timer.secondsToFullScale((new Date() - wasDestroyed) / 1000);
                    return Client.client.intlGet(this.guildId, 'timeSinceLastSinceDestroyedLong', {
                        time1: timeSinceOnMap,
                        time2: timeSinceDestroyed,
                        location: this.mapMarkers.patrolHelicopterDestroyedLocation === null ? '' :
                            ` [${this.mapMarkers.patrolHelicopterDestroyedLocation}]`
                    });
                }
            }
        }

        return strings;
    }

    getCommandLarge(isInfoChannel = false) {
        const strings = [];
        if (this.mapMarkers.crateLargeOilRigTimer) {
            const time = Timer.getTimeLeftOfTimer(this.mapMarkers.crateLargeOilRigTimer);
            if (time) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeUntilUnlocksAt', {
                        time: Timer.getTimeLeftOfTimer(this.mapMarkers.crateLargeOilRigTimer, 's'),
                        location: this.mapMarkers.crateLargeOilRigLocation
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeBeforeCrateAtLargeOilRigUnlocks', {
                        time: time,
                        location: this.mapMarkers.crateLargeOilRigLocation
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceLargeOilRigWasTriggered === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'noData') :
                    Client.client.intlGet(this.guildId, 'noDataOnLargeOilRig');
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceLargeOilRigWasTriggered) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLastEvent', {
                        time: Timer.secondsToFullScale(secondsSince, 's')
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'timeSinceHeavyScientistsOnLarge', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
            }
        }

        return strings;
    }

    async getCommandLeader(command, callerSteamId) {
        const prefix = this.generalSettings.prefix;
        const commandLeader = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxLeader')}`;
        const commandLeaderEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxLeader')}`;

        if (!this.generalSettings.leaderCommandEnabled) {
            return Client.client.intlGet(this.guildId, 'leaderCommandIsDisabled');
        }

        const instance = Client.client.getInstance(this.guildId);
        if (!Object.keys(instance.serverListLite[this.serverId]).includes(this.team.leaderSteamId)) {
            let names = '';
            for (const player of this.team.players) {
                if (Object.keys(instance.serverListLite[this.serverId]).includes(player.steamId)) {
                    names += `${player.name}, `
                }
            }
            names = names.slice(0, -2);

            return Client.client.intlGet(this.guildId, 'leaderCommandOnlyWorks', {
                name: names
            });
        }

        if (command.toLowerCase() === `${commandLeader}` || command.toLowerCase() === `${commandLeaderEn}`) {
            if (callerSteamId === null) return null;

            if (this.team.leaderSteamId !== callerSteamId) {
                if (this.generalSettings.leaderCommandOnlyForPaired) {
                    if (!Object.keys(instance.serverListLite[this.serverId]).includes(callerSteamId)) {
                        return Client.client.intlGet(this.guildId, 'youAreNotPairedWithServer');
                    }
                }

                if (this.team.leaderSteamId === this.playerId) {
                    await this.team.changeLeadership(callerSteamId);
                }
                else {
                    this.leaderRustPlusInstance.promoteToLeaderAsync(callerSteamId);
                }

                const player = this.team.getPlayer(callerSteamId);
                return Client.client.intlGet(this.guildId, 'leaderTransferred', {
                    name: player.name
                });
            }
            else {
                return Client.client.intlGet(this.guildId, 'youAreAlreadyLeader');
            }
        }
        else if (command.toLowerCase().startsWith(`${commandLeader} `) ||
            command.toLowerCase().startsWith(`${commandLeaderEn} `)) {
            let name = null;
            if (command.toLowerCase().startsWith(`${commandLeader} `)) {
                name = command.slice(`${commandLeader} `.length).trim();
            }
            else {
                name = command.slice(`${commandLeaderEn} `.length).trim();
            }

            for (const player of this.team.players) {
                if (player.name.includes(name)) {
                    if (this.team.leaderSteamId === player.steamId) {
                        return Client.client.intlGet(this.guildId, 'leaderAlreadyLeader', {
                            name: player.name
                        });
                    }
                    else {
                        if (this.generalSettings.leaderCommandOnlyForPaired) {
                            if (!Object.keys(instance.serverListLite[this.serverId]).includes(player.steamId)) {
                                return Client.client.intlGet(this.guildId, 'playerNotPairedWithServer', {
                                    name: player.name
                                });
                            }
                        }

                        if (this.team.leaderSteamId === this.playerId) {
                            await this.team.changeLeadership(player.steamId);
                        }
                        else {
                            this.leaderRustPlusInstance.promoteToLeaderAsync(player.steamId);
                        }

                        return Client.client.intlGet(this.guildId, 'leaderTransferred', {
                            name: player.name
                        });
                    }
                }
            }

            return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                name: name
            });
        }

        return null;
    }

    async getCommandMarker(command, callerSteamId) {
        const prefix = this.generalSettings.prefix;
        const commandMarker = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxMarker')}`;
        const commandMarkerEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxMarker')}`;
        const commandMarkers = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxMarkers')}`;
        const commandMarkersEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxMarkers')}`;
        const commandAdd = `${Client.client.intlGet(this.guildId, 'commandSyntaxAdd')}`;
        const commandAddEn = `${Client.client.intlGet('en', 'commandSyntaxAdd')}`;
        const commandRemove = `${Client.client.intlGet(this.guildId, 'commandSyntaxRemove')}`;
        const commandRemoveEn = `${Client.client.intlGet('en', 'commandSyntaxRemove')}`;

        if (command.toLowerCase() === `${commandMarkers}` || command.toLowerCase() === `${commandMarkersEn}`) {
            let str = '';
            for (const name in this.markers) str += `${name} [${this.markers[name].location}], `;

            return str !== '' ? str.slice(0, -2) : Client.client.intlGet(this.guildId, 'noRegisteredMarkers');
        }

        if (command.toLowerCase().startsWith(`${commandMarker} `)) {
            command = command.slice(`${commandMarker} `.length).trim();
        }
        else {
            command = command.slice(`${commandMarkerEn} `.length).trim();
        }
        const subcommand = command.replace(/ .*/, '');
        const name = command.slice(subcommand.length + 1);

        switch (subcommand.toLowerCase()) {
            case commandAddEn:
            case commandAdd: {
                if (name.startsWith(commandAdd) || name.startsWith(commandRemove)) return null;
                if (name.startsWith(commandAddEn) || name.startsWith(commandRemoveEn)) return null;
                if (name === '') return null;

                const teamInfo = await this.getTeamInfoAsync();
                if (!(await this.isResponseValid(teamInfo))) return null;

                for (const player of teamInfo.teamInfo.members) {
                    if (player.steamId.toString() === callerSteamId) {
                        const instance = Client.client.getInstance(this.guildId);
                        const location = Map.getPos(player.x, player.y, this.info.correctedMapSize, this);
                        instance.serverList[this.serverId].markers[name] =
                            { x: player.x, y: player.y, location: location.location };
                        Client.client.setInstance(this.guildId, instance);
                        this.markers[name] = { x: player.x, y: player.y, location: location.location };

                        return Client.client.intlGet(this.guildId, 'markerAdded', {
                            name: name,
                            location: location.location
                        });
                    }
                }
            } break;

            case commandRemoveEn:
            case commandRemove: {
                const instance = Client.client.getInstance(this.guildId);

                if (name in this.markers) {
                    const location = this.markers[name].location;
                    delete this.markers[name];
                    delete instance.serverList[this.serverId].markers[name];
                    Client.client.setInstance(this.guildId, instance);

                    return Client.client.intlGet(this.guildId, 'markerRemoved', {
                        name: name,
                        location: location
                    });
                }
                return Client.client.intlGet(this.guildId, 'markerDoesNotExist', {
                    name: name
                });
            } break;

            default: {
                if (!(command in this.markers)) {
                    return Client.client.intlGet(this.guildId, 'markerDoesNotExist', {
                        name: command
                    });
                }

                const teamInfo = await this.getTeamInfoAsync();
                if (!(await this.isResponseValid(teamInfo))) return null;

                for (const player of teamInfo.teamInfo.members) {
                    if (player.steamId.toString() === callerSteamId) {
                        const direction = Map.getAngleBetweenPoints(player.x, player.y, this.markers[command].x,
                            this.markers[command].y);
                        const distance = Math.floor(Map.getDistance(player.x, player.y, this.markers[command].x,
                            this.markers[command].y));
                        console.log(this.markers[command])

                        return Client.client.intlGet(this.guildId, 'markerLocation', {
                            name: command,
                            location: this.markers[command].location,
                            distance: distance,
                            player: player.name,
                            direction: direction
                        });
                    }
                }
            } break;
        }

        return null;
    }

    getCommandMute() {
        const instance = Client.client.getInstance(this.guildId);
        instance.generalSettings.muteInGameBotMessages = true;
        this.generalSettings.muteInGameBotMessages = true;
        Client.client.setInstance(this.guildId, instance);

        return Client.client.intlGet(this.guildId, 'inGameBotMessagesMuted');
    }

    getCommandNote(command) {
        const instance = Client.client.getInstance(this.guildId);
        const prefix = this.generalSettings.prefix;
        const commandNote = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxNote')}`;
        const commandNoteEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxNote')}`;
        const commandNotes = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxNotes')}`;
        const commandNotesEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxNotes')}`;
        const commandAdd = `${Client.client.intlGet(this.guildId, 'commandSyntaxAdd')}`;
        const commandAddEn = `${Client.client.intlGet('en', 'commandSyntaxAdd')}`;
        const commandRemove = `${Client.client.intlGet(this.guildId, 'commandSyntaxRemove')}`;
        const commandRemoveEn = `${Client.client.intlGet('en', 'commandSyntaxRemove')}`;

        if (command.toLowerCase() === `${commandNotes}` || command.toLowerCase() === `${commandNotesEn}`) {
            if (Object.keys(instance.serverList[this.serverId].notes).length === 0) {
                return Client.client.intlGet(this.guildId, 'noSavedNotes');
            }

            const strings = [];
            for (const [id, note] of Object.entries(instance.serverList[this.serverId].notes)) {
                strings.push(`${id}: ${note}`);
            }
            return strings;
        }

        if (command.toLowerCase().startsWith(`${commandNote} `)) {
            command = command.slice(`${commandNote} `.length).trim();
        }
        else {
            command = command.slice(`${commandNoteEn} `.length).trim();
        }
        const subcommand = command.replace(/ .*/, '');
        const rest = command.slice(subcommand.length + 1);

        switch (subcommand.toLowerCase()) {
            case commandAddEn:
            case commandAdd: {
                let index = 0;
                while (Object.keys(instance.serverList[this.serverId].notes).map(Number).includes(index)) {
                    index += 1;
                }

                instance.serverList[this.serverId].notes[index] = `${rest}`;
                Client.client.setInstance(this.guildId, instance);
                return Client.client.intlGet(this.guildId, 'noteSaved');
            } break;

            case commandRemoveEn:
            case commandRemove: {
                const id = parseInt(rest.trim());

                if (!isNaN(id)) {
                    if (!Object.keys(instance.serverList[this.serverId].notes).map(Number).includes(id)) {
                        return Client.client.intlGet(this.guildId, 'noteIdDoesNotExist', { id: id });
                    }

                    delete instance.serverList[this.serverId].notes[id];
                    Client.client.setInstance(this.guildId, instance);
                    return Client.client.intlGet(this.guildId, 'noteIdWasRemoved', { id: id });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'noteIdInvalid');
                }
            } break;

            default: {
                return null;
            } break;
        }
    }

    getCommandOffline() {
        let string = '';
        let counter = 0;
        for (const player of this.team.players) {
            if (!player.isOnline) {
                string += `${player.name}, `;
                counter += 1;
            }
        }
        const amount = `(${counter}/${this.team.players.length}) `;

        return string !== '' ? `${amount}${string.slice(0, -2)}.` :
            `${amount}${Client.client.intlGet(this.guildId, 'noOneIsOffline')}`;
    }

    getCommandOnline() {
        let string = '';
        let counter = 0;
        for (const player of this.team.players) {
            if (player.isOnline) {
                string += `${player.name}, `;
                counter += 1;
            }
        }
        const amount = `(${counter}/${this.team.players.length}) `;

        return string !== '' ? `${amount}${string.slice(0, -2)}.` :
            `${amount}${Client.client.intlGet(this.guildId, 'noOneIsOnline')}`;
    }

    getCommandPlayer(command) {
        const instance = Client.client.getInstance(this.guildId);
        const battlemetricsId = instance.serverList[this.serverId].battlemetricsId;
        const prefix = this.generalSettings.prefix;
        const commandPlayer = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxPlayer')}`;
        const commandPlayerEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxPlayer')}`;
        const commandPlayers = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxPlayers')}`;
        const commandPlayersEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxPlayers')}`;

        const bmInstance = Client.client.battlemetricsInstances[battlemetricsId];

        if (!bmInstance || !bmInstance.lastUpdateSuccessful) {
            return Client.client.intlGet(this.guildId, 'battlemetricsInstanceCouldNotBeFound', {
                id: battlemetricsId
            });
        }

        let foundPlayers = [];
        if (command.toLowerCase() === `${commandPlayers}` || command.toLowerCase() === `${commandPlayersEn}`) {
            foundPlayers = bmInstance.getOnlinePlayerIdsOrderedByTime();
            if (foundPlayers.length === 0) {
                return Client.client.intlGet(this.guildId, 'couldNotFindAnyPlayers');
            }
        }
        else if (command.toLowerCase().startsWith(`${commandPlayer} `) ||
            command.toLowerCase().startsWith(`${commandPlayerEn} `)) {

            let name = null;
            if (command.toLowerCase().startsWith(`${commandPlayer}`)) {
                name = command.slice(`${commandPlayer} `.length).trim();
            }
            else {
                name = command.slice(`${commandPlayerEn} `.length).trim();
            }

            for (const playerId of bmInstance.getOnlinePlayerIdsOrderedByTime()) {
                if (bmInstance.players[playerId]['name'].includes(name)) foundPlayers.push(playerId);
            }

            if (foundPlayers.length === 0) {
                return Client.client.intlGet(this.guildId, 'couldNotFindPlayer', {
                    name: name
                });
            }
        }
        else {
            return null;
        }

        const trademark = this.generalSettings.trademark;
        const trademarkString = (trademark === 'NOT SHOWING') ? '' : `${trademark} | `;
        const messageMaxLength = Constants.MAX_LENGTH_TEAM_MESSAGE - trademarkString.length;
        const leftLength = `...xxx ${Client.client.intlGet(this.guildId, 'more')}.`.length;

        let string = '';
        let playerIndex = 0;
        for (const playerId of foundPlayers) {
            const time = bmInstance.getOnlineTime(playerId);
            const playerString = `${bmInstance.players[playerId]['name']} [${time[1]}], `;

            if ((string.length + playerString.length + leftLength) < messageMaxLength) {
                string += playerString;
            }
            else if ((string.length + playerString.length + leftLength) > messageMaxLength) {
                break;
            }

            playerIndex += 1;
        }

        if (string !== '') {
            string = string.slice(0, -2);

            if (playerIndex < foundPlayers.length) {
                return Client.client.intlGet(this.guildId, 'morePlayers', {
                    players: string,
                    number: foundPlayers.length - playerIndex
                });
            }
            else {
                return `${string}.`;
            }
        }

        return null;
    }

    getCommandPop(isInfoChannel = false) {
        if (isInfoChannel) {
            return `${this.info.players}${this.info.isQueue() ? `(${this.info.queuedPlayers})` : ''}` +
                `/${this.info.maxPlayers}`;
        }
        else {
            const string = Client.client.intlGet(this.guildId, 'populationPlayers', {
                current: this.info.players,
                max: this.info.maxPlayers
            });
            const queuedPlayers = this.info.isQueue() ?
                ` ${Client.client.intlGet(this.guildId, 'populationQueue', { number: this.info.queuedPlayers })}` : '';

            return `${string}${queuedPlayers}`;
        }
    }

    async getCommandProx(command, callerSteamId) {
        const caller = this.team.getPlayer(callerSteamId);
        const prefix = this.generalSettings.prefix;
        const commandProx = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxProx')}`;
        const commandProxEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxProx')}`;

        if ((command.toLowerCase() !== `${commandProx}` && !command.toLowerCase().startsWith(`${commandProx} `)) &&
            (command.toLowerCase() !== `${commandProxEn}` && !command.toLowerCase().startsWith(`${commandProxEn} `))) {
            return null;
        }

        const teamInfo = await this.getTeamInfoAsync();
        if (!(await this.isResponseValid(teamInfo))) return null;
        TeamHandler.handler(this, Client.client, teamInfo.teamInfo);
        this.team.updateTeam(teamInfo.teamInfo);

        if (command.toLowerCase() === `${commandProx}` || command.toLowerCase() === `${commandProxEn}`) {
            const closestPlayers = [];
            let players = [...this.team.players].filter(e => e.steamId !== callerSteamId && e.isAlive === true);
            if (players.length === 0) {
                return Client.client.intlGet(this.guildId, 'onlyOneInTeam');
            }

            for (let i = 0; i < 3; i++) {
                if (players.length > 0) {
                    const player = players.reduce(function (prev, curr) {
                        if (Map.getDistance(prev.x, prev.y, caller.x, caller.y) <
                            Map.getDistance(curr.x, curr.y, caller.x, caller.y)) {
                            return prev;
                        }
                        else {
                            return curr;
                        }
                    });
                    closestPlayers.push(player);
                    players = players.filter(e => e.steamId !== player.steamId);
                }
            }

            let string = '';
            for (const player of closestPlayers) {
                const distance = Math.floor(Map.getDistance(player.x, player.y, caller.x, caller.y));
                string += `${player.name} (${distance}m [${player.pos.location}]), `;
            }

            return string === '' ? Client.client.intlGet(this.guildId, 'allTeammatesAreDead') :
                `${string.slice(0, -2)}.`
        }

        let memberName = null;
        if (command.toLowerCase().startsWith(`${commandProx}`)) {
            memberName = command.slice(`${commandProx} `.length).trim();
        }
        else {
            memberName = command.slice(`${commandProxEn} `.length).trim();
        }

        for (const player of this.team.players) {
            if (player.name.includes(memberName)) {
                const distance = Math.floor(Map.getDistance(caller.x, caller.y, player.x, player.y));
                const direction = Map.getAngleBetweenPoints(caller.x, caller.y, player.x, player.y);
                return Client.client.intlGet(this.guildId, 'proxLocation', {
                    name: player.name,
                    distance: distance,
                    caller: caller.name,
                    direction: direction,
                    location: player.pos.location
                });
            }
        }

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: memberName
        });
    }

    async getCommandSend(command, callerName) {
        const credentials = InstanceUtils.readCredentialsFile(this.guildId);
        const prefix = this.generalSettings.prefix;
        const commandSend = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxSend')}`;
        const commandSendEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxSend')}`;

        if (command.toLowerCase().startsWith(`${commandSend} `)) {
            command = command.slice(`${commandSend} `.length).trim();
        }
        else {
            command = command.slice(`${commandSendEn} `.length).trim();
        }
        const name = command.replace(/ .*/, '');
        const message = command.slice(name.length + 1).trim();

        if (name === '' || message === '') {
            return Client.client.intlGet(this.guildId, 'missingArguments');
        }

        for (const player of this.team.players) {
            if (player.name.includes(name)) {
                if (!(player.steamId in credentials)) {
                    return Client.client.intlGet(this.guildId, 'userNotRegistered', {
                        user: player.name
                    });
                }

                const discordUserId = credentials[player.steamId].discord_user_id;
                const user = await DiscordTools.getUserById(this.guildId, discordUserId);

                const content = {
                    embeds: [DiscordEmbeds.getUserSendEmbed(this.guildId, this.serverId, callerName, message)]
                }

                if (user) {
                    await Client.client.messageSend(user, content);
                    return Client.client.intlGet(this.guildId, 'messageWasSent');
                }

                return Client.client.intlGet(this.guildId, 'couldNotFindUser', {
                    userId: discordUserId
                });
            }
        }

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: name
        });
    }

    getCommandSmall(isInfoChannel = false) {
        const strings = [];
        if (this.mapMarkers.crateSmallOilRigTimer) {
            const time = Timer.getTimeLeftOfTimer(this.mapMarkers.crateSmallOilRigTimer);
            if (time) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeUntilUnlocksAt', {
                        time: Timer.getTimeLeftOfTimer(this.mapMarkers.crateSmallOilRigTimer, 's'),
                        location: this.mapMarkers.crateSmallOilRigLocation
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeBeforeCrateAtSmallOilRigUnlocks', {
                        time: time,
                        location: this.mapMarkers.crateSmallOilRigLocation
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceSmallOilRigWasTriggered === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'noData') :
                    Client.client.intlGet(this.guildId, 'noDataOnSmallOilRig');
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceSmallOilRigWasTriggered) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLastEvent', {
                        time: Timer.secondsToFullScale(secondsSince, 's')
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'timeSinceHeavyScientistsOnSmall', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
            }
        }

        return strings;
    }

    getCommandSteamId(command, callerSteamId, callerName) {
        const prefix = this.generalSettings.prefix;
        const commandSteamid = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxSteamid')}`;
        const commandSteamidEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxSteamid')}`;

        if (command.toLowerCase() === `${commandSteamid}` || command.toLowerCase() === `${commandSteamidEn}`) {
            if (callerSteamId === null || callerName === null) return null;

            return `${callerName}: ${callerSteamId}`;
        }
        else if (command.toLowerCase().startsWith(`${commandSteamid} `) ||
            command.toLowerCase().startsWith(`${commandSteamidEn} `)) {
            let name = null;
            if (command.toLowerCase().startsWith(`${commandSteamid} `)) {
                name = command.slice(`${commandSteamid} `.length).trim();
            }
            else {
                name = command.slice(`${commandSteamidEn} `.length).trim();
            }

            for (const player of this.team.players) {
                if (player.name.includes(name)) {
                    return `${player.name}: ${player.steamId}`;
                }
            }

            return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                name: name
            });
        }

        return null;
    }

    getCommandTeam() {
        let string = '';
        for (const player of this.team.players) {
            string += `${player.name}, `;
        }

        return string !== '' ? `${string.slice(0, -2)}.` : null;
    }

    getCommandTime(isInfoChannel = false) {
        const time = Timer.convertDecimalToHoursMinutes(this.time.time);
        if (isInfoChannel) {
            return [time, this.time.getTimeTillDayOrNight('s')];
        }
        else {
            const currentTime = Client.client.intlGet(this.guildId, 'inGameTime', { time: time });
            const timeLeft = this.time.getTimeTillDayOrNight();

            if (timeLeft === null) return currentTime;

            const locString = this.time.isDay() ? 'timeTillNightfall' : 'timeTillDaylight';
            const timeTilltransition = Client.client.intlGet(this.guildId, locString, { time: timeLeft });

            return `${currentTime} ${timeTilltransition}`;
        }
    }

    getCommandTimer(command) {
        const prefix = this.generalSettings.prefix;
        const commandTimer = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxTimer')}`;
        const commandTimerEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxTimer')}`;
        const commandTimers = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxTimers')}`;
        const commandTimersEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxTimers')}`;
        const commandAdd = `${Client.client.intlGet(this.guildId, 'commandSyntaxAdd')}`;
        const commandAddEn = `${Client.client.intlGet('en', 'commandSyntaxAdd')}`;
        const commandRemove = `${Client.client.intlGet(this.guildId, 'commandSyntaxRemove')}`;
        const commandRemoveEn = `${Client.client.intlGet('en', 'commandSyntaxRemove')}`;

        if (command.toLowerCase() === `${commandTimers}` || command.toLowerCase() === `${commandTimersEn}`) {
            if (Object.keys(this.timers).length === 0) {
                return Client.client.intlGet(this.guildId, 'noActiveTimers');
            }

            const strings = [];
            for (const [id, content] of Object.entries(this.timers)) {
                const timeLeft = Timer.getTimeLeftOfTimer(content.timer);
                strings.push(Client.client.intlGet(this.guildId, 'timeLeftTimer', {
                    id: parseInt(id),
                    time: timeLeft,
                    message: content.message
                }));
            }
            return strings;
        }

        if (command.toLowerCase().startsWith(`${commandTimer} `)) {
            command = command.slice(`${commandTimer} `.length).trim();
        }
        else {
            command = command.slice(`${commandTimerEn} `.length).trim();
        }
        const subcommand = command.replace(/ .*/, '');
        const rest = command.slice(subcommand.length + 1);

        switch (subcommand.toLowerCase()) {
            case commandAddEn:
            case commandAdd: {
                const time = rest.replace(/ .*/, '');
                const message = rest.slice(time.length + 1);
                if (message === '') return Client.client.intlGet(this.guildId, 'missingTimerMessage');

                const timeSeconds = Timer.getSecondsFromStringTime(time);
                if (timeSeconds === null) return Client.client.intlGet(this.guildId, 'timeFormatInvalid');

                let id = 0;
                while (Object.keys(this.timers).map(Number).includes(id)) {
                    id += 1;
                }

                this.timers[id] = {
                    timer: new Timer.timer(
                        () => {
                            this.sendInGameMessage(Client.client.intlGet(this.guildId, 'timer',
                                { message: message }), 'TIMER');
                            delete this.timers[id]
                        },
                        timeSeconds * 1000),
                    message: message
                };
                this.timers[id].timer.start();

                return Client.client.intlGet(this.guildId, 'timerSet', { time: time });
            } break;

            case commandRemoveEn:
            case commandRemove: {
                const id = parseInt(rest.replace(/ .*/, ''));
                if (isNaN(id)) return Client.client.intlGet(this.guildId, 'timerIdInvalid');

                if (!Object.keys(this.timers).map(Number).includes(id)) {
                    return Client.client.intlGet(this.guildId, 'timerIdDoesNotExist', { id: id });
                }

                this.timers[id].timer.stop();
                delete this.timers[id];

                return Client.client.intlGet(this.guildId, 'timerRemoved', { id: id });
            } break;

            default: {
                /* Shorthand: !timer <time> [message] — no 'add' subcommand needed */
                const timeSeconds = Timer.getSecondsFromStringTime(subcommand);
                if (timeSeconds === null) return null;

                const message = rest !== '' ? rest : subcommand;

                let id = 0;
                while (Object.keys(this.timers).map(Number).includes(id)) {
                    id += 1;
                }

                this.timers[id] = {
                    timer: new Timer.timer(
                        () => {
                            this.sendInGameMessage(Client.client.intlGet(this.guildId, 'timer',
                                { message: message }), 'TIMER');
                            delete this.timers[id];
                        },
                        timeSeconds * 1000),
                    message: message
                };
                this.timers[id].timer.start();

                return Client.client.intlGet(this.guildId, 'timerSet', { time: subcommand });
            } break;
        }
    }

    async getCommandTranslateTo(command) {
        const prefix = this.generalSettings.prefix;
        const commandTr = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxTranslateTo')}`;
        const commandTrEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxTranslateTo')}`;
        const commandLanguage = `${Client.client.intlGet(this.guildId, 'commandSyntaxLanguage')}`;
        const commandLanguageEn = `${Client.client.intlGet('en', 'commandSyntaxLanguage')}`;

        if (command.toLowerCase().startsWith(`${commandTr} ${commandLanguage} `) ||
            command.toLowerCase().startsWith(`${commandTrEn} ${commandLanguageEn} `)) {

            let language = null;
            if (command.toLowerCase().startsWith(`${commandTr} ${commandLanguage} `)) {
                language = command.slice(`${commandTr} ${commandLanguage} `.length).trim();
            }
            else {
                language = command.slice(`${commandTrEn} ${commandLanguageEn} `.length).trim();
            }

            if (language in Languages) {
                return Client.client.intlGet(this.guildId, 'languageCode', {
                    code: Languages[language]
                });
            }
            else {
                return Client.client.intlGet(this.guildId, 'couldNotFindLanguage', {
                    language: language
                });
            }
        }

        if (command.toLowerCase().startsWith(`${commandTr} `)) {
            command = command.slice(`${commandTr} `.length).trim();
        }
        else {
            command = command.slice(`${commandTrEn} `.length).trim();
        }
        const language = command.replace(/ .*/, '');
        const text = command.slice(language.length).trim();

        if (language === '' || text === '') {
            return Client.client.intlGet(this.guildId, 'missingArguments');
        }

        try {
            return await Translate(text, language);
        }
        catch (e) {
            return Client.client.intlGet(this.guildId, 'languageLangNotSupported', {
                language: language
            });
        }
    }

    async getCommandTranslateFromTo(command) {
        const prefix = this.generalSettings.prefix;
        const commandTrf = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxTranslateFromTo')}`;
        const commandTrfEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxTranslateFromTo')}`;

        if (command.toLowerCase().startsWith(`${commandTrf}`)) {
            command = command.slice(`${commandTrf} `.length).trim();
        }
        else {
            command = command.slice(`${commandTrfEn} `.length).trim();
        }

        const languageFrom = command.replace(/ .*/, '');
        command = command.slice(languageFrom.length).trim();
        const languageTo = command.replace(/ .*/, '');
        const text = command.slice(languageTo.length).trim();

        if (languageFrom === '' || languageTo === '' || text === '') {
            return Client.client.intlGet(this.guildId, 'missingArguments');
        }

        try {
            return await Translate(text, { from: languageFrom, to: languageTo });
        }
        catch (e) {
            const regex = new RegExp('The language "(.*?)"');
            /* exec() returns null when the error doesn't match the
               "language not supported" shape (network failure, rate
               limit, etc). Without the null guard the catch handler
               itself throws TypeError, which the caller would not be
               able to recover from. */
            const invalidLanguage = (e && e.message) ? regex.exec(e.message) : null;

            if (invalidLanguage && invalidLanguage.length >= 2) {
                return Client.client.intlGet(this.guildId, 'languageLangNotSupported', {
                    language: invalidLanguage[1]
                });
            }

            return Client.client.intlGet(this.guildId, 'languageNotSupported');
        }
    }

    getCommandUnmute() {
        const instance = Client.client.getInstance(this.guildId);
        instance.generalSettings.muteInGameBotMessages = false;
        this.generalSettings.muteInGameBotMessages = false;
        Client.client.setInstance(this.guildId, instance);

        return Client.client.intlGet(this.guildId, 'inGameBotMessagesUnmuted');
    }

    getCommandUptime() {
        let uptimeBot = Client.client.uptimeBot;
        let uptimeServer = this.uptimeServer;

        if (uptimeBot !== null) {
            const seconds = (new Date() - uptimeBot) / 1000;
            uptimeBot = Timer.secondsToFullScale(seconds);
        }
        else {
            uptimeBot = Client.client.intlGet(this.guildId, 'offline');
        }

        if (uptimeServer !== null) {
            const seconds = (new Date() - uptimeServer) / 1000;
            uptimeServer = Timer.secondsToFullScale(seconds);
        }
        else {
            uptimeServer = Client.client.intlGet(this.guildId, 'offline');
        }

        let string = `${Client.client.intlGet(this.guildId, 'bot')}: ${uptimeBot} `;
        string += `${Client.client.intlGet(this.guildId, 'server')}: ${uptimeServer}.`;

        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    getCommandWipe(isInfoChannel = false) {
        if (isInfoChannel) {
            return Client.client.intlGet(this.guildId, 'dayOfWipe', {
                day: Math.ceil(this.info.getSecondsSinceWipe() / (60 * 60 * 24))
            });
        }
        else {
            return Client.client.intlGet(this.guildId, 'timeSinceWipe', {
                time: this.info.getTimeSinceWipe()
            });
        }
    }

    getCommandTravelingVendor(isInfoChannel = false) {
        const strings = [];
        for (const travelingVendor of this.mapMarkers.travelingVendors) {
            if (isInfoChannel) {
                return Client.client.intlGet(this.guildId, 'atLocation', {
                    location: travelingVendor.location.string
                });
            }
            else {
                strings.push(Client.client.intlGet(this.guildId, 'travelingVendorLocatedAt', {
                    location: travelingVendor.location.string
                }));
            }
        }

        if (strings.length === 0) {
            const wasOnMap = this.mapMarkers.timeSinceTravelingVendorWasOnMap;

            if (wasOnMap == null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                    Client.client.intlGet(this.guildId, 'travelingVendorNotCurrentlyOnMap');
            }
            else if (wasOnMap !== null) {
                const secondsSince = (new Date() - wasOnMap) / 1000;
                if (isInfoChannel) {
                    const timeSince = Timer.secondsToFullScale(secondsSince, 's');
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: timeSince
                    });
                }
                else {
                    const timeSince = Timer.secondsToFullScale(secondsSince);
                    return Client.client.intlGet(this.guildId, 'timeSinceTravelingVendorWasOnMap', {
                        time: timeSince
                    });
                }
            }
        }

        return strings;
    }

    getCommandDeepSea(isInfoChannel = false) {
        const instance = Client.client.getInstance(this.guildId);
        const deepSeaSettings = instance.serverList[this.serverId];
        const deepSeaWipeCooldown = deepSeaSettings.deepSeaWipeCooldownMs;
        const deepSeaWipeDuration = deepSeaSettings.deepSeaWipeDurationMs;
        const wasOnMap = this.mapMarkers.timeSinceDeepSeaWasOnMap;
        const isOnMap = this.mapMarkers.timeSinceDeepSeaSpawned;
        const deepSea = this.mapMarkers.deepSeas[0];
        const now = new Date();

        if (deepSea && isOnMap !== null) {
            const secondsLeft = Math.max(0, (deepSeaWipeDuration - (now - isOnMap)) / 1000);
            if (isInfoChannel) {
                return Client.client.intlGet(this.guildId, 'activeFor', {
                    time: Timer.secondsToFullScale(secondsLeft, 's')
                });
            }

            return Client.client.intlGet(this.guildId, 'timeDeepSeaIsActiveFor', {
                time: Timer.secondsToFullScale(secondsLeft)
            });
        }

        if (wasOnMap === null) {
            return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                Client.client.intlGet(this.guildId, 'deepSeaNotCurrentlyOnMap');
        }

        const secondsSince = (now - wasOnMap) / 1000;
        if (isInfoChannel) {
            return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                time: Timer.secondsToFullScale(secondsSince, 's')
            });
        }

        const respawnSeconds = Math.max(0, (deepSeaWipeCooldown - (now - wasOnMap)) / 1000);
        return Client.client.intlGet(this.guildId, 'timeSinceDeepSeaWasOnMap', {
            time: Timer.secondsToFullScale(secondsSince),
            respawn: Timer.secondsToFullScale(respawnSeconds, 's')
        });
    }
}

module.exports = RustPlus;
