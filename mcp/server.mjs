#!/usr/bin/env node
/**
 * agent-simulator MCP server
 * --------------------------
 * Bridges Model Context Protocol clients (Claude Desktop, the OpenAI Agents
 * SDK, etc.) into a running `sim-preview` Node server over its existing
 * WebSocket API. The MCP server itself speaks stdio — it's meant to be
 * spawned by an MCP host which handles transport.
 *
 * Requirements:
 *   - sim-preview server reachable at $SIM_PREVIEW_URL (default http://localhost:3200)
 *   - An RN app running with the inspector bridge for inspect / source tools
 *   - `axe` installed (brew install cameroncooke/axe/axe) for the accessibility
 *     tree + tap-by-label features
 *
 * All tools are thin wrappers over the same WS / HTTP protocol the browser
 * UI uses, so behaviour stays in sync across agents and humans.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";

const BASE_HTTP = process.env.SIM_PREVIEW_URL ?? "http://localhost:3200";
const BASE_WS = BASE_HTTP.replace(/^http/, "ws");

// --- Lazy WebSocket client to the sim-preview server -------------------------
class SimBridge {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.queue = [];
    this.pending = new Map(); // reqId -> { resolve, reject, timer }
    this.listeners = new Set();
    this.openPromise = null;
    this.connect();
  }

  connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.openPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => {
        const q = this.queue;
        this.queue = [];
        for (const msg of q) ws.send(JSON.stringify(msg));
        resolve();
      });
      ws.on("error", (err) => reject(err));
      ws.on("close", () => {
        this.ws = null;
        setTimeout(() => this.connect(), 1000);
      });
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.reqId && this.pending.has(msg.reqId)) {
          const { resolve, timer } = this.pending.get(msg.reqId);
          clearTimeout(timer);
          this.pending.delete(msg.reqId);
          resolve(msg);
        }
        for (const l of this.listeners) l(msg);
      });
    });
  }

  async send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      try {
        await this.openPromise;
      } catch {
        /* keep going; will queue */
      }
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  /** Send a request that expects a matching response by reqId. */
  request(msg, { timeoutMs = 5000 } = {}) {
    const reqId =
      msg.reqId ??
      `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const envelope = { ...msg, reqId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`sim-preview did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send(envelope).catch(reject);
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const bridge = new SimBridge(BASE_WS);

// --- Accessibility tree helpers ---------------------------------------------

/**
 * Fetch the full iOS accessibility tree via /api/tree, which proxies to
 * sim-server which calls `axe describe-ui`. Returns the raw JSON array.
 */
async function fetchAxTree() {
  const res = await fetch(`${BASE_HTTP}/api/tree`);
  if (!res.ok) throw new Error(`GET /api/tree HTTP ${res.status}`);
  return res.json();
}

/**
 * Walk the AX tree and find the node whose AXLabel / AXValue contains
 * `needle` (case-insensitive). Optionally constrain to a specific
 * accessibility `type` (e.g. "Button", "TextField"). Returns the deepest
 * match, which is normally what the user means.
 */
function findAxNode(tree, needle, typeFilter) {
  const n = needle.trim().toLowerCase();
  let best = null;
  const visit = (node, depth) => {
    if (!node) return;
    const label = (node.AXLabel || "").toLowerCase();
    const value = (node.AXValue || "").toLowerCase();
    const typeOk = !typeFilter || node.type === typeFilter;
    if (typeOk && (label.includes(n) || value.includes(n))) {
      if (!best || depth > best.depth) best = { node, depth };
    }
    const children = node.children || [];
    for (const c of children) visit(c, depth + 1);
  };
  const roots = Array.isArray(tree) ? tree : [tree];
  for (const r of roots) visit(r, 0);
  return best ? best.node : null;
}

/** Root device size from describe-ui (points). */
function deviceSizeFromTree(tree) {
  const roots = Array.isArray(tree) ? tree : [tree];
  const f = roots[0]?.frame;
  if (!f || typeof f.width !== "number") return null;
  return { width: f.width, height: f.height };
}

/** Convert a device-point frame to (x_ratio, y_ratio) of its center. */
function frameCenterRatio(frame, device) {
  if (!frame || !device) return null;
  return {
    x: (frame.x + frame.width / 2) / device.width,
    y: (frame.y + frame.height / 2) / device.height,
  };
}

// --- MCP server --------------------------------------------------------------
const mcp = new McpServer(
  { name: "agent-simulator", version: "0.3.0" },
  { capabilities: { tools: {}, resources: {}, logging: {} } },
);

const okText = (text) => ({ content: [{ type: "text", text }] });
const okJson = (obj) => okText(JSON.stringify(obj, null, 2));

// --- Inspection / info -------------------------------------------------------

mcp.registerTool(
  "sim_info",
  {
    title: "Get simulator info",
    description:
      "Returns the connected iOS simulator's UDID, name, stream URL, and device size. Call this first to verify the sim-preview server is reachable.",
    inputSchema: {},
  },
  async () => {
    const cfg = await fetch(`${BASE_HTTP}/api/config`).then((r) => r.json());
    let device = null;
    try {
      device = deviceSizeFromTree(await fetchAxTree());
    } catch {
      /* axe may be temporarily unavailable */
    }
    return okJson({ ...cfg, device });
  },
);

mcp.registerTool(
  "sim_tree",
  {
    title: "Read the iOS accessibility tree",
    description:
      "Returns the full `axe describe-ui` JSON for the booted simulator. Every on-screen element with its label, value, type, role, and device-point frame. Use this as the primary way to locate UI the agent wants to act on \u2014 no screenshot OCR needed.",
    inputSchema: {
      /** Pass `flat=true` to get a flattened {label, type, frame} list
       *  stripped of hierarchy, which is smaller for LLM context. */
      flat: z.boolean().optional().default(false),
    },
  },
  async ({ flat }) => {
    const tree = await fetchAxTree();
    if (!flat) return okJson(tree);
    const out = [];
    const visit = (n, path) => {
      if (n.AXLabel || n.AXValue) {
        out.push({
          path,
          type: n.type,
          label: n.AXLabel || null,
          value: n.AXValue || null,
          frame: n.frame,
        });
      }
      (n.children || []).forEach((c, i) => visit(c, `${path}/${i}`));
    };
    (Array.isArray(tree) ? tree : [tree]).forEach((r, i) =>
      visit(r, String(i)),
    );
    return okJson(out);
  },
);

// --- Tap / drive -------------------------------------------------------------

mcp.registerTool(
  "sim_tap",
  {
    title: "Tap at (x, y) ratio",
    description:
      "Sends a single tap at (x, y) given as ratios in [0, 1] of the sim screen. Use sim_tap_by_label for element-based targeting \u2014 it's more robust to layout changes.",
    inputSchema: {
      x: z.number().min(0).max(1).describe("Horizontal position 0..1"),
      y: z.number().min(0).max(1).describe("Vertical position 0..1"),
    },
  },
  async ({ x, y }) => {
    await bridge.send({ type: "touch", action: "tap", x, y });
    return okText(`tapped at (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

mcp.registerTool(
  "sim_tap_by_label",
  {
    title: "Tap an accessibility element by label",
    description:
      "Look up an element in the accessibility tree by AXLabel / AXValue (case-insensitive substring match) and tap its center. Much more robust than coordinate-based taps because it survives layout changes. Optional `type` filters to a specific accessibility type (Button, TextField, Switch, StaticText, Image, Cell, etc.)",
    inputSchema: {
      label: z.string().describe("Substring of AXLabel or AXValue to match"),
      type: z
        .string()
        .optional()
        .describe('Optional accessibility type filter, e.g. "Button"'),
    },
  },
  async ({ label, type }) => {
    const tree = await fetchAxTree();
    const device = deviceSizeFromTree(tree);
    const node = findAxNode(tree, label, type);
    if (!node) {
      return okJson({
        ok: false,
        message: `no element matching ${JSON.stringify(label)}${
          type ? ` of type ${type}` : ""
        }`,
      });
    }
    const center = frameCenterRatio(node.frame, device);
    if (!center) {
      return okJson({ ok: false, message: "matched node has no frame" });
    }
    await bridge.send({
      type: "touch",
      action: "tap",
      x: center.x,
      y: center.y,
    });
    return okJson({
      ok: true,
      matched: {
        label: node.AXLabel,
        value: node.AXValue,
        type: node.type,
        frame: node.frame,
      },
      tappedAt: center,
    });
  },
);

mcp.registerTool(
  "sim_swipe",
  {
    title: "Swipe the simulator",
    description:
      "Performs a swipe from (x1, y1) to (x2, y2) in 0..1 sim-ratio coordinates. `durationMs` controls the gesture length (default 250ms). Issues a single native gesture via axe \u2014 no per-step stdin traffic.",
    inputSchema: {
      x1: z.number().min(0).max(1),
      y1: z.number().min(0).max(1),
      x2: z.number().min(0).max(1),
      y2: z.number().min(0).max(1),
      durationMs: z.number().int().min(50).max(3000).optional().default(250),
    },
  },
  async ({ x1, y1, x2, y2, durationMs }) => {
    await bridge.send({
      type: "swipe",
      x1,
      y1,
      x2,
      y2,
      duration: durationMs / 1000,
    });
    return okText(
      `swiped (${x1.toFixed(3)},${y1.toFixed(3)}) \u2192 (${x2.toFixed(3)},${y2.toFixed(3)}) in ${durationMs}ms`,
    );
  },
);

mcp.registerTool(
  "sim_type",
  {
    title: "Type text into the focused field",
    description:
      "Sends text to whatever TextField is currently focused. Printable ASCII only (axe HID protocol limitation). Tap a TextField first with sim_tap_by_label, then call sim_type.",
    inputSchema: {
      text: z.string().min(1),
    },
  },
  async ({ text }) => {
    await bridge.send({ type: "type", text });
    return okText(`typed ${text.length} char(s)`);
  },
);

mcp.registerTool(
  "sim_key",
  {
    title: "Press a single HID key",
    description:
      "Presses a single USB-HID keycode on the simulator keyboard. Useful for Return (40), Backspace (42), Tab (43), Escape (41), arrows (80\u201383), etc.",
    inputSchema: {
      keycode: z
        .number()
        .int()
        .min(0)
        .max(255)
        .describe("USB HID keycode 0\u2013255"),
    },
  },
  async ({ keycode }) => {
    await bridge.send({ type: "key", keyCode: String(keycode) });
    return okText(`pressed HID ${keycode}`);
  },
);

mcp.registerTool(
  "sim_button",
  {
    title: "Press a hardware button",
    description:
      "Presses a simulator hardware button. Supports home, lock, power (alias for lock), side-button, siri, and apple-pay.",
    inputSchema: {
      button: z.enum([
        "home",
        "lock",
        "power",
        "side-button",
        "siri",
        "apple-pay",
      ]),
    },
  },
  async ({ button }) => {
    await bridge.send({ type: "button", button });
    return okText(`pressed ${button}`);
  },
);

mcp.registerTool(
  "sim_multitask",
  {
    title: "Open the app switcher",
    description:
      "Triggers the iPhone-X-style multitask gesture (swipe up from the bottom and hold). Use sim_button 'home' to return to the home screen instead.",
    inputSchema: {},
  },
  async () => {
    await bridge.send({ type: "multitask" });
    return okText("multitask gesture sent");
  },
);

// --- Screenshots -------------------------------------------------------------

mcp.registerTool(
  "sim_screenshot",
  {
    title: "Capture a simulator screenshot",
    description:
      "Fetches the current frame from the sim-preview MJPEG stream as a JPEG image. Useful for visual context or before/after comparisons.",
    inputSchema: {},
  },
  async () => {
    const cfg = await fetch(`${BASE_HTTP}/api/config`).then((r) => r.json());
    const img = await fetch(cfg.snapshotUrl).then((r) => r.arrayBuffer());
    const b64 = Buffer.from(img).toString("base64");
    return {
      content: [{ type: "image", data: b64, mimeType: "image/jpeg" }],
    };
  },
);

// --- React inspector ---------------------------------------------------------

mcp.registerTool(
  "sim_inspect",
  {
    title: "Inspect the React component under a point",
    description:
      "Inspect the RN component at (x, y) in 0..1 sim-ratio coordinates. Returns the component stack with source locations (symbolicated against Metro) when available. Requires the inspector bridge to be connected from the running app.",
    inputSchema: {
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    },
  },
  async ({ x, y }) => {
    const result = await bridge.request(
      { type: "inspect", x, y, requestStack: true },
      { timeoutMs: 6000 },
    );
    if (result.error) throw new Error(result.error);
    return okJson({
      frame: result.frame,
      stack: (result.stack ?? []).map((f) => ({
        componentName: f.componentName,
        source: f.source,
        frame: f.frame,
      })),
    });
  },
);

mcp.registerTool(
  "sim_source",
  {
    title: "Read source around a file:line",
    description:
      "Fetch a window of source code around a line from the project's filesystem. Pass an absolute path. Used to inspect React component source when sim_inspect returns a source location.",
    inputSchema: {
      file: z.string().describe("Absolute file path"),
      line: z.number().int().min(1).describe("1-based line number"),
      context: z.number().int().min(0).max(80).optional().default(14),
    },
  },
  async ({ file, line, context }) => {
    const qs = new URLSearchParams({
      file,
      line: String(line - 1),
      context: String(context),
    });
    const res = await fetch(`${BASE_HTTP}/api/source?${qs}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET /api/source ${res.status}: ${body}`);
    }
    return okJson(await res.json());
  },
);

mcp.registerTool(
  "sim_select_by_source",
  {
    title: "Find a rendered element by source location",
    description:
      "Find the rendered React component whose source origin matches the given file and line. Probes a grid of points until a match is found. Useful for 'where does this code render on the screen' flows.",
    inputSchema: {
      fileName: z
        .string()
        .describe("Absolute or partial file path; matching is a suffix test."),
      line: z.number().int().min(1).describe("1-based line number"),
      gridSize: z.number().int().min(4).max(40).optional().default(12),
    },
  },
  async ({ fileName, line, gridSize }) => {
    const line0 = line - 1;
    for (let gx = 0; gx < gridSize; gx++) {
      for (let gy = 0; gy < gridSize; gy++) {
        const x = (gx + 0.5) / gridSize;
        const y = (gy + 0.5) / gridSize;
        let result;
        try {
          result = await bridge.request(
            { type: "inspect", x, y, requestStack: true },
            { timeoutMs: 800 },
          );
        } catch {
          continue;
        }
        const hit = result.stack?.find(
          (f) =>
            f.source &&
            (f.source.fileName.endsWith(fileName) ||
              f.source.fileName === fileName) &&
            f.source.line0Based === line0,
        );
        if (hit) {
          return okJson({
            probe: { x, y },
            match: hit,
            frame: result.frame,
            stackDepth: result.stack.length,
          });
        }
      }
    }
    return okJson({
      ok: false,
      message: `no probe matched ${fileName}:${line} on a ${gridSize}\u00d7${gridSize} grid`,
    });
  },
);

// --- Selection streaming -----------------------------------------------------

const streamUnsubscribe = { fn: null };
mcp.registerTool(
  "sim_subscribe_selections",
  {
    title: "Subscribe to selection events",
    description:
      "Forwards every inspectResult message from the sim-preview server to this MCP session as logging notifications. Lets an agent watch everything the human clicks in the UI. Call sim_unsubscribe_selections to stop.",
    inputSchema: {},
  },
  async (_args, extra) => {
    if (streamUnsubscribe.fn) streamUnsubscribe.fn();
    streamUnsubscribe.fn = bridge.on((msg) => {
      if (msg.type !== "inspectResult") return;
      try {
        extra?.sendNotification?.({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "agent-simulator",
            data: {
              event: "selection",
              frame: msg.frame,
              stack: msg.stack,
            },
          },
        });
      } catch {
        /* client might not be listening; swallow */
      }
    });
    return okText("subscribed to selection events");
  },
);

mcp.registerTool(
  "sim_unsubscribe_selections",
  {
    title: "Unsubscribe from selection events",
    description: "Stops forwarding inspectResult messages to this MCP session.",
    inputSchema: {},
  },
  async () => {
    if (streamUnsubscribe.fn) {
      streamUnsubscribe.fn();
      streamUnsubscribe.fn = null;
      return okText("unsubscribed");
    }
    return okText("no active subscription");
  },
);

// --- Connect -----------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  // Log to stderr — stdout is reserved for the MCP framing protocol.
  console.error("[agent-simulator MCP] ready. bridge \u2192", BASE_HTTP);
}

main().catch((err) => {
  console.error("[agent-simulator MCP] fatal:", err);
  process.exit(1);
});
