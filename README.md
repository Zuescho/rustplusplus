<p align="center">
  <img src="Node.js.webp" alt="rustplusplus logo" width="200" />
</p>

<h1 align="center"><em><b>rustplusplus</b> ~ Rust+ Discord Bot (Fork)</em></h1>

<p align="center">
A trimmed, focused fork of <a href="https://github.com/alexemanuelol/rustplusplus">alexemanuelol/rustplusplus</a> with selected
fixes from <a href="https://github.com/FaiThiX/rustplusplus">FaiThiX/rustplusplus</a> and custom features for small,
active raid groups.
</p>

<p align="center">
For setup, pairing and credential instructions see the <a href="https://github.com/alexemanuelol/rustplusplus">upstream repository</a>.
</p>

---

## Headline features in this fork

### (◉‿◉) Smarter tracker

- **`/tracker add|remove|list`** slash command with **native Discord autocomplete** on both the tracker and player options. Player search merges the bot's online cache with a Battlemetrics server-scoped lookup, raced against Discord's 3-second budget.
- **Lifetime Rust hours** next to each tracked player (e.g. `🟢 [02:14] · 1.4k h`), summed from Battlemetrics' per-server playtime. This is time on servers Battlemetrics tracks, so it is a floor rather than the figure in the Steam library. Refreshed about once a day per player, one lookup per poll cycle — see `RPP_TRACKER_HOURS_REFRESH_MS`.
- **Active-hours hint** per player (e.g. `~18–23 daily`), computed from a local SQLite log of polling snapshots aggregated over 30 days. Shown behind the `REPORT` button so the inline player list stays scannable.
- **Group active-window line** in the tracker embed showing roughly when the whole group plays.
- **Off-hours RAID ALERT** (per-tracker opt-in): when ≥60 % of the tracker is online during a quiet hour, fires `@everyone` in Discord and a force-message in team chat, with a 30 min cooldown.
- Player rows now show **plain name + small B / S markdown links** to Battlemetrics and Steam profiles.
- Modal accepts a plain ID **or** a full Steam/BM profile URL.

### ┌[¯|¯]┘ Cargo Ship lifecycle (slim port of FaiThiX 421aa27)

- Full state machine: **docking → docked → undocking → leaving**, each with its own toggleable Discord notification.
- **Locked-crate spawn alerts** for each of the 3 expected spawns on the ship.
- Multi-harbor visit tracking; "undocking soon" 70-second warning.
- New in-game commands: **`!cargo`** (rich per-ship summary) and **`!cargo timer`** (sorted list of pending timers).
- Direction-based "is leaving" fallback for maps without harbors.

### (°ロ°)! Smart Alarm RF event tagging

Tag a Smart Alarm in the Edit modal with an event name (e.g. `Large Excavator`, `Cargo Ship`). When the linked RF receiver
fires, the bot announces **both start AND stop** in the activity channel and team chat — perfect for tracking
powered in-game events the Rust+ API doesn't expose directly.

### (=・ω・)ﾉ Translated team chat channel

A dedicated `teamchat-translated` channel that automatically translates non-English/German player messages into English.
Detection is fully offline (`franc-min`). A **bundled LibreTranslate** with the Spanish → English model ships inside the
Docker image and handles all Spanish lines locally — no rate limits, no API key, no external container. Other detected
languages fall back to the `translate` package's free Google web endpoint. Toggleable in settings, defaults to off.

### (⌐■_■) Battlemetrics API token

Battlemetrics now requires an authenticated (paid) API key for the server and player endpoints the bot uses. Set it with
the **`/battlemetrics set`** slash command (administrators only; stored in `credentials/battlemetrics.json`) or with the
`RPP_BATTLEMETRICS_TOKEN` environment variable — the slash command wins if both are present. **`/battlemetrics status`**
shows whether the integration is live, where the token came from and how many servers are being polled;
**`/battlemetrics clear`** forgets the stored token.

With no token the entire Battlemetrics integration switches itself off — no requests, no 401 spam in the log — while the
rest of the bot (Rust+ connection, switches, alarms, team chat, events) keeps working. Setting a token takes effect on
the next poll cycle; no restart needed.

### (¬_¬) Mute a teammate from the Discord relay

**`/mute add|remove|list`** stops a teammate's in-game chat from being posted to the Discord `teamchat` channels. The
usual case is a second bot sharing the team: it echoes every notification into team chat, which then duplicates
everything the Discord side already posted. Muting affects the Discord relay only — the player still counts for the
team and their in-game commands still work. Both `add` and `remove` autocomplete over the live team roster / muted list,
and a raw SteamID64 is accepted too.

