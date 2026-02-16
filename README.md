<h1 align="center"><em><b>rustplusplus</b> ~ Rust+ Discord Bot</em></h1>

A NodeJS Discord Bot that uses the [rustplus.js](https://github.com/liamcottle/rustplus.js) library to utilize the power of the [Rust+ Companion App](https://rust.facepunch.com/companion) with additional Quality-of-Life features.


## **Features**

* Receive notifications for In-Game Events (Patrol Helicopter, Cargo Ship, Chinook 47, Oil Rigs triggered).
* Control Smart Switches or Groups of Smart Switches via Discord or In-Game Team Chat.
* Setup Smart Alarms to notify in Discord or In-Game Team Chat whenever they are triggered.
* Link Smart Alarms to Switch Groups — automatically turn on a group after a configurable number of alarm triggers.
* Use Storage Monitors to keep track of Tool Cupboard Upkeep or Large Wooden Box/Vending Machine content.
* Communicate with teammates from Discord to In-Game and vice versa.
* Keep track of other teams on the server with the Battlemetrics Player Tracker.
* Lots of QoL Commands that can be used In-Game or from Discord.


## **Credentials**

> You can get your credentials by running the `rustplusplus credential application`. Download it [here](https://github.com/alexemanuelol/rustplusplus-credential-application/releases/download/v1.4.0/rustplusplus-1.4.0-win-x64.exe)


## **How to run the bot**

> To run the bot, simply open the terminal of your choice and run the following from repository root:

    $ npm start run


## **How to update the repository**

> Depending on your OS / choice of terminal you can run:

    $ update.bat

or

    $ ./update.sh


## **Running via docker**

    $ docker run --rm -it -v ${pwd}/credentials:/app/credentials -v ${pwd}/instances:/app/instances -v ${pwd}/logs:/app/logs -e RPP_DISCORD_CLIENT_ID=111....1111 -e RPP_DISCORD_TOKEN=token --name rpp ghcr.io/faithix/rustplusplus

or

    $ docker-compose up -d

Make sure you use the correct values for DISCORD_CLIENT_ID as well as DISCORD_TOKEN in the docker command/docker-compose.yml

## **Changes in this fork**

This fork is based on [alexemanuelol/rustplusplus](https://github.com/alexemanuelol/rustplusplus) with additional changes merged from [FaiThiX/rustplusplus](https://github.com/FaiThiX/rustplusplus).

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
* Day/night transition broadcast warning (5-minute advance notification)
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

---

<p align="center">
<a href="https://ko-fi.com/alexemanuelol"><img src="https://img.shields.io/badge/Donate%20a%20Coffee-alexemanuelol-yellow?style=flat&logo=buy-me-a-coffee" alt="donate on ko-fi"/></a>
</p>
