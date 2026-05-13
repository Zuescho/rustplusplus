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

const Client = require('../../index.ts');

/* Debounced write queue for instance files.

   The bot's persistence pattern is "mutate the in-memory instance object and
   call setInstance()" — and a single poll cycle can trigger dozens of those
   calls, each toggling a single boolean. Previously every call re-serialized
   the whole guild state and fsynced it to disk synchronously, which was the
   hot path that dominated CPU and disk on busy guilds.

   The same in-memory object reference is shared between callers and the queue,
   so when we eventually flush we always see the latest mutations regardless of
   how many setInstance calls happened in between. */
const WRITE_DEBOUNCE_MS = 250;
const _pending = new Map(); /* guildId -> { instance, timer } */

function _instancePath(guildId) {
    return Path.join(__dirname, '..', '..', 'instances', `${guildId}.json`);
}

function _flushOne(guildId) {
    const entry = _pending.get(guildId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    _pending.delete(guildId);

    const targetPath = _instancePath(guildId);
    const tempPath = targetPath + '.tmp';

    /* Compact JSON — pretty-printing roughly doubles size and slows
       serialization for no end-user benefit (operators can pretty-print
       on demand). Atomic rename still gives crash consistency at the FS
       level; we deliberately don't fsync per write — the cost isn't worth
       the durability gain for a chat bot. */
    const data = JSON.stringify(entry.instance);
    try {
        Fs.writeFileSync(tempPath, data, 'utf8');
        Fs.renameSync(tempPath, targetPath);
    }
    catch (error) {
        console.error(`Failed to write instance file ${targetPath}:`, error);
        try { Fs.unlinkSync(tempPath); } catch { /* ignore */ }
        throw error;
    }
}

function _flushAll() {
    for (const guildId of Array.from(_pending.keys())) {
        try { _flushOne(guildId); }
        catch (e) { /* already logged */ }
    }
}

/* Best-effort flush on shutdown so we don't lose the last <250ms of state.
   These are idempotent and safe to register once at module load. */
let _shutdownHooked = false;
function _hookShutdown() {
    if (_shutdownHooked) return;
    _shutdownHooked = true;
    const onExit = () => _flushAll();
    process.on('exit', onExit);
    process.on('SIGINT', () => { _flushAll(); process.exit(130); });
    process.on('SIGTERM', () => { _flushAll(); process.exit(143); });
}
_hookShutdown();

module.exports = {
    getSmartDevice: function (guildId, entityId) {
        /* Temporary function till discord modals gets more functional */
        const instance = Client.client.getInstance(guildId);

        for (const serverId in instance.serverList) {
            for (const switchId in instance.serverList[serverId].switches) {
                if (entityId === switchId) return { type: 'switch', serverId: serverId }
            }
            for (const alarmId in instance.serverList[serverId].alarms) {
                if (entityId === alarmId) return { type: 'alarm', serverId: serverId }
            }
            for (const storageMonitorId in instance.serverList[serverId].storageMonitors) {
                if (entityId === storageMonitorId) return { type: 'storageMonitor', serverId: serverId }
            }
        }
        return null;
    },

    readInstanceFile: function (guildId) {
        /* If a write is pending for this guild, flush it first so the read
           sees the latest committed state. */
        if (_pending.has(guildId)) _flushOne(guildId);

        const targetPath = _instancePath(guildId);
        const tempPath = targetPath + '.tmp';
        if (Fs.existsSync(tempPath)) {
            try {
                Fs.unlinkSync(tempPath);
            } catch (e) {
                console.warn(`Failed to remove stale temporary file: ${tempPath}`, e);
            }
        }

        return JSON.parse(Fs.readFileSync(targetPath, 'utf8'));
    },

    writeInstanceFile: function (guildId, instance) {
        const existing = _pending.get(guildId);
        if (existing) {
            /* Replace the instance reference (latest wins) but let the
               in-flight timer fire on its original schedule — we never want
               writes to be starved by a steady stream of mutations. */
            existing.instance = instance;
            return;
        }
        const timer = setTimeout(() => {
            try { _flushOne(guildId); }
            catch (e) { /* already logged */ }
        }, WRITE_DEBOUNCE_MS);
        if (timer.unref) timer.unref();
        _pending.set(guildId, { instance, timer });
    },

    flushInstanceFile: function (guildId) {
        _flushOne(guildId);
    },

    flushAllInstanceFiles: _flushAll,

    readCredentialsFile: function (guildId) {
        const path = Path.join(__dirname, '..', '..', 'credentials', `${guildId}.json`);
        return JSON.parse(Fs.readFileSync(path, 'utf8'));
    },

    writeCredentialsFile: function (guildId, credentials) {
        const path = Path.join(__dirname, '..', '..', 'credentials', `${guildId}.json`);
        Fs.writeFileSync(path, JSON.stringify(credentials, null, 2));
    },
}
