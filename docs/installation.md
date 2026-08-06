# Installation Documentation

## Required Software

Program | Version | Download | Note
------- | ------- | -------- | ----
`NodeJS` | >= 22.12.0 | [**here**](https://nodejs.org/en/download/) | discord.js v14 needs Node 22, and several dependencies (`franc-min`, `translate`, `@formatjs/intl`) are ESM-only — loading them from this CommonJS codebase relies on `require(esm)`, which landed in Node 22.12.
`Git` | Any | [**here**](https://git-scm.com/downloads) | &nbsp;

## Optional Software
To enable step-trace for cargoship and patrol helicopter, [**GraphicsMagick**](http://www.graphicsmagick.org/download.html) needs to be downloaded.


## Clone the repository

Open a terminal (`Git Bash` / `CMD` / `Terminal` / `PowerShell` or similar) and run the following commands:

    $ git clone https://github.com/alexemanuelol/rustplusplus.git
    $ cd rustplusplus
    $ npm install
