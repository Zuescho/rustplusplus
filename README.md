<h1 align="center"><em><b>rustplusplus</b> ~ Rust+ Discord Bot (Fork)</em></h1>

This is a fork of [alexemanuelol/rustplusplus](https://github.com/alexemanuelol/rustplusplus) with additional changes merged from [FaiThiX/rustplusplus](https://github.com/FaiThiX/rustplusplus).

For setup instructions, credentials, and general documentation see the [original repository](https://github.com/alexemanuelol/rustplusplus).

## **Changes in this fork**

### From upstream (alexemanuelol)
* Fix Vending Machines not updating
* Context menu choices bugfix
* Updated items.json and cctv.json
* Fixed raidalarm notification giving invalid thumbnail URL
* Fixed thumbnails only allowing URLs
* Added issue template
* Updated discordjs packages

### From FaiThiX
* Deep Sea detection, commands, and history tracking
* In-game and Discord commands for Deep Sea events
* Market rework
* Atomic write pattern for instance files (prevents corruption during crashes)
* Docker-compose refactoring
* Discord Voice fix
* Map location fixes
* Various version bumps and bug fixes

### Custom changes
* Alarm-triggered switch groups (link an alarm to a switch group, auto-activate after N triggers)
* Day/night transition in-game broadcast messages ("It's getting dark!" / "It's getting light!")
* Smart switch auto-control refactor (day/night, proximity, and online-player based switching)
* Battlemetrics upcoming wipes display in server embed (Next Map Wipe / Next Full Wipe with relative timestamps, toggleable)
* Shorthand timer syntax: `!timer <time> [message]` without needing `add` subcommand
* Credential re-registration rework (cleans up existing listeners instead of rejecting)
* CI modernization (Node 22, simplified lint workflow)

## **Thanks to**

**liamcottle**@GitHub - for the [rustplus.js](https://github.com/liamcottle/rustplus.js) library.
<br>
**.Vegas.#4844**@Discord - for the awesome icons!
<br>
**alexemanuelol**@GitHub - for the Main Development of the [Rust++ Bot](https://github.com/alexemanuelol/rustPlusPlus).
<br>
**FaiThiX**@GitHub - for the [Deep Sea features, market rework, and various fixes](https://github.com/FaiThiX/rustplusplus).