### (っ˘ω˘ς) Discord log channel

A `logs` channel that mirrors the bot's log output, so you can see what the bot is doing without shelling into the host
and tailing `logs/*.log`. Lines are batched into one code-block message every two seconds, the buffer is bounded (with
an explicit `… N lines dropped` marker rather than a silent gap), and a failing send can never feed itself back into
the log. Toggleable in the `settings` channel, defaults to on. Bot-wide log lines are only mirrored when the bot serves
a single Discord server — in a multi-guild deployment they would leak one guild's activity into another guild's private
channel; they always remain in `logs/discordBot.log`.

A pass over the codebase also gave a voice to the failures that used to happen in complete silence. The ones worth
knowing about: the activity database refusing to open (which silently disables the active-hours hints, the tracker
activity report **and** the off-hours raid alarm for the whole run); an in-game message that was queued and then
dropped, which previously still logged as sent; a leadership transfer that did not take; a Battlemetrics player search
or playtime lookup that keeps coming back empty; a server name that matches no Battlemetrics server exactly; channel
permissions that could not be applied; and an active server that is selected but missing from the server list, which
stops the bot connecting at all.

Every one of these is either once per process, once per outage, or tied to something you did — none of them fire on the
10 s or 60 s poll, so a healthy bot is exactly as quiet as it was before.

### (ﾉ◕ヮ◕)ﾉ Built-in Rust+ API client

