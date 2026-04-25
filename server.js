#!/usr/bin/env node
const http = require('http');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3200');
const SIM_SERVER = path.join(__dirname, 'sim-server', 'target', 'release', 'sim-server');
const SIMSTREAM_PACKAGE_DIR = path.join(__dirname, 'sidecars', 'simstream');
const SIMSTREAM_BIN = path.join(SIMSTREAM_PACKAGE_DIR, '.build', 'release', 'simstream');

// Find booted simulator
async function findBootedSimulator() {
  return new Promise((resolve, reject) => {
    const proc = spawn('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    let stdout = '';
    proc.stdout.on('data', d => stdout += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('simctl failed'));
      try {
        const data = JSON.parse(stdout);
        for (const [runtime, devices] of Object.entries(data.devices)) {
          for (const device of devices) {
            if (device.state === 'Booted') {
              return resolve({ udid: device.udid, name: device.name, runtime });
            }
          }
        }
        reject(new Error('No booted simulator found'));
      } catch (e) { reject(e); }
    });
  });
}

// The new Vite-built UI lives in web-app/dist. The legacy single-file HTML UI
// remains in web/ and is served under /classic for anyone who needs it.
const WEB_APP_DIR = path.join(__dirname, 'web-app', 'dist');
const LEGACY_DIR = path.join(__dirname, 'web');

/**
 * Files we never show to the user — these are React's own createElement /
 * jsxDEV / reconciler plumbing. Everything else (including node_modules/
 * react-native's component sources) is fair game and useful to read.
 */
const UNHELPFUL_SOURCE_RE =
  /\/node_modules\/(react|scheduler|react-dom|react-reconciler)\/(cjs|umd|esm)\/|\/react-jsx-(dev-)?runtime/;

async function symbolicateInspectResult(msg) {
  const stack = Array.isArray(msg.stack) ? msg.stack : [];
  const flat = [];
  const slots = [];
  for (let i = 0; i < stack.length; i++) {
    const frames = stack[i] && stack[i].bundleFrames;
    if (!Array.isArray(frames)) continue;
    for (let k = 0; k < frames.length; k++) {
      const bf = frames[k];
      if (!bf || !bf.file || typeof bf.lineNumber !== 'number') continue;
      slots.push({ stackIdx: i, frameIdx: k });
      flat.push({
        file: bf.file,
        lineNumber: bf.lineNumber,
        column: bf.column || 0,
        methodName: bf.methodName || '',
      });
    }
  }
  if (flat.length === 0) return msg;

  let resolved;
  try {
    const res = await fetch('http://127.0.0.1:8081/symbolicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: flat }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    resolved = data && Array.isArray(data.stack) ? data.stack : [];
  } catch (err) {
    console.warn('metro /symbolicate unavailable:', err.message);
    return msg;
  }

  const perItem = stack.map(() => []);
  for (let j = 0; j < slots.length; j++) {
    const { stackIdx } = slots[j];
    const s = resolved[j];
    if (!s || !s.file || typeof s.file !== 'string' || !s.file.startsWith('/')) continue;
    perItem[stackIdx].push(s);
  }

  const newStack = stack.slice();
  for (let i = 0; i < newStack.length; i++) {
    if (newStack[i] && newStack[i].source) continue;
    const candidates = perItem[i];
    if (!candidates || candidates.length === 0) continue;
    const pick = candidates.find((c) => !UNHELPFUL_SOURCE_RE.test(c.file));
    if (!pick) continue;
    newStack[i] = {
      ...newStack[i],
      source: {
        fileName: pick.file,
        line0Based: Math.max(0, (pick.lineNumber || 1) - 1),
        column0Based: Math.max(0, (pick.column || 1) - 1),
      },
      bundleFrames: undefined,
    };
  }
  return { ...msg, stack: newStack };
}

function langFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.mjs': 'javascript', '.cjs': 'javascript',
    '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown',
    '.rs': 'rust', '.py': 'python', '.swift': 'swift', '.m': 'objc',
  }[ext] || 'plain';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveStatic(req, res) {
  if (req.url === '/classic' || req.url.startsWith('/classic/')) {
    const rel = req.url === '/classic' ? '/index.html' : req.url.slice('/classic'.length);
    return serveFile(res, path.join(LEGACY_DIR, rel));
  }

  const useApp = fs.existsSync(path.join(WEB_APP_DIR, 'index.html'));
  if (!useApp) {
    const rel = req.url === '/' ? '/index.html' : req.url;
    return serveFile(res, path.join(LEGACY_DIR, rel));
  }

  const direct = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const candidate = path.join(WEB_APP_DIR, direct);
  fs.stat(candidate, (err, stat) => {
    if (!err && stat.isFile()) return serveFile(res, candidate);
    serveFile(res, path.join(WEB_APP_DIR, 'index.html'));
  });
}

