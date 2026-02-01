import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

function isObj(x: unknown): x is Record<string, any> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function error(message: string) {
  return { success: false as const, error: { issues: [{ path: [], message }] } };
}

/**
 * Minimal config schema with safeParse + jsonSchema.
 *
 * Stored at: plugins.entries.watchdog.config
 */
export const configSchema = (() => {
  const schema = emptyPluginConfigSchema();

  return {
    safeParse(value: unknown) {
      if (value === undefined) return { success: true as const, data: undefined };
      if (!isObj(value)) return error("expected config object");

      // defaulty + validate shape
      const enabled = value.enabled !== false;
      const intervalSec = typeof value.intervalSec === "number" ? value.intervalSec : 60;
      const failureThreshold =
        typeof value.failureThreshold === "number" ? value.failureThreshold : 3;
      const cooldownSec = typeof value.cooldownSec === "number" ? value.cooldownSec : 600;

      if (!Number.isFinite(intervalSec) || intervalSec < 10) {
        return error("intervalSec must be a number >= 10");
      }
      if (!Number.isFinite(failureThreshold) || failureThreshold < 1) {
        return error("failureThreshold must be a number >= 1");
      }
      if (!Number.isFinite(cooldownSec) || cooldownSec < 0) {
        return error("cooldownSec must be a number >= 0");
      }

      const alert = isObj(value.alert) ? value.alert : {};
      const alertChannel = typeof alert.channel === "string" ? alert.channel : "rocketchat";
      const alertTo = typeof alert.to === "string" ? alert.to : "";

      const recover = isObj(value.recover) ? value.recover : {};
      const recoverEnabled = recover.enabled === true;
      const recoverAction = typeof recover.action === "string" ? recover.action : "gateway-restart";

      // allow no alert target (runs but only logs)
      const data = {
        enabled,
        intervalSec,
        failureThreshold,
        cooldownSec,
        alert: {
          channel: alertChannel,
          to: alertTo,
        },
        recover: {
          enabled: recoverEnabled,
          action: recoverAction,
        },
      };

      return { success: true as const, data };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        intervalSec: { type: "number", minimum: 10, default: 60 },
        failureThreshold: { type: "number", minimum: 1, default: 3 },
        cooldownSec: { type: "number", minimum: 0, default: 600 },
        alert: {
          type: "object",
          additionalProperties: false,
          properties: {
            channel: { type: "string", default: "rocketchat" },
            to: { type: "string", description: "Rocket.Chat roomId or #channel" },
          },
        },
        recover: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", default: false },
            action: {
              type: "string",
              enum: ["gateway-restart"],
              default: "gateway-restart",
            },
          },
        },
      },
    },
  };
})();

function resolveRocketChatAccount(cfg: any) {
  const rc = cfg?.channels?.rocketchat;
  if (!rc) return null;
  // support both single-account and accounts.default
  const base = rc.baseUrl && rc.userId && rc.authToken ? rc : null;
  const acct = rc.accounts?.default;
  const resolved = acct && acct.baseUrl && acct.userId && acct.authToken ? acct : base;
  return resolved
    ? { baseUrl: resolved.baseUrl as string, userId: resolved.userId as string, authToken: resolved.authToken as string }
    : null;
}

async function sendRocketChat(cfg: any, to: string, text: string) {
  const acct = resolveRocketChatAccount(cfg);
  if (!acct) throw new Error("watchdog: Rocket.Chat not configured (channels.rocketchat.*)");

  const { baseUrl, userId, authToken } = acct;
  const url = new URL("/api/v1/chat.postMessage", baseUrl).toString();
  const payload: any = { text };
  if (to.startsWith("#")) payload.channel = to;
  else payload.roomId = to;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-User-Id": userId,
      "X-Auth-Token": authToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`watchdog: Rocket.Chat send failed ${res.status}: ${body}`);
  }
}

function formatStatus(name: string, ok: boolean, meta?: string) {
  const ts = new Date().toISOString();
  return `watchdog: ${name} ${ok ? "OK" : "DOWN"}${meta ? ` (${meta})` : ""} @ ${ts}`;
}

