# Agent Simulator

**Live iOS Simulator preview with React Native inspector, accessibility-tree driven tools, and an MCP bridge.** Drive iOS apps from your browser or an AI agent — see the live screen, click any element to get its real source code, tap / swipe / type without moving the macOS cursor.

Built for three audiences at once:

1. **RN / Expo devs** who want a Figma-style "layers panel" for their running app, with real `App.tsx:42` source lookups.
2. **QA & demo flows** that want a scriptable sim without the pain of XCUITest — accessibility-label taps, swipes, keyboard input, screenshots.
3. **AI agents** (Claude Desktop, OpenAI Agents SDK, Cursor, …) that need a first-class tool surface to *see* what's on the screen and *act* on it. Everything the browser can do is exposed over MCP.

```
┌──────────────────────────┐    ┌─────────────────────────────┐
│ Browser UI               │    │ MCP client                  │
│ /   (agent-simulator)    │    │ (Claude Desktop, Codex, …)  │
│  - live MJPEG stream     │    └────────────────┬────────────┘
│  - iOS a11y layer tree   │                     │ stdio
│  - React component tree  │                     ↓
│  - props + source window │    ┌─────────────────────────────┐
│  - tap/swipe/drive/type  │    │ mcp/server.mjs              │
└─────────────┬────────────┘    │ 15 MCP tools over WS        │
              │ WS + HTTP       └────────────────┬────────────┘
              ↓                                  │ WS
┌──────────────────────────────────────────────────┐
│ server.js (Node)                                 │
│ static · /api/config · /api/tree · /api/source   │
│ WS bridge · Metro /symbolicate proxy             │
└──┬────────┬──────────────────────────────────────┘
   │ stdin  │ WS (opt.)
   ↓        ↓
┌──────────┐ ┌─────────────────────┐
│sim-server│ │ Expo / RN app with  │
│ (Rust)   │ │ agent-simulator     │
│ MJPEG +  │ │ metro plugin        │
│ axe HID  │ │ (inspector bridge)  │
└─────┬────┘ └─────────────────────┘
      │
  iOS Simulator (axe + simctl)
```

---

## Features