The bot no longer depends on a git-pinned fork of [rustplus.js](https://github.com/liamcottle/rustplus.js). The library
lives in [`src/rustplus/`](src/rustplus) and is hardened for long-running use:

- the `.proto` is compiled once per process instead of on every reconnect, and now carries the `TravelingVendor` marker type;
- inbound frames are decoded once instead of twice;
- a malformed frame or a throwing response callback surfaces as an `error` event rather than an uncaught exception inside the websocket handler (which used to be able to take the process down);
- a failed protobuf load surfaces as an `error` event instead of an unhandled rejection;
- `sendRequestAsync` drops its callback on timeout, so lost responses no longer leak for the life of the connection;
- `isConnected()` no longer throws when called before `connect()`.

### (☞ﾟヮﾟ)☞ Dependencies brought up to date

Dropping the git-pinned `rustplus.js` fork unblocked the rest of the tree. Every dependency is now on its latest
major:

| Package | From | To | Notes |
| --- | --- | --- | --- |
| `jimp` | 0.22 | 1.6 | Full API rewrite — `loadFont`/`rgbaToInt` moved to named exports, `resize`/`print` take option objects, `writeAsync`→`write`, `getBufferAsync`→`getBuffer`. |
| `better-sqlite3` | 11 | 13 | Ships prebuilt binaries; no source build needed. |
| `protobufjs` | 7 | 8 | int64 fields still decode to `Long`, so nothing downstream changed. |
| `@formatjs/intl` | 2 | 4 | ESM-only. |
| `franc-min` | 5 | 6 | ESM-only, now exports named `franc`. |
| `translate` | 1 | 3 | ESM-only, default export. |

The three ESM-only packages are loaded with a plain `require()` — Node 22.12+ can require an ESM graph that has no
top-level await, which all three are. That raised the floor from `>=22.0.0` to 22.12; the TypeScript 7 change below
raised it again, to **22.18**, which is the version that actually applies now.

The `jpeg-js` resolution and the `npm-force-resolutions` preinstall hook are gone: jimp 1.x already depends on the
version that was being pinned, so the override forced exactly what npm installs anyway. Installs no longer shell out
to `npx` before resolving.

**`typescript` upgraded to 7, and `ts-node` removed.** TypeScript 7 is the native port and exposes no JavaScript
compiler API — `require('typescript')` now yields only `{ version, versionMajorMinor }`, so `ts-node` died with
`TypeError: Cannot read properties of undefined (reading 'fileExists')` before the bot loaded. Rather than rename
the entry point (34 references to `index.ts` across 23 files reach it by name), the bot now starts with plain
`node .`: Node strips the types itself, and `index.ts` has always been valid CommonJS with no TypeScript syntax in
it. `ts-node` is gone entirely and `typescript` is a devDependency used only by `npm test`.

Two consequences worth knowing. `engines.node` is now `>=22.18.0`, the release where Node documents type stripping
as enabled by default — it works on some earlier 22.x, but only from 22.18 is it guaranteed. And because startup
now depends on the entry point being *erasable*, `tsconfig.json` sets `erasableSyntaxOnly`: an `enum`, a namespace
with a runtime body or a parameter property in `index.ts` would fail at startup rather than at build time, and this
makes `npm test` reject them instead.

Note that `npm test`'s type-check step is close to a no-op: `checkJs` is `false` and `index.ts` is the only `.ts`
file, so `tsc` checks one 67-line unannotated file and merely parses the other ~120. That was equally true under
5.9 — the upgrade just makes it visible.

### ⚠ Rust+ event map marker removal

Facepunch is removing vending machine and event map markers (cargo ship, patrol helicopter, traveling vendor) from the
Rust+ API. CH47/Crate markers are **not** affected, so small/large oil rig heavy-scientist and locked-crate events keep
working unchanged.

The bot detects the change and degrades cleanly instead of firing a burst of bogus "cargo ship left the map / heli left
the map / every vending machine was destroyed" notifications at the moment the feed disappears. Vending machines are
the canary (a live map always has plenty, and they go in the same change). The first poll without them pauses event
marker diffing but keeps every bit of state — a server saving behind a still-open websocket costs at most ~2 minutes of
frozen event tracking, with no phantom notifications and nothing lost. Only after ~2 minutes of consecutive empty polls
is the feed declared gone: state and cargo timers are then dropped silently, a single warning is logged, and `!cargo`,
`!heli`, `!vendor`, `!deepsea` and the info-channel embed report the events as *unavailable* rather than as "not
currently on the map".

If the markers ever come back, tracking resumes automatically — after a real teardown the markers on the map are
adopted as a baseline rather than replayed as fresh arrivals, so nothing is re-announced and no cargo timer is armed
from a spawn time the bot cannot know. Deep sea detection is driven entirely by vending machine markers, so it goes
away with them.

### (•‿•) Other quality-of-life

- Smart switch on/off announcements bypass the in-game mute (same fix as Smart Alarms in v1.25.5).
- Battlemetrics request queue + 0–30 s poll-cycle jitter — no more burst rate-limit hits with many servers.
- Steam profile name scraping throttled to once per 6 h per player (`RPP_STEAM_NAME_CACHE_MS`).
- Day/night transition broadcasts (`It's getting dark!` / `It's getting light!`).
- Battlemetrics upcoming wipes display in server embed.
- Alarm-triggered switch groups (auto-activate after N triggers).
- Shorthand `!timer <time> [message]` (no `add` subcommand needed).
- Asset-path monument tokens are no longer drawn over the map.

### ┐(￣ヘ￣)┌ Slimmed for focus

Removed features the fork's target audience doesn't use:
- RustLabs lookup commands (`!craft / decay / despawn / recycle / research / stack / upkeep`) and their 21 MB of data — use rustlabs.com instead.
- Vending-machine item-subscription system (new-vending-machine markers still announce).
- CCTV codes command.
- In-game `!tts` and Discord `sendTTSMessage`.
- Battlemetrics "all online players" info-channel widget.
- Steam profile-avatar scraping. It only ever supplied the small icon on activity-channel embeds and death DMs, at the
  cost of a Steam profile fetch per death, login and logout — and it had been broken since Steam moved the avatar to a
  `srcset` attribute, so most notifications were already showing the default image. Embeds now use the default icon and
  still link to the Steam profile. This also removes `RPP_STEAM_AVATAR_CACHE_MS` and `RPP_STEAM_SCRAPE_DELAY_MS`.

---

## Deploying

Pull a versioned image from this fork's GHCR:

```yaml
services:
  rustplusbot:
    image: ghcr.io/zuescho/rustplusplus:tracker-autocomplete-activity
    environment:
      - RPP_DISCORD_TOKEN=TOKEN
      - RPP_DISCORD_CLIENT_ID=CLIENT_ID
    volumes:
      - ./logs:/app/logs
      - ./instances:/app/instances
      - ./credentials:/app/credentials
      - ./maps:/app/maps
    restart: unless-stopped
```

The image bundles a minimal LibreTranslate (Spanish → English only) on `127.0.0.1:5000`, started by the container's own entrypoint. Translation works out of the box — no sidecar, no API key, no network calls. To use an external LibreTranslate instead, set `RPP_LIBRETRANSLATE_URL=http://your-host:5000` at run time; setting it to an empty string disables the libre path entirely and falls back to the (rate-limited) free Google web endpoint.

Existing `instances/*.json` files are migrated in place — paired alarms, switches, trackers, settings and channel IDs all survive upgrades.

---

## Configuration & custom settings

The bot is configured in three places: **environment variables** (process-wide,
set at deploy time), the **Discord `settings` channel** (per-guild toggles the
bot renders as buttons/selects), and **per-device / per-tracker** controls
exposed in each entity's embed. The settings below are the ones this fork adds
or changes relative to [upstream](https://github.com/alexemanuelol/rustplusplus);
everything upstream documents still applies.

### Environment variables

All variables are prefixed `RPP_`. Only the two Discord credentials are
required; the rest have sensible defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `RPP_DISCORD_TOKEN` | — | **Required.** Discord bot token. |
| `RPP_DISCORD_CLIENT_ID` | — | **Required.** Discord application (client) ID. |
| `RPP_DISCORD_USERNAME` | `rustplusplus` | Display name the bot registers under. |
| `RPP_NEED_ADMIN_PRIVILEGES` | `true` | When `true`, only Discord admins can delete servers/switches, manage credentials and reset channels. Set to the string `false` to allow non-admins. |
| `RPP_POLLING_INTERVAL` | `10000` | Rust+ poll interval in ms. Lower = faster reactions, more API traffic. |
| `RPP_RECONNECT_INTERVAL` | `15000` | Delay in ms before reconnecting after a dropped Rust+ connection. |
| `RPP_BM_REQUEST_SPACING_MS` | `1500` | **Fork.** Minimum gap in ms between two Battlemetrics API requests in the global queue. Raise it to spread the per-cycle burst of server polls over a wider window when many trackers trip Battlemetrics rate limits. |
| `RPP_BM_REQUEST_JITTER_MS` | `1500` | **Fork.** Extra random delay (0…this) added on top of the spacing for each Battlemetrics request, so calls don't fire on a fixed cadence. |
| `RPP_STEAM_RESOLVE_INTERVAL_MS` | `300000` (5m) | **Fork.** Process-wide minimum gap between two background Steam requests. Steam is now used only to bootstrap a tracked SteamID into a Battlemetrics player id; once that link exists the player's name comes from Battlemetrics and Steam is never contacted for them again. Raise it if Steam still refuses the host. |
| `RPP_TRACKER_RESOLVE_PER_CYCLE` | `3` | **Fork.** How many still-unresolved tracked players the resolver examines per 60 s poll cycle. Never-attempted players are always examined first, so adding a player is never starved by the retry backlog. |
| `RPP_STEAM_NAME_CACHE_MS` | `21600000` (6h) | **Fork.** How long a scraped Steam persona name is reused by the callers that opt in (the tracker resolver and `/blacklist show` / `/whitelist show`). Set to `0` to disable the cache. |
| `RPP_TRACKER_HOURS_REFRESH_MS` | `86400000` (24h) | **Fork.** How long a tracked player's lifetime Rust hours stay fresh before being re-fetched from Battlemetrics. Set to `0` to switch the feature off — no requests are made and no figure is rendered on the tracker card. |
| `RPP_TRACKER_HOURS_PER_CYCLE` | `1` | **Fork.** How many of those refreshes a single 60 s poll cycle may spend, so the added load stays constant no matter how many players are tracked. Raise it to fill a large roster in faster on first run, at the cost of more Battlemetrics requests per cycle. |
| `RPP_BATTLEMETRICS_TOKEN` | _(empty)_ | **Fork.** Battlemetrics API token. Their API now requires an authenticated (paid) key for the server/player endpoints. Overridden by a token set with `/battlemetrics set`. With neither set, the Battlemetrics integration is disabled and the rest of the bot runs normally. |
| `RPP_LOG_CALL_STACK` | `false` | Set to the string `true` to include call-stack traces in error logs. |
| `RPP_LIBRETRANSLATE_URL` | _(bundled)_ | **Fork.** LibreTranslate base URL for the translated team-chat channel. The Docker image runs a bundled instance on `127.0.0.1:5000` by default. Point at an external instance to override; set to an empty string to disable the LibreTranslate path entirely (falls back to the rate-limited Google web endpoint). |
| `RPP_LIBRETRANSLATE_API_KEY` | _(empty)_ | **Fork.** API key for the LibreTranslate instance above, if it requires one. |

> Note: `RPP_NEED_ADMIN_PRIVILEGES` and `RPP_LOG_CALL_STACK` are parsed as
> strict booleans — the bot compares the value to the literal string `true`/`false`,
> so `RPP_NEED_ADMIN_PRIVILEGES=false` actually disables the check.

### Discord `settings` channel — fork-added toggles

These appear as buttons/selects in the guild's `settings` channel. New or
changed in this fork:

| Setting | Default | What it does |
| --- | --- | --- |
| **In-game command access mode** (`inGameCommandAccessMode`) | `blacklist` | Switch in-game command gating between `blacklist` and `whitelist` mode (see the `/blacklist` and `/whitelist` slash commands). |
| **Smart Alarm bypass mute** (`smartAlarmBypassMute`) | `true` | Smart Alarm announcements are still sent to in-game team chat even while the bot is muted in-game. |
| **Custom Alarm bypass mute** (`customAlarmBypassMute`) | `false` | Same bypass for the RF-event "custom alarm" announcements (see Smart Alarm RF event tagging). |
| **Smart Switch bypass mute** (`smartSwitchBypassMute`) | `true` | Smart Switch on/off announcements bypass the in-game mute. |
| **Battlemetrics upcoming wipes** (`displayInformationBattlemetricsUpcomingWipes`) | `false` | Show Battlemetrics-reported upcoming wipes in the server info embed. |
| **Team-chat translation** (`teamChatTranslateEnabled`) | `false` | Enable the `teamchat-translated` channel that translates non-EN/DE player messages to English. |
| **Log channel** (`logChannelEnabled`) | `true` | Mirror the bot's log output into the `logs` channel. Bot-wide lines are only mirrored on single-guild deployments. |
| **Mention user IDs** (`mentionUserIds`) | `[]` | Discord user IDs to `@`-mention on raid/alert events. |

### Event notification toggles — fork-added

Each event in the `settings` channel has an independent **Discord** and
**in-game** toggle. The fork adds the full Cargo Ship lifecycle and the Deep
Sea events:

| Event setting | Notes |
| --- | --- |
| `cargoShipDockingAtHarborSetting` | Ship approaching a harbor. |
| `cargoShipDockingSetting` / `cargoShipDockedSetting` | State-machine: docking → docked. |
| `cargoShipUndockingSetting` | Ship undocking; pairs with the 70 s "undocking soon" warning. |
| `cargoShipLeavingSetting` | Ship leaving the harbor / map. |
| `cargoShipLockedCrateSpawnedSetting` | Each of the 3 expected locked-crate spawns on the ship. |
| `deepSeaDetectedSetting` / `deepSeaLeftMapSetting` | Deep Sea monument appear/leave (ported from FaiThiX). |

Related in-game commands: **`!cargo`** (rich per-ship summary) and
**`!cargo timer`** (sorted list of pending timers).

### Per-tracker setting — Pause tracking (ACTIVE / PAUSED)

Each tracker embed has an **ACTIVE / PAUSED** button (stored as `active` on the
tracker, default on). Click it to **pause** a tracker: while paused the bot makes
**no API calls** for it at all — no Battlemetrics server poll and no per-player
Steam profile scrape — and its linked Battlemetrics instance is torn down on the
next poll cycle (unless the active server or another *active* tracker still needs
the same server). This is the lever for staying under Battlemetrics/Steam rate
limits when you're tracking a lot of players: pause the trackers you don't need
live right now and re-enable them on demand. The tracker embed shows a
`Tracking: PAUSED ⏸️` line so paused trackers are obvious at a glance. Existing
trackers from before this field default to active.

### Per-tracker setting — Off-hours RAID ALERT

Each tracker embed has a **RAID ALERT** button (stored as `raidAlert` on the
tracker, default off). When enabled and the tracker has ≥2 players, the bot
fires an `@everyone` Discord alert plus a forced in-game team-chat message when
**≥60 %** of the tracker is online during a statistically *quiet* hour for the
group, with a **30-minute** cooldown. The "quiet hour" determination uses the
local SQLite activity log (a group hour counts as off-peak below the **20 %**
activity threshold). Thresholds are defined in
`src/handlers/battlemetricsHandler.js`.

### Per-Smart-Alarm setting — RF event tag

In a Smart Alarm's **Edit** modal, the **event tag** field (`eventTag`) lets you
name the in-game event the alarm's RF receiver is wired to (e.g. `Large Excavator`,
`Cargo Ship`). When set, the bot announces **both the start and the stop** of
that event in the activity channel and team chat — useful for powered events the
Rust+ API doesn't expose directly.

---

## Thanks

- **[liamcottle](https://github.com/liamcottle)** — for the [rustplus.js](https://github.com/liamcottle/rustplus.js) library, vendored (MIT) in `src/rustplus/`.
- **[olijeffers0n](https://github.com/olijeffers0n)** — for [rustplus](https://github.com/olijeffers0n/rustplus), whose maintained client informed the hardening of the vendored library.
- **[alexemanuelol](https://github.com/alexemanuelol)** — for the [main rustplusplus bot](https://github.com/alexemanuelol/rustplusplus).
- **[FaiThiX](https://github.com/FaiThiX)** — for the Deep Sea features, cargo lifecycle work, and map fixes.
- **.Vegas.#4844** on Discord — for the icons.
