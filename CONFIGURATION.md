# Configuration

The bot is configured in three places: **environment variables** (process-wide, set at deploy time),
the **Discord `settings` channel** (per-guild toggles the bot renders as buttons/selects), and
**per-device / per-tracker** controls exposed in each entity's embed.

## Environment variables

All variables are prefixed `RPP_`. Only the two Discord credentials are required; the rest have
sensible defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `RPP_DISCORD_TOKEN` | — | **Required.** Discord bot token. |
| `RPP_DISCORD_CLIENT_ID` | — | **Required.** Discord application (client) ID. |
| `RPP_DISCORD_USERNAME` | `rustplusplus` | Display name the bot registers under. |
| `RPP_NEED_ADMIN_PRIVILEGES` | `true` | When `true`, only Discord admins can delete servers/switches, manage credentials and reset channels. Set to the string `false` to allow non-admins. |
| `RPP_POLLING_INTERVAL` | `10000` | Rust+ poll interval in ms. Lower = faster reactions, more API traffic. |
| `RPP_RECONNECT_INTERVAL` | `15000` | Delay in ms before reconnecting after a dropped Rust+ connection. |
| `RPP_BATTLEMETRICS_TOKEN` | _(empty)_ | Battlemetrics API token. Their API requires an authenticated (paid) key for the server/player endpoints. Overridden by a token set with `/battlemetrics set`. With neither set, the Battlemetrics integration is disabled and the rest of the bot runs normally. |
| `RPP_BM_REQUEST_SPACING_MS` | `1500` | Minimum gap in ms between two Battlemetrics API requests in the global queue. Raise it to spread the per-cycle burst of server polls over a wider window when many trackers trip Battlemetrics rate limits. |
| `RPP_BM_REQUEST_JITTER_MS` | `1500` | Extra random delay (0…this) added on top of the spacing for each Battlemetrics request, so calls don't fire on a fixed cadence. |
| `RPP_STEAM_RESOLVE_INTERVAL_MS` | `300000` (5m) | Process-wide minimum gap between two background Steam requests. Steam is used only to bootstrap a tracked SteamID into a Battlemetrics player id; once that link exists the player's name comes from Battlemetrics and Steam is never contacted for them again. Raise it if Steam still refuses the host. |
| `RPP_TRACKER_RESOLVE_PER_CYCLE` | `3` | How many still-unresolved tracked players the resolver examines per 60 s poll cycle. Never-attempted players are always examined first, so adding a player is never starved by the retry backlog. |
| `RPP_STEAM_NAME_CACHE_MS` | `21600000` (6h) | How long a scraped Steam persona name is reused by the callers that opt in (the tracker resolver and `/blacklist show` / `/whitelist show`). Set to `0` to disable the cache. |
| `RPP_TRACKER_HOURS_REFRESH_MS` | `86400000` (24h) | How long a tracked player's lifetime Rust hours stay fresh before being re-fetched from Battlemetrics. Set to `0` to switch the feature off — no requests are made and no figure is rendered on the tracker card. |
| `RPP_TRACKER_HOURS_PER_CYCLE` | `1` | How many of those refreshes a single 60 s poll cycle may spend, so the added load stays constant no matter how many players are tracked. Raise it to fill a large roster in faster on first run, at the cost of more Battlemetrics requests per cycle. |
| `RPP_LIBRETRANSLATE_URL` | _(bundled)_ | LibreTranslate base URL for the translated team-chat channel. The Docker image runs a bundled instance on `127.0.0.1:5000` by default. Point at an external instance to override; set to an empty string to disable the LibreTranslate path entirely (falls back to the rate-limited Google web endpoint). |
| `RPP_LIBRETRANSLATE_API_KEY` | _(empty)_ | API key for the LibreTranslate instance above, if it requires one. |
| `RPP_LOG_CALL_STACK` | `false` | Set to the string `true` to include call-stack traces in error logs. |

> `RPP_NEED_ADMIN_PRIVILEGES` and `RPP_LOG_CALL_STACK` are parsed as strict booleans — the bot compares
> the value to the literal string `true`/`false`, so `RPP_NEED_ADMIN_PRIVILEGES=false` actually disables
> the check.

## Discord `settings` channel

