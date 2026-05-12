# Feature Overview

A high-level inventory of what this fork can do. For setup, see [documentation.md](documentation.md); for the exhaustive command reference see [commands.md](commands.md).

## Discord Slash Commands

| Command | Purpose |
| --- | --- |
| `/alarm` | Edit a Smart Alarm (name, message, command, image, **event tag**). |
| `/alias` | Custom command aliases. |
| `/blacklist`, `/whitelist`, `/ingameaccess` | User-level access control. |
| `/credentials` | FCM credentials management. |
| `/help` | Doc links. |
| `/item` | Item name/ID lookup. |
| `/leader` | Transfer leadership. |
| `/map` | Show the server map. |
| `/players` | Battlemetrics player lookup. |
| `/reset`, `/role` | Channel + role administration. |
| `/storagemonitor`, `/switch` | Edit smart-device images. |
| **`/tracker`** | **Add, remove or list players on a tracker — with native Discord autocomplete on both options.** |
| `/uptime` | Bot + server uptime. |

## In-Game Commands

Server / event info: `cargo`, `chinook`, `deepsea`, `events`, `heli`, `large`, `pop`, `small`, `time`, `vendor`, `wipe`.
Team utilities: `afk`, `alive`, `connection(s)`, `death(s)`, `leader`, `marker(s)`, `mute`, `note(s)`, `offline`, `online`, `player(s)`, `prox`, `send`, `steamid`, `team`, `timer(s)`, `unmute`, `uptime`.
Translation: `tr`, `trf`.

**`!cargo`** is enriched in this fork — see [commands.md](commands.md#cargo) for the `!cargo timer` subcommand and the rich summary output.

## Smart Devices

Pair Smart Switches, Smart Alarms, Smart Switch Groups, and Storage Monitors. Control from Discord buttons or in-game commands. See [smart_devices.md](smart_devices.md).

**Smart Alarm event tags** — tag an alarm with an event name (e.g. `Large Excavator`) and the bot will announce both start AND stop of the powered event in the activity channel and team chat. Set via the **Edit** button on the alarm in the `alarms` channel.

## Trackers

Battlemetrics-backed tracking of specific players. Each tracker shows:

- Plain player name plus small `B` and `S` markdown links to Battlemetrics and Steam profiles
- Online / offline status with current-session duration
- **Active-hours hint** per player (e.g. `~18–23 daily`) — computed from a local SQLite log of polling snapshots aggregated over 30 days
- **Group active-window line** in the tracker embed showing roughly when the whole group plays
- Per-tracker **RAID ALERT** toggle — fires `@everyone` in Discord and a force-message in team chat when ≥60% of the tracker is online during a quiet hour (30 min cooldown)

## Cargo Ship Lifecycle

Full state machine with toggleable Discord notifications for each transition:

- Spawn → Docking → Docked → Undocking → Leaving → Despawn
- Locked-crate spawn alerts (3 expected rounds)
- 70-second "undocking soon" warning
- Multi-harbor visit tracking
- Direction-based "is leaving" fallback for maps without harbors

In-game queries via `!cargo` and `!cargo timer`.

## Other In-Game Event Notifications

Patrol Helicopter (spawn / despawn / destroyed), Oil Rig heavy scientists and crate timers, Chinook 47, Traveling Vendor, Deep Sea event detection, and new-vending-machine markers.

## Discord Text Channels

- `information` — auto-updating server status, map, team summary
- `servers` — paired servers (connect / disconnect / create tracker / etc.)
- `settings` — toggle settings via buttons
- `commands` — run in-game commands from Discord
- `events` — automatic event notifications
- `teamchat` — bidirectional bridge to in-game team chat
- **`teamchat-translated`** — non-English/German player messages translated to English (opt-in toggle in settings)
- `switches`, `switchgroups`, `alarms`, `storagemonitors` — smart device control
- `activity` — connect/disconnect, smart-device unreachable, tracker events, raid alerts, wipe detection, etc.
- `trackers` — Battlemetrics tracker embeds

See [discord_text_channels.md](discord_text_channels.md).

## Bot Internals

- Smart switch on/off announcements bypass the in-game mute setting (same as Smart Alarms)
- Battlemetrics request queue + 0–30s poll-cycle jitter to avoid API bursts
- Steam profile name scraping throttled to once per 24 h per player
- Day/night transition broadcasts (`It's getting dark!` / `It's getting light!`)
- Battlemetrics upcoming wipes display in server embed
- Alarm-triggered switch groups (auto-activate after N triggers)
- Shorthand `!timer <time> [message]` (no `add` subcommand needed)
- Asset-path monument tokens are no longer drawn over the map

## What was removed in this fork

These features exist in the upstream but were dropped here to slim the codebase:

- RustLabs lookup commands (`/craft`, `/decay`, `/despawn`, `/recycle`, `/research`, `/stack`, `/upkeep`) and their ~21 MB of static data — use [rustlabs.com](https://rustlabs.com) directly
- Vending-machine item-subscription system (`/market`, `!market sub`, etc.) — new-vending-machine markers still announce
- CCTV codes (`/cctv`)
- In-game `!tts` and the `sendTTSMessage` helper
- Battlemetrics "all online players" widget in the info channel
