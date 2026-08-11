# Installation Documentation

## Required Software

Program | Version | Download | Note
------- | ------- | -------- | ----
`NodeJS` | >= 22.18.0 | [**here**](https://nodejs.org/en/download/) | The bot starts with `node .` on a TypeScript entry point, so it needs the release where Node enables type stripping by default: 22.18. Two lower bounds also still apply — discord.js v14 needs Node 22, and the ESM-only dependencies (`franc-min`, `translate`, `@formatjs/intl`) are loaded from this CommonJS codebase through `require(esm)`, which landed in 22.12.
`Git` | Any | [**here**](https://git-scm.com/downloads) | &nbsp;

## Optional Software
To enable step-trace for cargoship and patrol helicopter, [**GraphicsMagick**](http://www.graphicsmagick.org/download.html) needs to be downloaded.


## Clone the repository

Open a terminal (`Git Bash` / `CMD` / `Terminal` / `PowerShell` or similar) and run the following commands:

    $ git clone https://github.com/alexemanuelol/rustplusplus.git
    $ cd rustplusplus
    $ npm install