These appear as buttons/selects in the guild's `settings` channel.

| Setting | Default | What it does |
| --- | --- | --- |
| **In-game command access mode** (`inGameCommandAccessMode`) | `blacklist` | Switch in-game command gating between `blacklist` and `whitelist` mode (see the `/blacklist` and `/whitelist` slash commands). |
| **Smart Alarm bypass mute** (`smartAlarmBypassMute`) | `true` | Smart Alarm announcements are still sent to in-game team chat even while the bot is muted in-game. |
| **Custom Alarm bypass mute** (`customAlarmBypassMute`) | `false` | Same bypass for the RF-event "custom alarm" announcements (see [RF event tags](#per-smart-alarm-setting--rf-event-tag)). |
| **Smart Switch bypass mute** (`smartSwitchBypassMute`) | `true` | Smart Switch on/off announcements bypass the in-game mute. |
| **Battlemetrics upcoming wipes** (`displayInformationBattlemetricsUpcomingWipes`) | `false` | Show Battlemetrics-reported upcoming wipes in the server info embed. |
| **Team-chat translation** (`teamChatTranslateEnabled`) | `false` | Enable the `teamchat-translated` channel that translates non-EN/DE player messages to English. |
| **Log channel** (`logChannelEnabled`) | `true` | Mirror the bot's log output into the `logs` channel. Bot-wide lines are only mirrored on single-guild deployments. |
| **Mention user IDs** (`mentionUserIds`) | `[]` | Discord user IDs to `@`-mention on raid/alert events. |

## Event notification toggles

Each event in the `settings` channel has an independent **Discord** and **in-game** toggle. The Cargo
Ship lifecycle and the Deep Sea events add:

| Event setting | Notes |
| --- | --- |
| `cargoShipDockingAtHarborSetting` | Ship approaching a harbor. |
| `cargoShipDockingSetting` / `cargoShipDockedSetting` | State machine: docking → docked. |
| `cargoShipUndockingSetting` | Ship undocking; pairs with the 70 s "undocking soon" warning. |
| `cargoShipLeavingSetting` | Ship leaving the harbor / map. |
| `cargoShipLockedCrateSpawnedSetting` | Each of the 3 expected locked-crate spawns on the ship. |
| `deepSeaDetectedSetting` / `deepSeaLeftMapSetting` | Deep Sea monument appear / leave. |

Related in-game commands: **`!cargo`** (rich per-ship summary) and **`!cargo timer`** (sorted list of
pending timers).

## Per-tracker setting — Pause tracking (ACTIVE / PAUSED)

Each tracker embed has an **ACTIVE / PAUSED** button (stored as `active` on the tracker, default on).
Click it to **pause** a tracker: while paused the bot makes **no API calls** for it at all — no
Battlemetrics server poll and no per-player Steam profile scrape — and its linked Battlemetrics
instance is torn down on the next poll cycle (unless the active server or another *active* tracker
still needs the same server). This is the lever for staying under Battlemetrics/Steam rate limits when
tracking a lot of players: pause the trackers you don't need live right now and re-enable them on
demand. The tracker embed shows a `Tracking: PAUSED ⏸️` line so paused trackers are obvious at a
glance. Trackers created before this field existed default to active.

## Per-tracker setting — Off-hours RAID ALERT

Each tracker embed has a **RAID ALERT** button (stored as `raidAlert` on the tracker, default off).
When enabled and the tracker has ≥2 players, the bot fires an `@everyone` Discord alert plus a forced
in-game team-chat message when **≥60 %** of the tracker is online during a statistically *quiet* hour
for the group, with a **30-minute** cooldown. The "quiet hour" determination uses the local SQLite
activity log (a group hour counts as off-peak below the **20 %** activity threshold). Thresholds are
defined in [`src/handlers/battlemetricsHandler.js`](src/handlers/battlemetricsHandler.js).

## Per-Smart-Alarm setting — RF event tag

In a Smart Alarm's **Edit** modal, the **event tag** field (`eventTag`) lets you name the in-game event
the alarm's RF receiver is wired to (e.g. `Large Excavator`, `Cargo Ship`). When set, the bot announces
**both the start and the stop** of that event in the activity channel and team chat — useful for
powered events the Rust+ API doesn't expose directly.