// ----------------------------------------------------------------------------
// Capture process management. sim-server is spawned with --fps / --quality
// and SP_SCALE / SP_CAPTURE env vars. Every time the UI asks for a new
// quality preset we kill this child and spawn a fresh one with the new
// values; the stream URL stays accessible under a fresh randomly-bound
// port that we broadcast to connected UI clients.
// ----------------------------------------------------------------------------

/**
 * @typedef {Object} CaptureSettings
 * @property {number} fps       2..30
 * @property {number} quality   10..95
 * @property {number} scale     0.1..1.0
 * @property {'mjpeg' | 'bgra' | 'simstream'} mode
 */

/**
 * Clamp + coerce a CaptureSettings-shaped input to safe defaults.
 *
 * Mode selection rules:
 *   - `mode: 'simstream'` CoreSimulator/SimulatorKit IOSurface capture,
 *                    VideoToolbox H.264 encode, fMP4-over-WebSocket playback.
 *   - `mode: 'bgra'`  explicit BGRA push-stream (FBVideoStreamConfiguration).
 *                    Uncapped FPS, driven by the simulator's render rate.
 *                    Best for scrolling / animation — may stall on idle.
 *   - `mode: 'mjpeg'` axe screenshot-polling loop. Capped at 30 fps by axe
 *                    itself; anything above that is clamped.
 *
 * We auto-upgrade to BGRA whenever fps > 30 even if the caller asked
 * for MJPEG, because axe refuses fps > 30 for the MJPEG path and would
 * exit immediately with a validation error.
 */
function sanitizeSettings(input = {}) {
  const envMode = process.env.SP_CAPTURE === 'simstream'
    ? 'simstream'
    : (process.env.SP_CAPTURE === 'bgra' ? 'bgra' : 'mjpeg');
  const def = {
    fps: parseInt(process.env.SP_FPS || '3', 10),
    quality: parseInt(process.env.SP_QUALITY || '55', 10),
    scale: parseFloat(process.env.SP_SCALE || '0.33'),
    mode: envMode,
  };
  const rawFps = clampNum(input.fps ?? def.fps, 1, 60);
  const quality = clampNum(input.quality ?? def.quality, 10, 95);
  const scale = clampNum(input.scale ?? def.scale, 0.1, 1.0);
  let mode = input.mode === 'simstream'
    ? 'simstream'
    : (input.mode === 'bgra' ? 'bgra' : (input.mode === 'mjpeg' ? 'mjpeg' : def.mode));
  if (rawFps > 30 && mode === 'mjpeg') mode = 'bgra';
  // When mode=mjpeg we MUST keep fps ≤ 30 so axe doesn't crash.
  const fps = mode === 'mjpeg' ? Math.min(rawFps, 30) : rawFps;
  return { fps, quality, scale, mode };
}
function clampNum(v, lo, hi) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Current subprocess state, mutated on every respawn. */
const capture = {
  settings: sanitizeSettings(),
  proc: null,          // always the sim-server control process used for input/tree/snapshot
  sidecarProc: null,   // native fMP4 WebSocket sidecar when mode=simstream
  streamUrl: null,
  controlUrl: null,
  streamKind: 'mjpeg',
  pending: null, // Promise<string> while a spawn is in flight
};

let simstreamBuildPromise = null;

