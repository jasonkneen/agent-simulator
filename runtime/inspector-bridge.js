/**
 * agent-simulator — Inspector Bridge
 *
 * This module gets injected into the React Native app at runtime. It
 * communicates with the agent-simulator server via WebSocket and provides
 * element inspection using React Native's built-in inspector APIs.
 *
 * Usage: add to your RN app's entry point:
 *
 *   import 'agent-simulator/runtime/inspector-bridge';
 *
 * or configure automatically via the Metro plugin (see metro-plugin.js).
 */

const { AppRegistry, View, findNodeHandle, Dimensions, Platform } = require('react-native');
const React = require('react');

// Inspector bridge state
let ws = null;
let mainContainerRef = null;
let inspectorActive = false;
let reconnectTimer = null;

// Each module may be CommonJS (function) or ESM ({default: function}); unwrap.
function unwrapCallable(mod) {
  if (!mod) return null;
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  return null;
}

// Get RN's private getInspectorDataForViewAtPoint helper.
// Metro's static analysis requires string-literal require() calls, so we try
// every known path location with a separate hardcoded require.
function getRNInternals() {
  let mod = null;
  // RN 0.79+ (current path)
  try { mod = require('react-native/src/private/devsupport/devmenu/elementinspector/getInspectorDataForViewAtPoint'); } catch (e) {}
  if (!unwrapCallable(mod)) {
    try { mod = require('react-native/src/private/inspector/getInspectorDataForViewAtPoint'); } catch (e) {}
  }
  if (!unwrapCallable(mod)) {
    try { mod = require('react-native/Libraries/Inspector/getInspectorDataForViewAtPoint'); } catch (e) {}
  }
  return unwrapCallable(mod);
}

function getRendererConfig() {
  const renderers = Array.from(
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.values() || []
  );
  for (const renderer of renderers) {
    if (renderer.rendererConfig?.getInspectorDataForInstance) {
      return renderer.rendererConfig;
    }
  }
  return null;
}

function connectWebSocket() {
  // Connect to the agent-simulator server.
  const host = Platform.OS === 'ios' ? 'localhost' : '10.0.2.2';
  const port = 3200; // default agent-simulator port
  
  try {
    ws = new WebSocket(`ws://${host}:${port}`);
    
    ws.onopen = () => {
      console.log('[SimPreview] Inspector bridge connected');
      ws.send(JSON.stringify({ type: 'bridge-ready' }));
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {}
    };
    
    ws.onclose = () => {
      console.log('[SimPreview] Inspector bridge disconnected');
      reconnectTimer = setTimeout(connectWebSocket, 3000);
    };
    
    ws.onerror = (e) => {
      // Silently retry
    };
  } catch (e) {
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'inspect':
      console.log('[SimPreview] inspect received', msg.x, msg.y, 'reqId=', msg.reqId);
      inspectElementAt(msg.x, msg.y, msg.requestStack !== false, msg.reqId);
      break;
    default:
      console.log('[SimPreview] unknown message type', msg.type);
  }
}

function inspectElementAt(xRatio, yRatio, requestStack, reqId) {
  if (!mainContainerRef) {
    console.warn('[SimPreview] mainContainerRef is null (root wrapper never mounted)');
    sendInspectResult({ reqId, error: 'no root wrapper' });
    return;
  }
  if (!mainContainerRef.current) {
    console.warn('[SimPreview] mainContainerRef.current is null');
    sendInspectResult({ reqId, error: 'no root ref' });
    return;
  }

  const getInspectorDataForViewAtPoint = getRNInternals();
  if (!getInspectorDataForViewAtPoint) {
    console.warn('[SimPreview] getInspectorDataForViewAtPoint not available');
    sendInspectResult({ reqId, error: 'getInspectorDataForViewAtPoint unavailable' });
    return;
  }

  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
  const x = xRatio * screenWidth;
  const y = yRatio * screenHeight;
  console.log('[SimPreview] calling getInspectorDataForViewAtPoint at ratio', xRatio, yRatio, '-> px', x, y, 'window', screenWidth, screenHeight);

  // RN only invokes the callback when viewData.hierarchy.length > 0, so schedule
  // a timeout to respond when nothing was hit.
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.warn('[SimPreview] inspect timeout for reqId', reqId, '(no element at point?)');
      sendInspectResult({ reqId, error: 'no element at point' });
    }
  }, 400);

  try {
    getInspectorDataForViewAtPoint(
    mainContainerRef.current,
    x,
    y,
    (viewData) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);
      console.log('[SimPreview] viewData received, has frame=', !!viewData?.frame, 'hierarchy=', viewData?.hierarchy?.length);
      if (!viewData) {
        sendInspectResult({ reqId, error: 'no view at point' });
        return;
      }
      const frame = viewData.frame;
      if (!frame) {
        sendInspectResult({ reqId, error: 'no frame in viewData' });
        return;
      }
      const scaledFrame = {
        x: frame.left / screenWidth,
        y: frame.top / screenHeight,
        width: frame.width / screenWidth,
        height: frame.height / screenHeight,
      };

      if (!requestStack) {
        sendInspectResult({ reqId, frame: scaledFrame });
        return;
      }

      // Extract component stack from fiber tree
      const stack = extractComponentStack(viewData);
      
      // Measure each component's bounds. Every resolve() MUST carry the
      // bundleFrame / source hints — otherwise server.js has nothing to
      // symbolicate and the Code panel in the UI shows (no source).
      Promise.all(
        stack.map(item => new Promise((resolve) => {
          const base = {
            componentName: item.name,
            source: item.source,
            bundleFrames: item.bundleFrames,
          };
          try {
            if (item.measure) {
              item.measure((_x, _y, w, h, pageX, pageY) => {
                resolve({
                  ...base,
                  frame: {
                    x: pageX / screenWidth,
                    y: pageY / screenHeight,
                    width: w / screenWidth,
                    height: h / screenHeight,
                  },
                });
              });
            } else {
              resolve(base);
            }
          } catch (e) {
            resolve(base);
          }
        }))
      ).then(componentStack => {
        sendInspectResult({
          reqId,
          frame: scaledFrame,
          stack: componentStack,
        });
      });
    }
  );
  } catch (err) {
    responded = true;
    clearTimeout(timeout);
    console.warn('[SimPreview] getInspectorDataForViewAtPoint threw:', err && err.message);
    sendInspectResult({ reqId, error: String((err && err.message) || err) });
  }
}

