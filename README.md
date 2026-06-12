# MōStats — a compact macOS system monitor

Live macOS system resources at a glance, plus a searchable process explorer.

Built with [MōBrowser](https://teamdev.com/mobrowser/), React, and TypeScript, with a small native module for the metrics.

## What it does

- **System overview.** CPU, memory, network, disk, uptime, and CPU temperature.
- **Process explorer.** A searchable list that groups an app with its helpers.
- **Process detail.** Command line, executable path, start time, user, threads, hierarchy, and CPU/memory totals.
- **Process actions.** Reveal in Finder, Quit, and Force Quit.

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

## Project layout

- **`src/main/`** — app lifecycle, window, tray, metrics, and process services; owns privileged work and the typed IPC.
- **`src/renderer/`** — the React UI (overview, process list and detail); presentation only.
- **`src/native/`** — narrow C++/Objective-C++ probes: memory, network, temperature, and the process collector.

## Download

Releases are on the [releases page](https://github.com/mo-browser-apps/stats/releases).