function createWatchdogService(opts: {
  pluginConfig: any;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };
}) {
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;
  let lastRecoverAt = 0;
  let lastStateOk: boolean | null = null;

  function extractLastJsonObject(text: string): any {
    // `clawdbot gateway health --json` may print styled doctor output *before* the JSON.
    // We recover by parsing the last {...} block.
    const start = text.lastIndexOf("{");
    if (start < 0) throw new Error("no JSON object found in output");
    const candidate = text.slice(start);
    try {
      return JSON.parse(candidate);
    } catch {
      // fallback: find first { and last }
      const s2 = text.indexOf("{");
      const e2 = text.lastIndexOf("}");
      if (s2 >= 0 && e2 > s2) {
        return JSON.parse(text.slice(s2, e2 + 1));
      }
      throw new Error("failed to parse JSON output");
    }
  }

  async function runGatewayHealth(bin: string, timeoutMs: number) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const { stdout, stderr } = await execFileAsync(bin, ["gateway", "health", "--json"], {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });

    const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
    const json = extractLastJsonObject(combined);
    return { bin, json };
  }

  async function checkHealth(logger: any) {
    const timeoutMs = 10_000;
    let lastErr: unknown = null;

    for (const bin of ["clawdbot", "openclaw"]) {
      try {
        const result = await runGatewayHealth(bin, timeoutMs);
        const ok = Boolean(result.json?.ok);
        const durationMs =
          typeof result.json?.durationMs === "number" ? result.json.durationMs : undefined;
        return {
          ok,
          meta: `${bin}${durationMs !== undefined ? ` durationMs=${durationMs}` : ""}`,
          raw: result.json,
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "health failed"));
  }

  return {
    id: "watchdog",
    async start(ctx: any) {
      const pcfg = opts.pluginConfig;
      if (!pcfg?.enabled) return;

      const intervalMs = Math.round(pcfg.intervalSec * 1000);
      const threshold = pcfg.failureThreshold;
      const cooldownMs = Math.round(pcfg.cooldownSec * 1000);

      const alertChannel = pcfg.alert?.channel ?? "rocketchat";
      const alertTo = pcfg.alert?.to ?? "";

      const doAlert = async (text: string) => {
        if (!alertTo) {
          ctx.logger.info(text);
          return;
        }
        if (alertChannel !== "rocketchat") {
          ctx.logger.warn(`watchdog: unsupported alert.channel=${alertChannel}; logging only`);
          ctx.logger.info(text);
          return;
        }
        await sendRocketChat(ctx.config, alertTo, text);
      };

      const tick = async () => {
        let ok = false;
        let meta = "";
        try {
          const health = await checkHealth(ctx.logger);
          ok = health.ok;
          meta = health.meta;
        } catch (err) {
          ok = false;
          meta = err instanceof Error ? err.message : String(err);
        }

        if (ok) {
          if (lastStateOk === false) {
            await doAlert(formatStatus("gateway", true));
          }
          failures = 0;
          lastStateOk = true;
          return;
        }

        failures += 1;
        lastStateOk = false;

        // Alert on first failure and on threshold.
        if (failures === 1 || failures === threshold) {
          await doAlert(formatStatus("gateway", false, `failures=${failures}${meta ? ": " + meta : ""}`));
        }

        // Recovery
        if (pcfg.recover?.enabled && failures >= threshold) {
          const now = Date.now();
          if (now - lastRecoverAt < cooldownMs) return;
          lastRecoverAt = now;

          await doAlert(`watchdog: attempting recovery: ${pcfg.recover.action} (failures=${failures})`);

          // Use CLI so it works for both launchd/systemd installs.
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);

          try {
            if (pcfg.recover.action === "gateway-restart") {
              await execFileAsync("clawdbot", ["gateway", "restart"], { timeout: 60_000 });
            } else {
              throw new Error(`unknown recover.action: ${pcfg.recover.action}`);
            }
          } catch (err) {
            await doAlert(
              `watchdog: recovery failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      };

      // kick immediately + interval
      ctx.logger.info(`watchdog: started (interval=${pcfg.intervalSec}s threshold=${threshold} recover=${pcfg.recover?.enabled ? "on" : "off"})`);
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

const plugin = {
  id: "watchdog",
  name: "Watchdog",
  description: "Gateway and channel health watchdog with alerts and optional recovery.",
  configSchema,
  register(api: any) {
    api.registerService(createWatchdogService({ pluginConfig: api.pluginConfig, logger: api.logger }));
  },
};

export default plugin;