function extractComponentStack(viewData) {
  const rendererConfig = getRendererConfig();
  const stack = [];
  const hasFiber = !!(rendererConfig && viewData.closestInstance);
  console.log('[SimPreview] extractComponentStack', {
    hasRendererConfig: !!rendererConfig,
    hasClosestInstance: !!viewData.closestInstance,
    hierarchyLen: viewData.hierarchy?.length,
    firstHierKeys: viewData.hierarchy?.[0] ? Object.keys(viewData.hierarchy[0]) : null,
  });

  if (hasFiber) {
    // Walk the fiber tree via .return
    let node = viewData.closestInstance;
    const OFFSCREEN_TAG = 22;

    while (node && node.tag !== OFFSCREEN_TAG) {
      try {
        const data = rendererConfig.getInspectorDataForInstance(node);
        const item = data.hierarchy[data.hierarchy.length - 1];
        let inspectorData = {};
        try {
          inspectorData = (typeof item.getInspectorData === 'function')
            ? item.getInspectorData(findNodeHandle)
            : {};
        } catch (e) {}

        // On the FIRST fiber of each inspect (the leaf), dump the keys so
        // we can see which React version we're actually talking to. This
        // log surfaces in the Metro terminal.

        const hint = extractSourceHint(inspectorData, node);
        stack.push({
          name: item.name || 'Unknown',
          source: hint.source,
          bundleFrames: hint.bundleFrames,
          measure: inspectorData.measure,
        });
        node = node.return;
      } catch (e) {
        console.warn('[SimPreview] fiber walk error:', e && e.message);
        break;
      }
    }
  } else if (viewData.hierarchy) {
    // Fallback to hierarchy from getInspectorDataForViewAtPoint (innermost last → reverse for outer-last render)
    const hier = [...viewData.hierarchy].reverse();
    hier.forEach(item => {
      let inspectorData = {};
      try {
        if (typeof item.getInspectorData === 'function') {
          inspectorData = item.getInspectorData(findNodeHandle);
        }
      } catch (e) {}

      const hint = extractSourceHint(inspectorData, null);
      stack.push({
        name: item.name || 'Unknown',
        source: hint.source,
        bundleFrames: hint.bundleFrames,
        measure: inspectorData.measure,
      });
    });
  }

  console.log('[SimPreview] extractComponentStack →', stack.length, 'frames. names =',
    stack.map(s => s.name).join(' > '));
  return stack;
}

/**
 * Parse a single line of a JS stack trace. Handles both V8 (
 *   "    at Name (url:line:col)" / "    at url:line:col"
 * ) and JSC/Hermes (
 *   "Name@url:line:col"
 * ) formats. Returns null if the line isn't a recognisable frame.
 */
function parseStackLine(line) {
  let m = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/);
  if (m) return { methodName: m[1], file: m[2], lineNumber: +m[3], column: +m[4] };
  m = line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
  if (m) return { methodName: '<anonymous>', file: m[1], lineNumber: +m[2], column: +m[3] };
  m = line.match(/^(.+?)@(.+):(\d+):(\d+)\s*$/);
  if (m) return { methodName: m[1], file: m[2], lineNumber: +m[3], column: +m[4] };
  return null;
}