function broadcastToUi(payload) { /* wired up after wss exists */ }

function killCaptureProcesses() {
  for (const key of ['sidecarProc', 'proc']) {
    const proc = capture[key];
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      capture[key] = null;
    }
  }
  capture.streamUrl = null;
  capture.controlUrl = null;
  capture.streamKind = 'mjpeg';
}

function snapshotUrl() {
  const base = capture.controlUrl || (capture.streamKind === 'mjpeg' ? capture.streamUrl : null);
  return base?.replace('/stream.mjpeg', '/snapshot.jpg') || null;
}

function treeUrl() {
  const base = capture.controlUrl || (capture.streamKind === 'mjpeg' ? capture.streamUrl : null);
  return base?.replace('/stream.mjpeg', '/api/tree') || null;
}

function makeConfig(sim) {
  return {
    streamUrl: capture.streamUrl,
    streamKind: capture.streamKind,
    snapshotUrl: snapshotUrl(),
    simulator: { udid: sim.udid, name: sim.name },
    capture: capture.settings,
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function ensureSimstreamBinary() {
  if (fs.existsSync(SIMSTREAM_BIN)) return Promise.resolve(SIMSTREAM_BIN);
  if (simstreamBuildPromise) return simstreamBuildPromise;
  console.log('🛠️  Building simstream sidecar…');
  simstreamBuildPromise = new Promise((resolve, reject) => {
    const proc = spawn('swift', ['build', '-c', 'release', '--package-path', SIMSTREAM_PACKAGE_DIR], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('close', (code) => {
      simstreamBuildPromise = null;
      if (code === 0 && fs.existsSync(SIMSTREAM_BIN)) resolve(SIMSTREAM_BIN);
      else reject(new Error(`simstream build failed code=${code}`));
    });
  });
  return simstreamBuildPromise;
}

function spawnSimServer(sim, settings, label = 'sim-server') {
  console.log(
    `🚀 ${label} (fps=${settings.fps} q=${settings.quality} scale=${settings.scale} mode=${settings.mode})…`,
  );
  const env = {
    ...process.env,
    SP_SCALE: String(settings.scale),
    SP_CAPTURE: settings.mode === 'bgra' ? 'bgra' : 'mjpeg',
  };
  const proc = spawn(
    SIM_SERVER,
    [
      '--id', sim.udid,
      '--fps', String(settings.fps),
      '--quality', String(settings.quality),
      '--port', '0',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env },
  );

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`${label} timeout`));
      }
    }, 15000);
    proc.stdout.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line.startsWith('stream_ready')) {
          clearTimeout(timer);
          settled = true;
          const url = line.split(' ')[1];
          console.log(`📺 ${label} ready: ${url}`);
          resolve({ proc, streamUrl: url });
        }
      }
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`${label} exited code=${code}`));
      } else if (capture.proc === proc) {
        console.warn(`${label} exited unexpectedly (code=${code})`);
        capture.proc = null;
        capture.controlUrl = null;
      }
    });
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.includes('ERROR') || line.includes('WARN')) {
        console.log(`  ${label}: ${line}`);
      }
    }
  });

  return ready;
}

async function spawnSimstreamSidecar(sim, settings) {
  const bin = await ensureSimstreamBinary();
  const port = await getFreePort();
  console.log(`🚀 simstream sidecar (fps=${settings.fps} port=${port})…`);
  const proc = spawn(bin, [sim.udid, String(port), String(settings.fps)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('simstream sidecar timeout'));
      }
    }, 20000);

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line.startsWith('stream_ready')) {
          clearTimeout(timer);
          settled = true;
          const url = line.split(' ')[1];
          console.log(`🎞️  simstream ready: ${url}`);
          resolve({ proc, streamUrl: url });
        }
      }
    });
    proc.stderr.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line) console.log(`  simstream: ${line}`);
      }
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`simstream sidecar exited code=${code}`));
      } else if (capture.sidecarProc === proc) {
        console.warn(`simstream sidecar exited unexpectedly (code=${code})`);
        capture.sidecarProc = null;
        capture.streamUrl = null;
      }
    });
  });
}