| | |
|---|---|
| **Cursor-free input** | Every tap / swipe / key goes through [`axe`](https://github.com/cameroncooke/AXe) → `FBSimulatorHID` → `CoreSimulator`. No macOS cursor movement, no Simulator.app focus requirement, pixel-exact at any zoom. |
| **Drive any iOS app** | Taps, drags, mouse-wheel scroll, multitask, home, lock, keyboard passthrough. Works on Settings, Maps, Messages — not just RN apps. |
| **iOS accessibility tree** | Populated from `axe describe-ui` on boot. Every on-screen element with its label, role, and frame — before you click anything. |
| **React component tree** | For RN apps running the metro plugin, inspect any rendered component and get the full fiber stack with real source paths (React 19 `_debugStack` + Metro `/symbolicate`). |
| **Real source code panel** | Select any component and the Properties panel fetches the actual file and renders a code window around the target line. Works for your code, RN's Libraries, and Expo shims. |
| **MCP bridge** | 15 tools: `sim_tree`, `sim_tap_by_label`, `sim_swipe`, `sim_type`, `sim_inspect`, `sim_source`, `sim_screenshot`, and more. Every browser capability exposed to AI agents. |

---

## Requirements

- **macOS** with Xcode + at least one iOS simulator installed.
- **Node ≥ 18** (or Bun — scripts are bun-friendly).
- **Rust toolchain** (for building `sim-server` once).
- **[axe](https://github.com/cameroncooke/AXe)** — the cursor-free input driver. One-line install:

  ```bash
  brew install cameroncooke/axe/axe
  ```

- **A React Native / Expo app** with the agent-simulator metro plugin, *only if* you want React component inspection. Driving, screenshots, and the iOS accessibility tree all work against any iOS app.

---

## Quick start (1 minute)

```bash
# 1. Clone & install
git clone https://github.com/jkneen/agent-simulator
cd agent-simulator
bun install

# 2. Build the Rust sim-server (once)
(cd sim-server && cargo build --release)

# 3. Build the web UI (once, or after UI changes)
(cd web-app && bun install && bun run build)

# 4. Boot any simulator yourself, then start the server
xcrun simctl boot "iPhone 17 Pro" || true
open -a Simulator
bun start

# 5. Open the UI
open http://localhost:3200
```

The UI will attach to whatever iOS simulator is booted. Open Settings, Maps, Messages, or any app — you can drive it immediately. The iOS layer tree on the left is populated from the accessibility API; the React tree is empty until you load an RN app with the inspector bridge (see below).

---

## One-command demo (the fun one)

We ship an Expo demo app and a launcher that starts everything for you.

```bash
bun demo
```

This will:

1. Boot the first available iPhone simulator (or reuse the booted one).
2. Start Metro for `examples/expo-demo` on port 8081.
3. Launch the demo via `exp://127.0.0.1:8081` in Expo Go.
4. Start the agent-simulator Node server on :3200.
5. Open `http://localhost:3200` in your browser.

Ctrl-C cleans up both processes. Once it's running you can:

- Click anywhere in the preview to drive the app (the tap animates with a pulse ring, and the Layers panel expands to the nearest accessibility element).
- Hit `I` to enter **Inspect mode**, hover / click a React component, and watch the Properties panel fill with the component name, source file, and actual JSX code.
- Tap the `+` on the counter — the Code panel opens `examples/expo-demo/App.tsx:42` with the `<Text style={styles.pillText}>+</Text>` line highlighted.

Flags:

```bash
bun demo --no-open             # skip launching the browser
bun demo --port=3300           # use a different agent-simulator port
bun demo --metro-port=8082     # use a different Metro port
bun demo --device=<UDID>       # target a specific simulator
```

---

## Adding agent-simulator to your own RN / Expo app

If you already have an app, add the metro plugin so the inspector bridge injects at boot:

```js
// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const { withAgentSimulator } = require("agent-simulator/runtime/metro-plugin");

module.exports = withAgentSimulator(getDefaultConfig(__dirname));
```

…then install this package alongside:

```bash
bun add -D agent-simulator
```

Or, if you don't want to touch Metro config, import the bridge at your app's entry point *before* `registerRootComponent`:

```ts
// index.ts
import "agent-simulator/runtime/inspector-bridge";
import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
```

When your app launches with either setup, the **BRIDGE** pill in the toolbar turns green and inspect clicks produce full component stacks with real source locations.

---

## The UI

| Region | What it shows |
|---|---|
| Header | Device chip, stream + bridge status pills, Inspect toggle, Home / Multitask / Lock / Rotate, panel toggles, theme menu. |
| Layers panel (left) | Toggles between the **iOS accessibility tree** (populated automatically) and the **React component tree** (populated on inspect). Click any layer to select, hover to highlight, the tree auto-expands ancestors when you tap inside the sim. |
| Simulator canvas | Live MJPEG. In drive mode, the native cursor is hidden and replaced by a round in-preview pointer; taps fire a ping ring, drags become swipes, the mouse wheel scrolls, the keyboard types into the focused field. Inspect mode replaces the pointer with a crosshair and draws selection overlays. |
| Properties panel (right) | Selected layer's accessibility properties, React component name + source, and a highlighted code window around the JSX call site or component definition. |
| Status bar | UDID, mode flags, last-inspect frame count, keyboard shortcut hints. |

### Keyboard shortcuts

- `I` — toggle Inspect (disabled when no RN bridge)
- `Esc` — cancel Inspect / unpin selection
- Any other keystroke while the preview is focused → forwarded to the sim (works for any text field)

---

## MCP bridge

`mcp/server.mjs` is a standalone [Model Context Protocol](https://modelcontextprotocol.io) server. It speaks stdio to any MCP host and bridges to the running agent-simulator server over WebSocket. All 15 tools:

| Tool | Purpose |
|---|---|
| `sim_info` | Device UDID / name / stream URL / device-point size. |
| `sim_tree` | Full iOS accessibility tree. `flat: true` returns a labelled-element list for cheap LLM context. |
| `sim_tap` | Tap at `(x, y)` sim-ratio. |
| `sim_tap_by_label` | Look up an AX element by label / value (optional type filter) and tap its centre — robust to layout changes. |
| `sim_swipe` | Single-call native swipe with `durationMs`. |
| `sim_type` | Type printable text into the focused TextField. |
| `sim_key` | Press one USB-HID keycode (Return=40, Backspace=42, Esc=41, arrows 80–83…). |
| `sim_button` | `home` / `lock` / `power` / `side-button` / `siri` / `apple-pay`. |
| `sim_multitask` | Open the app switcher. |
| `sim_screenshot` | Returns the current frame as an MCP `image` content. |
| `sim_inspect` | Inspect the RN component at `(x, y)` — returns a source-symbolicated component stack. |
| `sim_source` | Read a code window around `file:line` for any absolute path in the workspace. |
| `sim_select_by_source` | Given `fileName` + `line`, probes a grid until it finds a rendered component whose source matches. |
| `sim_subscribe_selections` | Streams `inspectResult` events back as MCP logging notifications. |
| `sim_unsubscribe_selections` | Stops the above. |

### Configure an MCP client

For **Claude Desktop**, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "agent-simulator": {
      "command": "node",
      "args": ["/absolute/path/to/agent-simulator/mcp/server.mjs"],
      "env": { "SIM_PREVIEW_URL": "http://localhost:3200" }
    }
  }
}
```

Then start the agent-simulator server (`bun start` or `bun demo`). The MCP server connects on demand.

For any other MCP host (OpenAI Agents SDK, Cursor, Continue, Codex, custom harnesses): spawn `node /path/to/mcp/server.mjs` with `SIM_PREVIEW_URL` pointing at your running server.

### Example agent flow

```
1. sim_tree flat:true                       → see every element on screen
2. sim_tap_by_label "+"                     → tap the counter's plus
3. sim_tap_by_label "Your name" type:"TextField"
4. sim_type "hello agent"
5. sim_key 40                               → Return
6. sim_inspect x:0.86 y:0.24                → returns App.tsx:42
7. sim_source file:".../App.tsx" line:42    → read the JSX
```

---

## Architecture

Three binaries, one simulator:

1. **sim-server (Rust)** — captures the simulator screen via `simctl io screenshot`, encodes MJPEG, serves `/stream.mjpeg`, `/snapshot.jpg`, `/api/tree`, and `/health`. Reads tap / swipe / type commands from stdin and shells out to `axe`.
2. **server.js (Node)** — orchestrates sim-server, serves the Vite-built UI, exposes `/api/config` / `/api/tree` / `/api/source`, bridges browser and MCP WebSocket clients, proxies stack frames through Metro's `/symbolicate` for React inspection.
3. **web-app (React + shadcn + Tailwind)** — the UI. Dark / light themes, two trees, resizable panels, keyboard capture, drag-to-swipe, wheel-to-scroll.

### Touch injection

Clicks from the UI (or MCP) travel:

```
browser ── WS ──> server.js ── stdin ──> sim-server ── exec ──> axe tap -x … -y … --udid …
                                                                       │
                                                                       └──> FBSimulatorHID → CoreSimulator
                                                                           (device-point coords, cursor-free)
```

Coordinates are carried as `[0, 1]` ratios end-to-end; `sim-server` converts to device points using the root `AXFrame` from `axe describe-ui` (cached with a 5 s TTL, invalidated on rotate). Every gesture is one subprocess call — no per-step stdin traffic.

### `/api/tree` and `/api/source`

- **`GET /api/tree`** — proxies `axe describe-ui --udid <udid>` via sim-server and returns the raw JSON. The UI pulls this on boot and on refresh; the MCP `sim_tree` tool wraps it.
- **`GET /api/source?file=ABS&line=N&context=M`** — reads a window of lines around `line` from an absolute path, returns `{file, lines, startLine0, endLine0, targetLine0, language}`. Powers the Code panel in the UI and the `sim_source` MCP tool.

### React source resolution

React 19 removed `fiber._debugSource`. Sources now live inside `fiber._debugStack`, an `Error` object whose stack string points at bundle-URL line/col pairs. On every `inspectResult`:

1. The inspector-bridge (in the RN app) parses `_debugStack`, collects up to 12 candidate frames per fiber, attaches them as `bundleFrames: […]`.
2. `server.js` batch-POSTs every bundle frame to `http://localhost:8081/symbolicate` in one round trip and picks the first candidate per fiber that isn't inside React's own `createElement` / `jsxDEV` plumbing.
3. The UI receives a regular `stack[i].source` with a real absolute file path.

This means *every* user component, RN internal component (RCTView, ScrollView, …), and Expo shim resolves to actual code on disk.

---

## Tips

- Use **`axe`'s simulator conventions** (device points, not Mac pixels) if you're writing agent scripts directly. The UI handles the ratio ↔ point conversion.
- **`axe describe-ui`** is a great reference: `axe describe-ui --udid <UDID> | jq '.[0]'`.
- The Metro cache is invalidated when `inspector-bridge.js` changes. If the bridge version log doesn't advance after an edit, restart Metro with `expo start --clear`.
- `SP_FPS` and `SP_QUALITY` env vars tune MJPEG performance (defaults: `fps=3 q=55`).

---

## Development

```bash
# Re-build the Rust server after Rust edits
(cd sim-server && cargo build --release)

# Re-build the UI after web-app edits
(cd web-app && bun run build)

# Run the MCP server standalone
bun mcp

# Tail MCP traffic with the official inspector
npx @modelcontextprotocol/inspector node mcp/server.mjs
```

Project layout:

```
agent-simulator/
├── server.js              Node orchestrator, WS bridge, HTTP
├── scripts/demo.mjs       One-command demo launcher
├── sim-server/            Rust MJPEG + axe driver
├── runtime/               RN metro plugin + inspector bridge
├── web-app/               Vite + React + shadcn UI
├── web/                   Legacy single-file UI (served at /classic)
├── mcp/                   MCP server (15 tools)
├── examples/expo-demo/    Expo app with the plugin pre-configured
└── LICENSE                AGPL-3.0-or-later
```

---

## License

**AGPL-3.0-or-later.** See [`LICENSE`](./LICENSE).

If you're embedding agent-simulator inside a commercial product, or you need a different license, open an issue — I'm happy to talk about dual-licensing.