/** React internals that never point at user code. Post-symbolication
 * we drop any frame whose file matches these patterns. */
const REACT_INTERNAL_PATHS = /\/node_modules\/(react|react-native|scheduler|react-dom|react-reconciler)\//;

/** React reconciler method names that appear in _debugStack below the
 * JSX call site. Pre-symbolication we can't know the file, so filtering
 * by methodName is the cheapest first pass. */
const REACT_INTERNAL_METHODS = new Set([
  'react-stack-bottom-frame',
  'renderWithHooks',
  'updateFunctionComponent',
  'beginWork',
  'runWithFiberInDEV',
  'performWorkOnFiber',
  'performUnitOfWork',
]);

/**
 * Walk `error.stack` and return every frame that isn't an obvious
 * reconciler internal. We forward ALL of them to the server — even
 * RN-internal JSX sites (like ScrollView.js or View.js) — because
 * `node_modules/react-native/...` is real source the user can read, and
 * showing it when the selected element is a pure host wrapper is more
 * useful than showing nothing.
 *
 * The server then filters out only the truly unhelpful frames (React's
 * own `jsxDEV` / `createElement` plumbing in `react/cjs/`), picking the
 * first remaining frame as `source`.
 */
function collectCandidateFrames(debugStack) {
  if (!debugStack) return null;
  const raw = typeof debugStack === 'string' ? debugStack : debugStack.stack;
  if (typeof raw !== 'string') return null;
  const out = [];
  for (const line of raw.split('\n')) {
    const f = parseStackLine(line);
    if (!f) continue;
    if (REACT_INTERNAL_METHODS.has(f.methodName)) continue;
    out.push(f);
    if (out.length >= 12) break;
  }
  return out.length ? out : null;
}

/**
 * Pull a source hint out of whatever RN + React gave us. Returns one of:
 *
 *   - `{source: {fileName, line0Based, column0Based}}` when we already
 *     have an absolute source path (RN paper renderer or React < 19 with
 *     `_debugSource`). No symbolication needed.
 *   - `{bundleFrame: {file, lineNumber, column, methodName}}` when all
 *     we can see is a bundle-relative position inside `_debugStack`.
 *     server.js will batch-symbolicate these via Metro's `/symbolicate`
 *     endpoint so the UI gets a real file path + line + column.
 *   - `{}` when the fiber has nothing (host components in prod, etc).
 */
function extractSourceHint(inspectorData, fiber) {
  const pick = (s) => {
    if (!s) return null;
    const fileName = s.fileName || s.file || null;
    if (!fileName || typeof fileName !== 'string' || !fileName.startsWith('/')) {
      return null;
    }
    const line = (s.lineNumber ?? s.line) || 1;
    const column = (s.columnNumber ?? s.column) || 1;
    return {
      fileName,
      line0Based: Math.max(0, line - 1),
      column0Based: Math.max(0, column - 1),
    };
  };

  const direct =
    pick(inspectorData && inspectorData.source) ||
    pick(fiber && fiber._debugSource) ||
    pick(fiber && fiber._debugOwner && fiber._debugOwner._debugSource) ||
    pick(fiber && fiber.memoizedProps && fiber.memoizedProps.__source) ||
    pick(fiber && fiber.pendingProps && fiber.pendingProps.__source);
  if (direct) return { source: direct };

  const bundleFrames =
    collectCandidateFrames(fiber && fiber._debugStack) ||
    collectCandidateFrames(fiber && fiber._debugOwner && fiber._debugOwner._debugStack);
  if (bundleFrames && bundleFrames.length) return { bundleFrames };

  return {};
}

function sendInspectResult(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'inspectResult',
      ...data,
    }));
  }
}

// Wrap the app root to get a ref for inspector
const originalRegisterComponent = AppRegistry.registerComponent;
AppRegistry.registerComponent = function(appKey, componentProvider) {
  const OriginalComponent = componentProvider();
  
  function WrappedComponent(props) {
    const ref = React.useRef(null);
    
    React.useEffect(() => {
      mainContainerRef = ref;
      connectWebSocket();
      
      return () => {
        if (ws) ws.close();
        if (reconnectTimer) clearTimeout(reconnectTimer);
      };
    }, []);

    return React.createElement(
      View,
      { ref, style: { flex: 1 } },
      React.createElement(OriginalComponent, props)
    );
  }

  return originalRegisterComponent.call(this, appKey, () => WrappedComponent);
};

console.log('[SimPreview] Inspector bridge loaded (v6 — wide candidate search)');
// Probe internals at load time so we know whether the private API is reachable.
try {
  const probe = getRNInternals();
  console.log('[SimPreview] getInspectorDataForViewAtPoint available:', !!probe);
} catch (e) {
  console.warn('[SimPreview] probe failed:', e && e.message);
}
