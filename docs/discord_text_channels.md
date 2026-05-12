# Discord Text Channels Documentation

## Discord Text Channels

* [**Information**](discord_text_channels.md#information-channel)
* [**Servers**](discord_text_channels.md#servers-channel)
* [**Settings**](discord_text_channels.md#settings-channel)
* [**Commands**](discord_text_channels.md#commands-channel)
* [**Events**](discord_text_channels.md#events-channel)
* [**Teamchat**](discord_text_channels.md#teamchat-channel)
* [**Teamchat-Translated**](discord_text_channels.md#teamchat-translated-channel)
* [**Switches**](discord_text_channels.md#switches-channel)
* [**Switchgroups**](discord_text_channels.md#switch-groups-channel)
* [**Alarms**](discord_text_channels.md#alarms-channel)
* [**Storagemonitors**](discord_text_channels.md#storagemonitors-channel)
* [**Activity**](discord_text_channels.md#activity-channel)
* [**Trackers**](discord_text_channels.md#trackers-channel)


## Information Channel

> The Information Channel present information about the currently connected Rust Server. It is split up into four sections, `The Map`, `Server Information`, `Event Information` and `Team Member Information` (See below).

**The Map** is simple an image of the Rust Server Map.
<br>

**Server Information** is just that, information about the server such as:
- Players currently online
- Time In-Game
- How long ago Map Wipe was
- Time till day/night
- Map Size
- Map Seed
- Map Salt
- Map Name
- Connect information for join through In-Game console
<br>

**Event Information** shows event activities In-Game such as:
- Cargoship
- Patrol Helicopter
- Small Oil Rig
- Large Oil Rig
- Chinookk 47
<br>

**Team Member Information** shows the entire team. Whos online/offline/afk/alive/dead, location, leader and paired.

![Discord Text Channel Information](images/channels/information_channel.png)


## Servers Channel

> The Server Channel lists all the paired Rust Servers. Given that you have setup your Credentials properly, once you pair a Rust Server In-Game via `ESC -> Rust+ -> Pair With Server`, it should automatically appear in the `servers` channel. From there you can decide which server you want the bot to connect to by clicking the `CONNECT` button for that server.

The server embed displays a bunch of information. The title of the embed is the name of the server. The Battlemetrics Id is also displayed as well as if the server is streamer mode or not. The Description of the embed is basically the description of the Rust Server. Here you can also find the connect information that could be found in `information` channel. You can also see who is the hoster of the bot for the server.
<br>

There are a few buttons for each server. The `CONNECT` button lets you start a connection to the server. Once connected you can disconnect by clicking the `DISCONNECT` button. By clicking the `WEBSITE` button, you will be re-directed to the Rust Servers website. By clicking the `BATTLEMETRICS` button, you will be re-directed to the Battlemetrics page for the Rust Server. By clicking the `EDIT` button, you can change the `Battlemetrics Id` for the server. By clicking the `CUSTOM TIMERS` button, you can change Custom Timers for Cargoship egress time and time before a Locked Crate at Oil Rig is unlocked. By clicking the `CREATE TRACKER` button, you create a battlemetrics tracker that will appear in the `trackers` Text-Channel on Discord. By clicking the `CREATE GROUP` button, you create a Smart Switch Group that can be used to manage several Smart Switches at once. The Smart Switch Group will appear in the `switchgroups` Text-Channel on Discord. To remove the Server, just click the trashcan button.

![Discord Text Channel Servers](images/channels/servers_channel.png)


## Settings Channel

> The Settings Channel exposes the bot's configuration as button-driven toggles. Notable settings include: command prefix, trademark visibility, allow in-game commands, mute in-game, Smart Alarm + Smart Switch in-game notifications, leader command, Battlemetrics notifications, wipe detection, **translate non-English/German team chat**, and the per-event notification toggles (Cargo Ship docking / docked / undocking / leaving / locked-crate spawn, Patrol Heli, Chinook, Oil Rig, Deep Sea, etc.).

![Discord Text Channel Settings](images/channels/settings_channel.png)


## Commands Channel

> The Commands Channel allows you to run In-Game Commands straight from Discord.

![Discord Text Channel Commands](images/channels/commands_channel.png)


## Events Channel

> The Events Channel collects automatic event notifications:

**Cargo Ship lifecycle:** spawn / located / docking / docked / undocking / undocking-soon (70s warning) / leaving (certain or "maybe") / leaves-map / despawn, plus locked-crate spawn alerts (3 expected rounds).
**Patrol Helicopter:** spawn, despawn, destroyed.
**Oil Rig:** locked-crate unlock countdown, heavy scientists called.
**Other:** Chinook 47 spawn, Deep Sea event spawn/leave, new vending machine detected, Traveling Vendor.

Each event type has its own setting in the Settings channel that controls whether notifications go to Discord, in-game, or both.

![Discord Text Channel Events](images/channels/events_channel.png)


## Teamchat Channel

> The Teamchat Channel makes it possible to communicate with your teammates In-Game. What you write in `teamchat` Channel appears In-Game and whatever you write In-Game appears in the `teamchat` Channel.

![Discord Text Channel Teamchat](images/channels/teamchat_channel.png)


## Teamchat-Translated Channel

> When the **Translate non-English/German team-chat messages** setting is enabled in the Settings channel, any player message that the bot detects as something other than English or German is translated to English and posted here. The original message is quoted below the translation. Detection uses an offline trigram model (franc-min); very short messages are skipped because they're unreliable to identify.
>
> Translation backend: when the bot is started with `RPP_LIBRETRANSLATE_URL` pointing at a LibreTranslate sidecar (see [Deploying in the README](../README.md#deploying)), all translation happens locally with no rate limits. Without that env var the bot falls back to the `translate` package's free Google web endpoint, which often returns the source text unchanged — the embed header will then read `(<lang> → en, translator no-op)` so the source is still visible.


## Switches Channel

> The Switches Channel lists all the paired Smart Switches. See [Smart Devices](smart_devices.md#smart-switches).


## Switch Groups Channel

> The Switch Groups Channel lists all groups of Smart Switches. See [Smart Devices](smart_devices.md#smart-switch-groups).


## Alarms Channel

> The Alarms Channel lists all the paired Smart Alarms. See [Smart Devices](smart_devices.md#smart-alarms).


## Storagemonitors Channel

> The Storagemonitors Channel lists all the paired Storage Monitors. See [Smart Devices](smart_devices.md#storage-monitors).

## Activity Channel

> The Activity Channel is used to display a bunch of different things such as team member joined/ left/ connected/ disconnected/ killed/ offline killed, Not found notifications from Smart Devices, Smart Alarm notifications, Decaying notifications, Tracker information, Server went down/up notifications, facepunch news, Battlemetrics notifications etc...

![Discord Text Channel Activity](images/channels/activity_channel.png)


## Trackers Channel

> The Trackers Channel is used to keep track of players or groups on a specific server. Create a tracker via the `CREATE TRACKER` button in the `servers` channel.

The Tracker embed shows:

- **Title** — tracker name; **Battlemetrics Id**, **Server Id**, server status, streamer mode, optional clan tag in the description.
- **Group active line** in the description — when enough samples have been collected, shows the group's typical play window (e.g. `Group active: ~18–23 daily`).
- **Per-player rows** — plain player name with small `B` and `S` markdown links to Battlemetrics and Steam profiles, plus the current online/offline status, current session time, and the player's individual active-hours hint when available.

### Buttons

- `ADD PLAYER` / `REMOVE PLAYER` — opens a modal that accepts a plain Steam/BM ID **or** a full Steam/Battlemetrics profile URL. For autocomplete-driven adding, use the `/tracker add` slash command instead.
- `EDIT` — change tracker name, Battlemetrics Id, and clan tag.
- `IN-GAME` toggle — also announce connect/disconnect events to in-game team chat.
- `@everyone` toggle — ping `@everyone` on connect/disconnect.
- **`RAID ALERT`** toggle — when ≥60% of the tracker is online during a quiet hour (determined from 30 days of polling history), fire `@everyone` in the activity channel and a force-message in team chat. 30-minute cooldown. Needs ~a week of polling data before it'll fire.
- `UPDATE` — re-render the embed now.
- 🗑️ — delete the tracker.

![CREATE TRACKER](images/channels/tracker_create.png)
![Discord Text Channel Trackers](images/channels/trackers_channel.png)