function controlSettingsFor(settings) {
  if (settings.mode !== 'simstream') return settings;
  // Keep sim-server alive for stdin touch/key commands, AX tree proxying, and MCP snapshots.
  return { ...settings, mode: 'mjpeg', fps: Math.min(3, settings.fps), quality: Math.min(settings.quality, 70) };
}

function spawnCapture(sim, settings) {
  capture.settings = settings;
  killCaptureProcesses();

  const ready = (async () => {
    const control = await spawnSimServer(sim, controlSettingsFor(settings), settings.mode === 'simstream' ? 'sim-server control' : 'sim-server');
    capture.proc = control.proc;
    capture.controlUrl = control.streamUrl;

    if (settings.mode === 'simstream') {
      const sidecar = await spawnSimstreamSidecar(sim, settings);
      capture.sidecarProc = sidecar.proc;
      capture.streamUrl = sidecar.streamUrl;
      capture.streamKind = 'simstream';
    } else {
      capture.streamUrl = control.streamUrl;
      capture.streamKind = 'mjpeg';
    }
    return capture.streamUrl;
  })();

  capture.pending = ready;
  return ready;
}

async function main() {
  console.log('🔍 Finding booted simulator...');
  const sim = await findBootedSimulator();
  console.log(`📱 Found: ${sim.name} (${sim.udid})`);

  await spawnCapture(sim, capture.settings);

  // HTTP server
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(makeConfig(sim)));
      return;
    }

    if (req.url === '/api/tree') {
      const upstreamTreeUrl = treeUrl();
      if (!upstreamTreeUrl) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('stream restarting');
        return;
      }
      http.get(upstreamTreeUrl, (upstream) => {
        res.writeHead(upstream.statusCode || 502, {
          'Content-Type': upstream.headers['content-type'] || 'application/json',
          'Cache-Control': 'no-store',
        });
        upstream.pipe(res);
      }).on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`tree proxy error: ${err.message}`);
      });
      return;
    }

    if (req.url.startsWith('/api/source?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const file = q.get('file') || '';
      const line = Math.max(0, parseInt(q.get('line') || '0', 10));
      const ctx = Math.max(0, Math.min(80, parseInt(q.get('context') || '14', 10)));
      if (!file || !path.isAbsolute(file)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'absolute file= required' }));
        return;
      }
      fs.readFile(file, 'utf8', (err, txt) => {
        if (err) {
          res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const allLines = txt.split('\n');
        const start = Math.max(0, line - ctx);
        const end = Math.min(allLines.length, line + ctx + 1);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          file,
          startLine0: start,
          endLine0: end,
          targetLine0: line,
          totalLines: allLines.length,
          lines: allLines.slice(start, end),
          language: langFromPath(file),
        }));
      });
      return;
    }

    serveStatic(req, res);
  });

  // WebSocket
  const wss = new WebSocketServer({ server });
  let bridgeWs = null;
  const uiClients = new Set();

  broadcastToUi = (payload) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const client of uiClients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  wss.on('connection', (ws, req) => {
    let isBridge = false;
    uiClients.add(ws);
    const ua = req.headers['user-agent'] || '?';
    const from = req.socket.remoteAddress;
    console.log(`🔌 WS client connected (ui=${uiClients.size}, bridge=${bridgeWs ? 'yes' : 'no'}) from=${from} ua="${ua.slice(0,80)}"`);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        console.error('WS message parse error:', e, 'raw=', String(data).slice(0, 120));
        return;
      }
      if (process.env.SP_TRACE) {
        console.log('WS msg', msg.type, JSON.stringify(msg).slice(0, 120));
      }

      switch (msg.type) {
        case 'bridge-ready': {
          isBridge = true;
          uiClients.delete(ws);
          if (bridgeWs && bridgeWs !== ws) {
            try { bridgeWs.close(); } catch {}
          }
          bridgeWs = ws;
          console.log('🧩 Inspector bridge registered');
          broadcastToUi({ type: 'bridgeStatus', status: 'connected' });
          break;
        }
        case 'inspectResult': {
          console.log(`🔎 inspectResult: ${msg.stack?.length || 0} frames, top=${msg.stack?.[0]?.componentName || '?'}`);
          symbolicateInspectResult(msg)
            .then((enriched) => broadcastToUi(enriched))
            .catch((err) => {
              console.warn('symbolicate failed:', err.message);
              broadcastToUi(msg);
            });
          break;
        }
        case 'touch': {
          if (!capture.proc) break;
          const { action, x, y } = msg;
          capture.proc.stdin.write(`touch ${action} ${x},${y}\n`);
          break;
        }
        case 'swipe': {
          if (!capture.proc) break;
          const { x1, y1, x2, y2, duration } = msg;
          const dur = typeof duration === 'number' ? ` ${duration}` : '';
          capture.proc.stdin.write(`swipe ${x1},${y1} ${x2},${y2}${dur}\n`);
          break;
        }
        case 'key': {
          if (!capture.proc) break;
          const { keyCode, direction } = msg;
          capture.proc.stdin.write(`key ${direction || 'Down'} ${keyCode}\n`);
          break;
        }
        case 'button': {
          if (!capture.proc) break;
          const { button, direction } = msg;
          capture.proc.stdin.write(`button ${direction || 'Down'} ${button}\n`);
          break;
        }
        case 'multitask': {
          if (!capture.proc) break;
          capture.proc.stdin.write(`multitask\n`);
          break;
        }
        case 'type': {
          if (!capture.proc) break;
          const text = typeof msg.text === 'string' ? msg.text : '';
          if (text) {
            const clean = text.replace(/[\r\n]/g, '');
            if (clean) capture.proc.stdin.write(`type ${clean}\n`);
          }
          break;
        }
        // --------------------------------------------------------------
        // Capture-quality controls. Browser sends { type: 'setCapture',
        // fps, quality, scale, mode } with any subset of those fields; we
        // merge with current settings, respawn sim-server, and broadcast
        // the new /api/config payload so every connected UI client
        // reconnects its MJPEG <img>.
        // --------------------------------------------------------------
        case 'setCapture': {
          const next = sanitizeSettings({ ...capture.settings, ...msg });
          (async () => {
            try {
              await spawnCapture(sim, next);
              broadcastToUi({
                type: 'configChanged',
                config: makeConfig(sim),
              });
            } catch (err) {
              console.error('setCapture failed:', err.message);
              try {
                ws.send(JSON.stringify({ type: 'configChanged', error: err.message }));
              } catch {}
            }
          })();
          break;
        }
        case 'inspect': {
          console.log(`🔍 Inspect request at (${msg.x}, ${msg.y})`);
          if (!bridgeWs || bridgeWs.readyState !== 1) {
            ws.send(JSON.stringify({
              type: 'inspectResult',
              error: 'No inspector bridge connected. Is the RN app running with agent-simulator?'
            }));
            break;
          }
          bridgeWs.send(JSON.stringify({
            type: 'inspect',
            x: msg.x,
            y: msg.y,
            requestStack: msg.requestStack !== false,
            reqId: msg.reqId
          }));
          break;
        }
      }
    });

    ws.on('close', () => {
      uiClients.delete(ws);
      if (isBridge && bridgeWs === ws) {
        bridgeWs = null;
        console.log('🧩 Inspector bridge disconnected');
        broadcastToUi({ type: 'bridgeStatus', status: 'disconnected' });
      } else {
        console.log(`🔌 UI client disconnected (ui=${uiClients.size})`);
      }
    });

    if (!isBridge) {
      ws.send(JSON.stringify({
        type: 'bridgeStatus',
        status: bridgeWs && bridgeWs.readyState === 1 ? 'connected' : 'disconnected',
      }));
    }
  });

  server.listen(PORT, () => {
    console.log(`\n✅ agent-simulator running at http://localhost:${PORT}`);
    console.log(`   Simulator: ${sim.name}`);
    console.log(`   Stream:    ${capture.streamUrl}\n`);
  });

  // Cleanup on exit
  const shutdown = () => {
    console.log('\nShutting down...');
    killCaptureProcesses();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
