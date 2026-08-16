# Internals

Notes on how the bot is put together and why. None of this is needed to run it — see the
[main README](../README.md) for that.

## Built-in Rust+ API client

The bot does not depend on an external Rust+ client library. The client lives in
[`src/rustplus/`](../src/rustplus) — originally [rustplus.js](https://github.com/liamcottle/rustplus.js)
by liamcottle (MIT), since hardened for long-running use:

- the `.proto` is compiled once per process instead of on every reconnect, and carries the `TravelingVendor` marker type;
- inbound frames are decoded once instead of twice;
- a malformed frame or a throwing response callback surfaces as an `error` event rather than an uncaught exception inside the websocket handler (which used to be able to take the process down);
- a failed protobuf load surfaces as an `error` event instead of an unhandled rejection;
- `sendRequestAsync` drops its callback on timeout, so lost responses no longer leak for the life of the connection;
- `isConnected()` no longer throws when called before `connect()`.

## Runtime & dependencies

Every dependency is on its latest major:

| Package | Notes |
| --- | --- |
| `jimp` 1.x | Full API rewrite vs 0.22 — `loadFont`/`rgbaToInt` are named exports, `resize`/`print` take option objects, `writeAsync`→`write`, `getBufferAsync`→`getBuffer`. |
| `better-sqlite3` 13 | Ships prebuilt binaries; no source build needed. |
| `protobufjs` 8 | int64 fields still decode to `Long`, so nothing downstream changed. |
| `@formatjs/intl` 4, `franc-min` 6, `translate` 3 | ESM-only, loaded with a plain `require()` — Node 22.12+ can require an ESM graph with no top-level await, which all three are. |

**TypeScript 7, no `ts-node`.** TypeScript 7 is the native port and exposes no JavaScript compiler API
(`require('typescript')` yields only `{ version, versionMajorMinor }`), which killed `ts-node` at
startup. Rather than rename the entry point — 34 references to `index.ts` across 23 files reach it by
name — the bot starts with plain `node .`: Node strips the types itself, and `index.ts` has always been
valid CommonJS with no TypeScript syntax in it. `typescript` is a devDependency used only by `npm test`.

Two consequences: `engines.node` is `>=22.18.0`, the release where Node documents type stripping as
enabled by default; and because startup depends on the entry point being *erasable*, `tsconfig.json`
sets `erasableSyntaxOnly` so `npm test` rejects an `enum`, a namespace with a runtime body or a
parameter property in `index.ts` instead of letting it fail at startup.

Note that `npm test`'s type-check step is close to a no-op: `checkJs` is `false` and `index.ts` is the
only `.ts` file, so `tsc` checks one 67-line unannotated file and merely parses the other ~120.

## Rust+ event map marker removal

Facepunch is removing vending machine and event map markers (cargo ship, patrol helicopter, traveling
vendor) from the Rust+ API. CH47/Crate markers are **not** affected, so small/large oil rig
heavy-scientist and locked-crate events keep working unchanged.

The bot detects the change and degrades cleanly instead of firing a burst of bogus "cargo ship left the
map / heli left the map / every vending machine was destroyed" notifications at the moment the feed
disappears. Vending machines are the canary (a live map always has plenty, and they go in the same
change). The first poll without them pauses event marker diffing but keeps every bit of state — a
server saving behind a still-open websocket costs at most ~2 minutes of frozen event tracking, with no
phantom notifications and nothing lost. Only after ~2 minutes of consecutive empty polls is the feed
declared gone: state and cargo timers are then dropped silently, a single warning is logged, and
`!cargo`, `!heli`, `!vendor`, `!deepsea` and the info-channel embed report the events as *unavailable*
rather than as "not currently on the map".

If the markers ever come back, tracking resumes automatically — after a real teardown the markers on
the map are adopted as a baseline rather than replayed as fresh arrivals, so nothing is re-announced
and no cargo timer is armed from a spawn time the bot cannot know. Deep sea detection is driven
entirely by vending machine markers, so it goes away with them.

## Failure logging

Failures that used to happen in complete silence now log. The ones worth knowing about: the activity
database refusing to open (which silently disables the active-hours hints, the tracker activity report
**and** the off-hours raid alarm for the whole run); an in-game message that was queued and then
dropped, which previously still logged as sent; a leadership transfer that did not take; a Battlemetrics
player search or playtime lookup that keeps coming back empty; a server name that matches no
Battlemetrics server exactly; channel permissions that could not be applied; and an active server that
is selected but missing from the server list, which stops the bot connecting at all.

Every one of these is either once per process, once per outage, or tied to something you did — none of
them fire on the 10 s or 60 s poll, so a healthy bot stays quiet.
