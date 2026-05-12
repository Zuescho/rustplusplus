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

### 🛰️ Smarter tracker

- **`/tracker add|remove|list`** slash command with **native Discord autocomplete** on both the tracker and player options. Player search merges the bot's online cache with a Battlemetrics server-scoped lookup, raced against Discord's 3-second budget.
- **Active-hours hint** next to each tracked player (e.g. `~18–23 daily`), computed from a local SQLite log of polling snapshots aggregated over 30 days.
- **Group active-window line** in the tracker embed showing roughly when the whole group plays.
- **Off-hours RAID ALERT** (per-tracker opt-in): when ≥60 % of the tracker is online during a quiet hour, fires `@everyone` in Discord and a force-message in team chat, with a 30 min cooldown.
- Player rows now show **plain name + small B / S markdown links** to Battlemetrics and Steam profiles.
- Modal accepts a plain ID **or** a full Steam/BM profile URL.

### 📦 Cargo Ship lifecycle (slim port of FaiThiX 421aa27)

- Full state machine: **docking → docked → undocking → leaving**, each with its own toggleable Discord notification.
- **Locked-crate spawn alerts** for each of the 3 expected spawns on the ship.
- Multi-harbor visit tracking; "undocking soon" 70-second warning.
- New in-game commands: **`!cargo`** (rich per-ship summary) and **`!cargo timer`** (sorted list of pending timers).
- Direction-based "is leaving" fallback for maps without harbors.

### 🔔 Smart Alarm RF event tagging

Tag a Smart Alarm in the Edit modal with an event name (e.g. `Large Excavator`, `Cargo Ship`). When the linked RF receiver
fires, the bot announces **both start AND stop** in the activity channel and team chat — perfect for tracking
powered in-game events the Rust+ API doesn't expose directly.

### 🌐 Translated team chat channel

A dedicated `teamchat-translated` channel that automatically translates non-English/German player messages into English via
offline language detection (`franc-min`). Toggleable in settings, defaults to off.

### 🛡️ Other quality-of-life

- Smart switch on/off announcements bypass the in-game mute (same fix as Smart Alarms in v1.25.5).
- Battlemetrics request queue + 0–30 s poll-cycle jitter — no more burst rate-limit hits with many servers.
- Steam profile name scraping throttled to once per 24 h per player.
- Day/night transition broadcasts (`It's getting dark!` / `It's getting light!`).
- Battlemetrics upcoming wipes display in server embed.
- Alarm-triggered switch groups (auto-activate after N triggers).
- Shorthand `!timer <time> [message]` (no `add` subcommand needed).
- Asset-path monument tokens are no longer drawn over the map.

### ✂️ Slimmed for focus

Removed features the fork's target audience doesn't use:
- RustLabs lookup commands (`!craft / decay / despawn / recycle / research / stack / upkeep`) and their 21 MB of data — use rustlabs.com instead.
- Vending-machine item-subscription system (new-vending-machine markers still announce).
- CCTV codes command.
- In-game `!tts` and Discord `sendTTSMessage`.
- Battlemetrics "all online players" info-channel widget.

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

Existing `instances/*.json` files are migrated in place — paired alarms, switches, trackers, settings and channel IDs all survive upgrades.

---

## Thanks

- **[liamcottle](https://github.com/liamcottle)** — for the [rustplus.js](https://github.com/liamcottle/rustplus.js) library.
- **[alexemanuelol](https://github.com/alexemanuelol)** — for the [main rustplusplus bot](https://github.com/alexemanuelol/rustplusplus).
- **[FaiThiX](https://github.com/FaiThiX)** — for the Deep Sea features, cargo lifecycle work, and map fixes.
- **.Vegas.#4844** on Discord — for the icons.
