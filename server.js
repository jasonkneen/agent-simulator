#!/usr/bin/env node
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3200');
const SIM_SERVER = path.join(__dirname, 'sim-server', 'target', 'release', 'sim-server');

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

/**
 * If an inspectResult has bundle frames (React 19 / RN 0.81 bridge),
 * batch-call Metro's /symbolicate endpoint to translate them into real
 * source-file paths, then write those back onto each stack item's
 * `source` field. For each stack item we symbolicate up to 3 candidate
 * frames (the JSX runtime helper + parents) and pick the first one
 * that isn't inside a React / RN internal file.
 *
 * Metro's endpoint:
 *    POST http://localhost:8081/symbolicate
 *    { stack: [{file,lineNumber,column,methodName}, ...] }
 *    → { stack: [{file,lineNumber,column,methodName}, ...] }   (same order)
 */
async function symbolicateInspectResult(msg) {
  const stack = Array.isArray(msg.stack) ? msg.stack : [];
  const flat = [];
  /** Map { stackIdx, frameIdx } so we can put results back in place. */
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

  // Collect the symbolicated frames back into per-stack-item arrays.
  const perItem = stack.map(() => []);
  for (let j = 0; j < slots.length; j++) {
    const { stackIdx } = slots[j];
    const s = resolved[j];
    if (!s || !s.file || typeof s.file !== 'string' || !s.file.startsWith('/')) continue;
    perItem[stackIdx].push(s);
  }

  const newStack = stack.slice();
  for (let i = 0; i < newStack.length; i++) {
    if (newStack[i] && newStack[i].source) continue; // already had a source
    const candidates = perItem[i];
    if (!candidates || candidates.length === 0) continue;
    // Pick the first frame that isn't React's own JSX/reconciler plumbing.
    // RN component sources (node_modules/react-native/Libraries/…) are
    // valid — the user can read them.
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
  // Legacy single-file UI at /classic.
  if (req.url === '/classic' || req.url.startsWith('/classic/')) {
    const rel = req.url === '/classic' ? '/index.html' : req.url.slice('/classic'.length);
    return serveFile(res, path.join(LEGACY_DIR, rel));
  }

  const useApp = fs.existsSync(path.join(WEB_APP_DIR, 'index.html'));
  if (!useApp) {
    // Built app missing — fall back to legacy UI and suggest building.
    const rel = req.url === '/' ? '/index.html' : req.url;
    return serveFile(res, path.join(LEGACY_DIR, rel));
  }

  // Try to serve the requested file from the built app directory. Any URL
  // that doesn't resolve to a file falls through to index.html (SPA).
  const direct = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const candidate = path.join(WEB_APP_DIR, direct);
  fs.stat(candidate, (err, stat) => {
    if (!err && stat.isFile()) return serveFile(res, candidate);
    serveFile(res, path.join(WEB_APP_DIR, 'index.html'));
  });
}

async function main() {
  console.log('🔍 Finding booted simulator...');
  const sim = await findBootedSimulator();
  console.log(`📱 Found: ${sim.name} (${sim.udid})`);

  // Start sim-server. Defaults tuned for low CPU / bandwidth; override with
  // SP_FPS / SP_QUALITY env vars for heavier previews.
  const fps = String(parseInt(process.env.SP_FPS || '3', 10));
  const quality = String(parseInt(process.env.SP_QUALITY || '55', 10));
  console.log(`🚀 Starting sim-server (fps=${fps}, q=${quality})...`);
  const simServer = spawn(SIM_SERVER, [
    '--id', sim.udid,
    '--fps', fps,
    '--quality', quality,
    '--port', '0'
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let streamUrl = null;
  
  // Parse sim-server output for the stream URL
  const streamReady = new Promise((resolve) => {
    simServer.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line.startsWith('stream_ready')) {
        streamUrl = line.split(' ')[1];
        console.log(`📺 Stream ready: ${streamUrl}`);
        resolve(streamUrl);
      }
    });
  });
  
  simServer.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.includes('ERROR') || line.includes('WARN')) {
        console.log(`  sim-server: ${line}`);
      }
    }
  });

  simServer.on('close', (code) => {
    console.log(`sim-server exited with code ${code}`);
    process.exit(1);
  });

  // Wait for stream to be ready
  await Promise.race([
    streamReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('sim-server timeout')), 15000))
  ]);

  // Create HTTP server
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        streamUrl,
        snapshotUrl: streamUrl.replace('/stream.mjpeg', '/snapshot.jpg'),
        simulator: { udid: sim.udid, name: sim.name }
      }));
      return;
    }

    // Proxy /api/tree → sim-server so the browser can fetch the current
    // accessibility hierarchy (from `axe describe-ui`) without running into
    // cross-origin issues against the randomly-bound sim-server port.
    if (req.url === '/api/tree') {
      const treeUrl = streamUrl.replace('/stream.mjpeg', '/api/tree');
      http.get(treeUrl, (upstream) => {
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

    // /api/source?file=ABS&line=N&context=M
    // Read a window of lines around `line` from `file` and return it as
    // JSON so the Properties panel can show the actual source for the
    // selected React component. We only accept absolute paths that already
    // exist — no directory escape tricks, no reads outside the FS.
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

  // WebSocket server for touch/inspect communication
  //
  // Two kinds of clients connect to this WS:
  //   - UI clients (browser) — they send touch/button/inspect, receive inspectResult
  //   - Bridge client (the RN inspector-bridge running inside the app) — it
  //     announces itself with {type:'bridge-ready'} and then sends back
  //     {type:'inspectResult', frame, stack} in response to inspect requests.
  //
  // The bridge identifies itself via its first message; everything else is a UI client.
  const wss = new WebSocketServer({ server });
  let bridgeWs = null;
  const uiClients = new Set();

  function broadcastToUi(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const client of uiClients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  wss.on('connection', (ws, req) => {
    // Until we see a bridge-ready message we assume this is a UI client.
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
          // From the RN bridge — symbolicate any bundle frames into real
          // source paths, then forward to all UI clients.
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
          const { action, x, y } = msg;
          simServer.stdin.write(`touch ${action} ${x},${y}\n`);
          break;
        }
        case 'swipe': {
          const { x1, y1, x2, y2, duration } = msg;
          const dur = typeof duration === 'number' ? ` ${duration}` : '';
          simServer.stdin.write(`swipe ${x1},${y1} ${x2},${y2}${dur}\n`);
          break;
        }
        case 'key': {
          const { keyCode, direction } = msg;
          simServer.stdin.write(`key ${direction || 'Down'} ${keyCode}\n`);
          break;
        }
        case 'button': {
          const { button, direction } = msg;
          simServer.stdin.write(`button ${direction || 'Down'} ${button}\n`);
          break;
        }
        case 'multitask': {
          simServer.stdin.write(`multitask\n`);
          break;
        }
        case 'type': {
          const text = typeof msg.text === 'string' ? msg.text : '';
          if (text) {
            // Strip newlines — they are sent as separate `key 40` (Return)
            // messages on the client side.
            const clean = text.replace(/[\r\n]/g, '');
            if (clean) simServer.stdin.write(`type ${clean}\n`);
          }
          break;
        }
        case 'inspect': {
          // From a UI client — forward to the RN bridge
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

    // When a UI client joins, tell it the current bridge status.
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
    console.log(`   Stream: ${streamUrl}\n`);
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    simServer.kill();
    server.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    simServer.kill();
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
