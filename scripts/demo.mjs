#!/usr/bin/env node
/**
 * agent-simulator — one-command demo launcher
 * -------------------------------------------
 *
 * What it does, in order:
 *
 *   1. Boot an iOS simulator (uses the first already-booted device, or boots
 *      the first iPhone 1x device it can find via `xcrun simctl list`).
 *   2. Start Metro (`expo start --ios`) for `examples/expo-demo`.
 *   3. Wait for Metro to be ready, then open the Expo Go deep link in the
 *      sim so the inspector-bridge boots inside the app.
 *   4. Start the agent-simulator web server on :3200 (it spawns sim-server
 *      itself) once Expo Go has finished cold-launching.
 *   5. Open http://localhost:3200 in the default browser.
 *   6. Stream both child processes' logs with a prefix so you can see
 *      what\u2019s going on. Ctrl-C cleans up both.
 *
 * Usage:
 *   bun demo
 *
 * Flags:
 *   --no-open        Skip launching the browser automatically.
 *   --metro-port=N   Default 8081.
 *   --port=N         agent-simulator server port (default 3200).
 *   --device=<UDID>  Use a specific simulator UDID instead of auto-picking.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = path.join(ROOT, "examples", "expo-demo");

const argv = process.argv.slice(2);
const opt = {
  open: !argv.includes("--no-open"),
  port: Number(argFlag("--port") ?? 3200),
  metroPort: Number(argFlag("--metro-port") ?? 8081),
  device: argFlag("--device"),
};

function argFlag(name) {
  for (const a of argv) {
    if (a === name) return true;
    const m = a.match(new RegExp(`^${name}=(.+)$`));
    if (m) return m[1];
  }
  return undefined;
}

// --- pretty logging ---------------------------------------------------------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const step = (n, msg) => console.log(C.bold(C.cyan(`[${n}/5]`)), msg);
const info = (msg) => console.log(C.cyan("\u2022"), msg);
const warn = (msg) => console.log(C.yellow("!"), msg);
const fail = (msg) => console.log(C.red("\u2717"), msg);
const ok = (msg) => console.log(C.green("\u2713"), msg);

function prefixStream(child, label, color = C.dim) {
  const tag = color(`[${label}]`);
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) console.log(`${tag} ${line}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
}

// --- preflight --------------------------------------------------------------
function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function preflight() {
  if (process.platform !== "darwin") {
    fail("agent-simulator only runs on macOS (Xcode + iOS Simulator required).");
    process.exit(1);
  }
  const tools = ["xcrun", "axe", "node"];
  const missing = tools.filter((t) => !which(t));
  if (missing.length) {
    fail(`missing required tool(s): ${missing.join(", ")}`);
    if (missing.includes("axe")) {
      warn("install axe with: brew install cameroncooke/axe/axe");
    }
    process.exit(1);
  }
  if (!existsSync(path.join(ROOT, "sim-server", "target", "release", "sim-server"))) {
    fail("sim-server binary not found. Build it first:");
    console.log("    (cd sim-server && cargo build --release)");
    process.exit(1);
  }
  if (!existsSync(path.join(ROOT, "web-app", "dist", "index.html"))) {
    fail("web-app not built. Build it first:");
    console.log("    (cd web-app && bun install && bun run build)");
    process.exit(1);
  }
  if (!existsSync(path.join(DEMO, "node_modules"))) {
    warn("demo dependencies missing, installing via bun\u2026");
    const r = spawnSync("bun", ["install"], { cwd: DEMO, stdio: "inherit" });
    if (r.status !== 0) {
      fail("bun install failed in the demo directory");
      process.exit(1);
    }
  }
}

// --- simulator --------------------------------------------------------------
function findBootedDevice() {
  const r = spawnSync("xcrun", ["simctl", "list", "devices", "booted", "--json"]);
  if (r.status !== 0) return null;
  const data = JSON.parse(r.stdout.toString());
  for (const [runtime, devices] of Object.entries(data.devices)) {
    for (const d of devices) {
      if (d.state === "Booted") return { ...d, runtime };
    }
  }
  return null;
}

function bootFirstIphone() {
  const r = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  if (r.status !== 0) throw new Error("simctl list failed");
  const data = JSON.parse(r.stdout.toString());
  const runtimes = Object.keys(data.devices)
    .filter((k) => k.includes("iOS"))
    .sort()
    .reverse(); // newest iOS first
  for (const rt of runtimes) {
    for (const d of data.devices[rt] || []) {
      if (d.name.includes("iPhone") && d.isAvailable) {
        info(`booting ${d.name} (${rt.replace("com.apple.CoreSimulator.SimRuntime.", "")})\u2026`);
        const boot = spawnSync("xcrun", ["simctl", "boot", d.udid], { stdio: "inherit" });
        if (boot.status === 0) {
          spawnSync("open", ["-a", "Simulator"], { stdio: "ignore" });
          return { ...d, runtime: rt };
        }
      }
    }
  }
  throw new Error("no bootable iPhone simulator found");
}

function ensureSimulator() {
  if (opt.device) {
    spawnSync("xcrun", ["simctl", "boot", opt.device], { stdio: "ignore" });
    spawnSync("open", ["-a", "Simulator"], { stdio: "ignore" });
    return { udid: opt.device, name: `(${opt.device.slice(0, 8)}\u2026)` };
  }
  let dev = findBootedDevice();
  if (dev) return dev;
  return bootFirstIphone();
}

// --- metro readiness --------------------------------------------------------
async function waitForMetro(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.ok && (await res.text()).includes("running")) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForAgent(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// --- graceful shutdown ------------------------------------------------------
const children = new Set();
function trackChild(child) {
  children.add(child);
  child.on("close", () => children.delete(child));
}
function shutdown() {
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* ignore */ }
  }
}
process.on("SIGINT", () => {
  console.log("\n" + C.yellow("\u2591 shutting down\u2026"));
  shutdown();
  setTimeout(() => process.exit(0), 500);
});
process.on("SIGTERM", shutdown);

