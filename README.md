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

**MVP (in progress)**
- periodic health checks
- alerts to a configured Rocket.Chat room
- optional auto-recovery (gateway restart)

## Install

```bash
npm i clawdbot-watchdog
```

## Configure

Add this to your Clawdbot config:

```yaml
plugins:
  entries:
    watchdog:
      enabled: true
      config:
        enabled: true
        intervalSec: 60
        failureThreshold: 3
        cooldownSec: 600
        alert:
          channel: rocketchat
          to: "#general"   # or roomId
        recover:
          enabled: true
          action: gateway-restart
```

Then restart the gateway.
