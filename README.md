# clawdbot-watchdog

A tiny reliability plugin for **Clawdbot / Moltbot**.

## Why

Self-hosted bots are awesome until:
- the Gateway drops,
- Rocket.Chat / other channels disconnect,
- cron jobs hang,
- and you find out hours later.

This plugin is designed to keep things boring.

## Status

**v0.1.0 is a scaffold** (no runtime behavior yet). The next release will add:
- periodic health checks
- alerts to a configured chat room
- optional “recovery” actions (restart gateway / restart channel)

## Install

```bash
npm i clawdbot-watchdog
```

## Configure

(Coming in v0.1.1)