// --- main -------------------------------------------------------------------
async function main() {
  console.log(C.bold("\n\u25e6 agent-simulator demo launcher\n"));
  preflight();

  step(1, "Booting iOS Simulator");
  const sim = ensureSimulator();
  ok(`simulator: ${sim.name} (${sim.udid.slice(0, 8)}\u2026)`);

  step(2, "Starting Metro for examples/expo-demo");
  const metro = spawn("bun", ["expo", "start", "--ios", "--clear"], {
    cwd: DEMO,
    env: { ...process.env, RCT_METRO_PORT: String(opt.metroPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackChild(metro);
  prefixStream(metro, "metro", C.dim);

  const metroReady = await waitForMetro(opt.metroPort);
  if (!metroReady) {
    fail("metro never reported ready. Check the [metro] log above.");
    shutdown();
    process.exit(1);
  }
  ok(`metro ready on :${opt.metroPort}`);

  step(3, "Launching demo in Expo Go");
  // Terminate any stale Expo Go process so the new bridge picks up the fresh bundle.
  spawnSync("xcrun", ["simctl", "terminate", sim.udid, "host.exp.Exponent"], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 500));
  const deepLink = `exp://127.0.0.1:${opt.metroPort}`;
  const openRes = spawnSync(
    "xcrun",
    ["simctl", "openurl", sim.udid, deepLink],
    { stdio: "inherit" },
  );
  if (openRes.status !== 0) {
    warn("could not openurl in the simulator \u2014 is Expo Go installed?");
  } else {
    ok(`opened ${deepLink} in Expo Go`);
  }

  step(4, `Starting agent-simulator server on :${opt.port}`);
  const server = spawn("node", [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(opt.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackChild(server);
  prefixStream(server, "server", (s) => C.green(s));
  const agentReady = await waitForAgent(opt.port);
  if (!agentReady) {
    fail("agent-simulator server never responded on /api/config");
    shutdown();
    process.exit(1);
  }
  ok(`server ready \u2014 http://localhost:${opt.port}`);

  step(5, "Opening the browser");
  if (opt.open) {
    spawnSync("open", [`http://localhost:${opt.port}`], { stdio: "ignore" });
    ok(`opened http://localhost:${opt.port}`);
  } else {
    info(`skipped (--no-open). Visit http://localhost:${opt.port}`);
  }

  console.log(
    "\n" +
      C.bold(C.green("\u25c9 demo running")) +
      "  \u2014  Ctrl-C to stop\n",
  );
}

main().catch((err) => {
  fail(err.message);
  shutdown();
  process.exit(1);
});
