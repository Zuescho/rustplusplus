<p align="center">
  <img src="Node.js.webp" alt="rustplusplus logo" width="200" />
</p>

<h1 align="center"><em><b>rustplusplus</b> ~ Rust+ Discord Bot</em></h1>

<p align="center">
A Rust+ companion bot for Discord, built for small, active raid groups: player tracking with activity
analytics, the full cargo ship lifecycle, smart device control and a translated team chat bridge.
</p>

---

## Features

**Trackers** — `/tracker add|remove|list` with native Discord autocomplete on both the tracker and the
player option. Each row shows online status and session length, **lifetime Rust hours** from
Battlemetrics, an **active-hours hint** (`~18–23 daily`) computed from a local SQLite log of poll
snapshots, and links to the Battlemetrics and Steam profiles. Per tracker: an **ACTIVE / PAUSED**
button (a paused tracker makes no API calls at all) and an opt-in **off-hours RAID ALERT** that pings
`@everyone` when ≥60 % of the group is online during a statistically quiet hour.

**Cargo ship lifecycle** — a full state machine (docking → docked → undocking → leaving), each
transition individually toggleable, plus locked-crate spawn alerts, multi-harbor visit tracking, a 70 s
"undocking soon" warning and the `!cargo` / `!cargo timer` in-game commands.

**Smart Alarm RF event tags** — tag an alarm with an event name (e.g. `Large Excavator`) and the bot
announces both the **start and the stop** of that event in the activity channel and team chat. Useful
for powered in-game events the Rust+ API doesn't expose.

**Translated team chat** — a `teamchat-translated` channel that translates non-English/German player
messages to English. Detection is fully offline (`franc-min`), and a **bundled LibreTranslate** with the
Spanish → English model ships inside the Docker image, so Spanish is handled locally with no rate
limits and no API key.

**Battlemetrics API token** — Battlemetrics now requires an authenticated (paid) key. Set it with
`/battlemetrics set` (admins only) or `RPP_BATTLEMETRICS_TOKEN`; `/battlemetrics status` shows where
the token came from and how many servers are polled. With no token the integration switches itself off
cleanly — no requests, no 401 spam — and the rest of the bot keeps working.

**Discord log channel** — a `logs` channel mirroring the bot's log output, so you can see what it is
doing without tailing files on the host. Batched, bounded, and never able to feed a failing send back
into the log.

**Mute a teammate from the relay** — `/mute add|remove|list` stops a teammate's in-game chat from being
posted to Discord, for the usual case of a second bot in the team echoing everything twice. The player
still counts for the team and their in-game commands still work.

**Quality of life** — smart switch announcements bypass the in-game mute; Battlemetrics request queue
plus poll-cycle jitter; day/night transition broadcasts; upcoming wipes in the server embed;
alarm-triggered switch groups; shorthand `!timer <time> [message]`.

**Slimmed down** — the RustLabs lookup commands (and their 21 MB of data), the vending-machine
subscription system, CCTV codes, TTS and Steam avatar scraping are gone. See
[full_list_features.md](docs/full_list_features.md).

The Rust+ client is built in ([`src/rustplus/`](src/rustplus)) rather than pulled from a git pin, every
dependency is on its latest major, and the bot degrades cleanly when Facepunch removes the event map
markers — see [internals.md](docs/internals.md).

---

## Deploying

```yaml
services:
  rustplusbot:
    image: ghcr.io/zuescho/rustplusplus:master
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

The image bundles a minimal LibreTranslate (Spanish → English) on `127.0.0.1:5000`, started by the
container's own entrypoint — no sidecar, no API key. Existing `instances/*.json` files are migrated in
place: paired alarms, switches, trackers, settings and channel IDs all survive upgrades.

Running from source needs Node **22.18+** and `npm install && npm start`.

---

## Documentation

| | |
| --- | --- |
| [Discord bot setup](docs/discord_bot_setup.md) | Create the application, invite the bot |
| [Credentials](docs/credentials.md) · [(web version)](docs/credentials_web_version.md) | FCM credentials for pairing |
| [Pair & connect a server](docs/pair_and_connect_to_server.md) | Getting the bot onto your server |
| [Configuration](docs/configuration.md) | Environment variables, settings channel, per-tracker options |
| [Commands](docs/commands.md) · [Feature overview](docs/full_list_features.md) | What the bot can do |
| [Discord channels](docs/discord_text_channels.md) · [Smart devices](docs/smart_devices.md) | Channel-by-channel reference |
| [Internals](docs/internals.md) | Vendored Rust+ client, dependencies, marker removal |

---

## Lineage & credits

This project began as a fork of [alexemanuelol/rustplusplus](https://github.com/alexemanuelol/rustplusplus)
and has since diverged far enough to stand on its own, but it stands on other people's work:

- **[alexemanuelol](https://github.com/alexemanuelol)** — the original [rustplusplus](https://github.com/alexemanuelol/rustplusplus) bot this codebase grew out of.
- **[FaiThiX](https://github.com/FaiThiX)** — the [fork](https://github.com/FaiThiX/rustplusplus) whose Deep Sea features, cargo ship lifecycle work and map fixes were ported here.
- **[liamcottle](https://github.com/liamcottle)** — [rustplus.js](https://github.com/liamcottle/rustplus.js), vendored (MIT) in [`src/rustplus/`](src/rustplus).
- **[olijeffers0n](https://github.com/olijeffers0n)** — [rustplus](https://github.com/olijeffers0n/rustplus), whose maintained client informed the hardening of that vendored code.
- **.Vegas.#4844** on Discord — the icons.

Licensed under the **GNU GPL v3** (see [LICENSE](LICENSE)); the vendored Rust+ client remains MIT.
