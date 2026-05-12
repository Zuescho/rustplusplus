# Commands

> Commands can be executed via Discord or In-Game Team Chat. To use Slash Commands in Discord, you must be in the role configured via `/role` (or have no role configured, in which case anyone can use them). In-Game commands work from Team Chat only (not global chat), and can also be issued from the Discord `commands` text-channel.

- [Discord Slash Commands](#discord-slash-commands)
- [In-Game Commands](#in-game-commands)

---

# Discord Slash Commands

| Command | Description |
| --- | --- |
| [**/alarm**](#alarm) | Edit a Smart Alarm (name, message, command, image, **event tag**). |
| [**/alias**](#alias) | Create custom aliases for commands. |
| [**/blacklist**](#blacklist) | Block a user from using the bot. |
| [**/credentials**](#credentials) | Add/remove FCM credentials for an account. |
| [**/help**](#help) | Show help links. |
| [**/ingameaccess**](#ingameaccess) | Allow/deny specific users for in-game commands. |
| [**/item**](#item) | Look up an item by name or ID. |
| [**/leader**](#leader) | Transfer team leadership. |
| [**/map**](#map) | Show the server map image. |
| [**/players**](#players) | Battlemetrics player lookup. |
| [**/reset**](#reset) | Reset Discord channels managed by the bot. |
| [**/role**](#role) | Set/clear the role required to use the bot. |
| [**/storagemonitor**](#storagemonitor) | Edit a Storage Monitor's image. |
| [**/switch**](#switch) | Edit a Smart Switch's image. |
| [**/tracker**](#tracker) | **Add, remove or list players on a tracker (with autocomplete).** |
| [**/uptime**](#uptime) | Show bot and server uptime. |
| [**/whitelist**](#whitelist) | Manage the bot whitelist. |

## /alarm

Edit a Smart Alarm.

| Subcommand | Option | Description |
| --- | --- | --- |
| `edit` | `id` | The ID of the Smart Alarm. *(required)* |
| | `image` | Image used in the embed. *(required)* |

You can also click the **Edit** button on an alarm in the `alarms` channel to set its name, message, command, and the new **Event tag** field. When an event tag is set (e.g. `Large Excavator`), the alarm announces both start AND stop in the activity channel and team chat — useful for RF-receiver-driven events.

![/alarm](images/slash_commands/alarms_edit.png)

## /alias

| Subcommand | Option |
| --- | --- |
| `add` | `alias`, `value` |
| `remove` | `index` |
| `show` | |

![/alias](images/slash_commands/alias.png)

## /blacklist

| Subcommand | Option |
| --- | --- |
| `add` | `discord_user` and/or `steamid` |
| `remove` | `discord_user` and/or `steamid` |
| `show` | |

![/blacklist](images/slash_commands/blacklist.png)

## /credentials

Pair FCM credentials so the bot can receive Rust+ push notifications.

| Subcommand | Option |
| --- | --- |
| `add` | `gcm_android_id`, `gcm_security_token`, `steam_id`, `issued_date`, `expire_date`, optional `hoster` |
| `remove` | `steam_id` *(optional)* |
| `show` | |
| `set_hoster` | `steam_id` *(optional)* |

See [Credentials](credentials.md).

![/credentials](images/slash_commands/credentials.png)

## /help

Posts links to the docs.

![/help](images/slash_commands/help.png)

## /ingameaccess

Per-Steam-ID gate for the in-game command interface.

## /item

Look up an item by name or ID. Returns a minimal item card (title + ID). For detailed item stats — recipes, decay, recycle output, etc. — use **[rustlabs.com](https://rustlabs.com)** directly; the RustLabs lookup commands were removed from this fork.

| Option | Description |
| --- | --- |
| `name` | Item name (fuzzy-matched). |
| `id` | Numeric item ID. |

![/item](images/slash_commands/item.png)

## /leader

Give or take team leadership from a member.

![/leader](images/slash_commands/leader.png)

## /map

| Subcommand | Description |
| --- | --- |
| `all` | Monuments + markers. |
| `clean` | No overlays. |
| `monuments` | Monument names only. |
| `markers` | Markers only. |

![/map](images/slash_commands/map.png)

## /players

Battlemetrics-backed player lookup. Search by name or by player ID; optionally scoped to a specific Battlemetrics server.

![/players](images/slash_commands/players.png)

## /reset

Recreates channels managed by the bot. Useful after a bot upgrade if a channel's layout looks stale.

![/reset](images/slash_commands/reset.png)

## /role

Limit (or open) bot usage to a specific Discord role.

| Subcommand | Description |
| --- | --- |
| `set` | Set the role. *(required: `role`)* |
| `clear` | Anyone can use the bot. |

![/role](images/slash_commands/role.png)

## /storagemonitor

Edit a Storage Monitor's image (button-driven UI lives in the `storagemonitors` channel).

![/storagemonitor](images/slash_commands/storagemonitor.png)

## /switch

Edit a Smart Switch's image (button-driven UI lives in the `switches` channel).

![/switch](images/slash_commands/switch.png)

## /tracker

**Native Discord autocomplete on both options** — start typing and pick from the dropdown.

| Subcommand | Option | Description |
| --- | --- | --- |
| `add` | `tracker` | Pick the tracker. Autocomplete suggests trackers by name. |
| | `player` | Pick a player. Autocomplete merges the bot's online cache with a Battlemetrics search scoped to the tracker's server. |
| `remove` | `tracker` | Pick the tracker. |
| | `player` | Autocomplete suggests only players currently on that tracker. |
| `list` | `tracker` *(optional)* | List trackers, or list one tracker's players. |

The legacy "Add player" button + modal in the `trackers` channel still works for pasting raw IDs or full Steam / Battlemetrics URLs.

## /uptime

| Subcommand | Description |
| --- | --- |
| `bot` | Bot uptime. |
| `server` | Connected server uptime. |

![/uptime](images/slash_commands/uptime.png)

## /whitelist

Steam ID whitelist for the in-game command interface.

---

# In-Game Commands

Use a `!` prefix in team chat (the prefix is configurable in the settings channel).

| Command | Description |
| --- | --- |
| [**afk**](#afk) | Teammates inactive (no movement) for >5 min. |
| [**alive**](#alive) | Player with the longest time alive — or a specific teammate. |
| [**cargo**](#cargo) | **Rich Cargo Ship summary; subcommands for timers.** |
| [**chinook**](#chinook) | Chinook 47 location / last seen. |
| [**connection** / **connections**](#connection--connections) | Recent team connection events. |
| [**death** / **deaths**](#death--deaths) | Recent team death events. |
| [**deepsea**](#deepsea) | Deep Sea event status. |
| [**events**](#events) | Recent in-game events (filterable: cargo, heli, small, large, chinook). |
| [**heli**](#heli) | Patrol Helicopter location / last on map / last destroyed. |
| [**large**](#large) | Large Oil Rig crate timer. |
| [**leader**](#leader-1) | Take or give leadership. |
| [**marker** / **markers**](#marker--markers) | Personal map markers. |
| [**mute**](#mute) | Mute the bot in team chat (Smart Alarms still announce). |
| [**note** / **notes**](#note--notes) | Personal notes. |
| [**offline** / **online**](#offline--online) | Offline/online teammates. |
| [**player** / **players**](#player--players) | Battlemetrics info on currently-online players. |
| [**pop**](#pop) | Server population (current / queue / max). |
| [**prox**](#prox) | Distance to closest teammates. |
| [**send**](#send) | Send a Discord DM to a configured user. |
| [**small**](#small) | Small Oil Rig crate timer. |
| [**steamid**](#steamid) | Get a teammate's Steam ID. |
| [**team**](#team) | List team members. |
| [**time**](#time) | In-game time + time until day/night. |
| [**timer** / **timers**](#timer--timers) | Personal countdown timers. |
| [**tr**](#tr) | Translate text to another language. |
| [**trf**](#trf) | Translate text between two languages. |
| [**unmute**](#unmute) | Unmute the bot in team chat. |
| [**uptime**](#uptime-1) | Bot + server uptime. |
| [**vendor**](#vendor) | Traveling Vendor location. |
| [**wipe**](#wipe) | Time since the last wipe. |

## afk

`!afk` — inactive teammates (no XY movement for >5 min).

![!afk](images/ingame_commands/afk_ingame.png)

## alive

`!alive` — longest-alive teammate.
`!alive <name>` — alive time for a teammate.

![!alive](images/ingame_commands/alive_ingame.png)

## cargo

Rich Cargo Ship intel. With no subcommand, returns a per-ship summary including current state (sailing / docking / docked / undocking / leaving) and the most relevant pending timer.

| Form | Description |
| --- | --- |
| `!cargo` | Per-ship summary line. |
| `!cargo timer` | Sorted list of all pending cargo timers (locked-crate spawn, undocking-soon, egress, leaves-map). |

![!cargo](images/ingame_commands/cargo_ingame.png)

## chinook

`!chinook`

![!chinook](images/ingame_commands/chinook_ingame.png)

## connection / connections

`!connections` — recent connect/disconnect events for the team.
`!connection <name>` — events for a specific teammate.

![!connection](images/ingame_commands/connection_ingame.png)

## death / deaths

`!deaths` — recent deaths for the team.
`!death <name>` — deaths for a specific teammate.

![!death](images/ingame_commands/death_ingame.png)

## deepsea

Deep Sea event status (location and ETA).

## events

`!events` — last 5 events.
`!events 3` — last 3.
`!events cargo` — last 5 from one type.
`!events cargo 2` — last 2 from one type.

Filterable types: `cargo`, `heli`, `small`, `large`, `chinook`.

![!events](images/ingame_commands/events_ingame.png)

## heli

`!heli`

![!heli](images/ingame_commands/heli_ingame.png)

## large

`!large`

![!large](images/ingame_commands/large_ingame.png)

## leader

`!leader` — claim leadership.
`!leader <name>` — give leadership to a teammate.

![!leader](images/ingame_commands/leader_ingame.png)

## marker / markers

| Form | Description |
| --- | --- |
| `!marker add <name>` | Add a marker at current location. |
| `!marker remove <id>` | Remove a marker. |
| `!marker <name>` | Navigate back to a marker (sets a personal map pin). |
| `!markers` | List all your markers. |

![!marker](images/ingame_commands/marker_ingame.png)

## mute

`!mute` — silences most bot chatter in team chat. Smart Alarms, raid alarms, and tagged-alarm events still bypass the mute.

![!mute](images/ingame_commands/mute_ingame.png)

## note / notes

| Form | Description |
| --- | --- |
| `!note add <text>` | Add a note. |
| `!note remove <id>` | Remove a note. |
| `!notes` | List all notes. |

![!notes](images/ingame_commands/notes_ingame.png)

## offline / online

`!offline`, `!online`

![!offline](images/ingame_commands/offline_ingame.png)
![!online](images/ingame_commands/online_ingame.png)

## player / players

`!players` — all currently-online players on the server (Battlemetrics).
`!player <name>` — info for a specific player.

![!players](images/ingame_commands/players_ingame.png)

## pop

`!pop`

![!pop](images/ingame_commands/pop_ingame.png)

## prox

`!prox` — distance to the three closest teammates.
`!prox <name>` — distance to a specific teammate.

![!prox](images/ingame_commands/prox_ingame.png)

## send

`!send <discord-user> <message>` — DM a configured Discord user.

![!send](images/ingame_commands/send_ingame.png)

## small

`!small`

![!small](images/ingame_commands/small_ingame.png)

## steamid

`!steamid <name>`

![!steamid](images/ingame_commands/steamid_ingame.png)

## team

`!team`

![!team](images/ingame_commands/team_ingame.png)

## time

`!time` — in-game time and time until day/night.

![!time](images/ingame_commands/time_ingame.png)

## timer / timers

| Form | Description |
| --- | --- |
| `!timer <time> [message]` | Shorthand form — no `add` subcommand needed. |
| `!timer add <time> <text>` | Long form. |
| `!timer remove <id>` | Remove a timer. |
| `!timers` | List all timers. |

Time format: `2h15m`, `15m10s`, etc. — no spaces between units.

![!timer](images/ingame_commands/timer_ingame.png)

## tr

`!tr <language-code> <text>` — translate text *to* a language.
`!tr language <language-name>` — get the ISO code for a language name.

![!tr](images/ingame_commands/translateTo_ingame.png)
![!tr language](images/ingame_commands/language_code_ingame.png)

## trf

`!trf <from> <to> <text>` — translate text from one language to another.

![!trf](images/ingame_commands/translateFrom_ingame.png)

## unmute

`!unmute`

![!unmute](images/ingame_commands/unmute_ingame.png)

## uptime

`!uptime` — bot + connected-server uptime.

![!uptime](images/ingame_commands/uptime_ingame.png)

## vendor

`!vendor`

![!vendor](images/ingame_commands/vendor_ingame.png)

## wipe

`!wipe`

![!wipe](images/ingame_commands/wipe_ingame.png)
