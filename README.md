# MōStats — a compact macOS system monitor

Live macOS system resources at a glance, plus a searchable process explorer.

Built with [MōBrowser](https://teamdev.com/mobrowser/), React, and TypeScript, with a small native module for the
metrics macOS does not expose to Node.

## What it does

- **System overview.** CPU, memory, disk, and network.
- **Uptime and temperature.** Uptime, and CPU temperature on Macs with a readable sensor.
- **Process explorer.** A searchable, CPU- or memory-ranked list that groups an app with its helpers.
- **Process detail.** Command line, executable path, start time, user, threads, hierarchy, and CPU/memory totals.
- **Process actions.** Reveal in Finder, Quit, and Force Quit.

Command-line arguments are local-only: shown, searched, and copied on your action, never logged or sent anywhere.

## Requirements

- macOS 14 (Apple Silicon) or later.
- [Node.js](https://nodejs.org/en/download/) 20.20.2 (LTS) or later.

## Setup

```bash
npm install
```

## Run

```bash
npm run dev
```

## Build

```bash
npm run build
```

Builds a macOS app and `.dmg`. Signing and notarization need Apple credentials from the environment; without them the
build still produces an unsigned `.dmg`.

## How to use

1. The window opens on **Stats**. Use the title-bar switch for **Stats** / **Processes**.
2. In **Processes**, search (a name, a PID, or a flag like `--type=renderer`) and sort by **CPU** or **RAM**.
3. Click a row for its detail: copy the path or command line, expand **Members**, or **Open** / **Quit** / **Force
   Quit**.
4. Closing the window keeps the app running in the tray; click the tray icon to show or hide it.

## Project layout

- **`src/main/`** — app lifecycle, window, tray, metrics, and process services; owns privileged work and the typed IPC.
- **`src/renderer/`** — the React UI (overview, process list and detail); presentation only.
- **`src/native/`** — narrow C++/Objective-C++ probes: memory, network, temperature, and the process collector.

## Download

Releases are on the [releases page](https://github.com/mo-browser-apps/stats/releases).
