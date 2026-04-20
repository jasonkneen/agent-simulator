import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { RefreshCw } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toolbar } from "@/components/layout/toolbar";
import { SidebarHeader } from "@/components/layout/sidebar-header";
import { SimulatorView } from "@/components/simulator-view";
import { LayerTree } from "@/components/inspector/layer-tree";
import { PropertyPanel } from "@/components/inspector/property-panel";
import { ConnectionHelp } from "@/components/inspector/connection-help";
import { Button } from "@/components/ui/button";
import { useSimConfig } from "@/hooks/use-sim-config";
import { useSimSocket, useSubscribe } from "@/hooks/use-sim-socket";
import { useAxTree } from "@/hooks/use-ax-tree";
import type {
  BridgeStatus,
  InspectResult,
  LayerNode,
  Rect,
} from "@/lib/types";
import {
  findNode,
  flatten,
  hitTest,
  mergeStackIntoTree,
  pathToNode,
} from "@/lib/fiber-tree";
import { rectCenter } from "@/lib/ax-tree";
import { cn } from "@/lib/utils";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

/** Which hierarchy the Layers panel is currently rendering. */
type TreeSource = "ax" | "react";

export default function App() {
  const { config } = useSimConfig();
  const { socket, open: wsOpen } = useSimSocket(WS_URL);

  // iOS accessibility tree, fetched from /api/tree on boot. Populated
  // immediately with every on-screen element's device-point frame — no
  // click-inspect required.
  const {
    tree: axTree,
    loading: axLoading,
    error: axError,
    refresh: refreshAxTree,
  } = useAxTree();

  const [inspectMode, setInspectMode] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("disconnected");
  const [pinned, setPinned] = useState(false);
  /** Which hierarchy is visible in the left panel. */
  const [treeSource, setTreeSource] = useState<TreeSource>("ax");

  const [tree, setTree] = useState<LayerNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** Controlled set of expanded node ids (bridges preview → layers panel). */
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [lastResult, setLastResult] = useState<InspectResult | null>(null);
  /**
   * Guard against stale inspect responses. While the pointer is hovering the
   * sim in inspect mode we fire a new request every ~90ms; if the bridge
   * answers slowly, older responses would overwrite newer ones without this.
   */
  const pendingInspectRef = useRef<number>(0);
  const lastReceivedInspectRef = useRef<number>(0);

  // Keep a stable reference to the socket for callbacks.
  const socketRef = useRef(socket);
  socketRef.current = socket;

  // Server pushes { type: 'bridgeStatus' } when the RN bridge connects or
  // leaves, and { type: 'inspectResult' } for each inspect request.
  useSubscribe(
    socket,
    useCallback((msg) => {
      if (msg.type === "bridgeStatus") {
        setBridgeStatus(msg.status === "connected" ? "connected" : "disconnected");
        return;
      }
      if (msg.type === "inspectResult") {
        setBridgeStatus("connected");
        // Drop stale responses so the hover overlay doesn't jitter backwards.
        const incomingId = typeof msg.reqId === "string" ? Number(msg.reqId) : NaN;
        if (!Number.isNaN(incomingId)) {
          if (incomingId < lastReceivedInspectRef.current) return;
          lastReceivedInspectRef.current = incomingId;
        }
        setLastResult(msg);
        setTree((prev) => mergeStackIntoTree(prev, msg));
        const leaf = msg.stack?.[0];
        if (leaf) {
          setSelectedId(idForLeaf(msg, 0));
        }
      }
    }, []),
  );

  // Simple bridge liveness: we infer disconnected if the WS is closed.
  useEffect(() => {
    if (!wsOpen) setBridgeStatus("disconnected");
    else if (bridgeStatus === "disconnected") setBridgeStatus("connecting");
  }, [wsOpen, bridgeStatus]);

  // Keyboard shortcuts (global, excluding inputs).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "i" || e.key === "I") {
        // Only toggle if inspect is actually available right now
        // (RN bridge connected). Otherwise silently swallow the key.
        if (bridgeStatus === "connected") {
          setInspectMode((v) => !v);
          setPinned(false);
        }
        e.preventDefault();
      } else if (e.key === "Escape") {
        if (pinned) setPinned(false);
        else setInspectMode(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pinned, bridgeStatus]);

  // Exiting inspect mode clears any pin.
  useEffect(() => {
    if (!inspectMode) setPinned(false);
  }, [inspectMode]);

  // Inspect only works when the RN bridge is connected. If the bridge
  // drops mid-session, or if we're driving a non-RN app (Settings, Maps
  // …), force Inspect off so clicks go through as taps instead of
  // getting swallowed by useless inspect requests.
  const inspectAvailable = bridgeStatus === "connected";
  useEffect(() => {
    if (!inspectAvailable && inspectMode) setInspectMode(false);
  }, [inspectAvailable, inspectMode]);

  // Auto-switch to the React tree the moment a component inspect returns.
  useEffect(() => {
    if (tree) setTreeSource("react");
  }, [tree]);

  // If the RN bridge drops (app closed, Metro crashed, no agent-simulator
  // plugin in the app’s Metro config), the React tree is stale and
  // useless — snap back to the iOS accessibility tree.
  useEffect(() => {
    if (bridgeStatus !== "connected" && treeSource === "react") {
      setTreeSource("ax");
    }
  }, [bridgeStatus, treeSource]);

  // The active tree depends on which source is selected. Selection /
  // hover state is shared — node ids don't collide between the two
  // sources thanks to the `ax|` / `0|` prefixes.
  const activeTree = treeSource === "react" ? tree : axTree;

  // Auto-expand every ancestor of the current selection so the selected
  // row is always visible in the Layers panel.
  useEffect(() => {
    if (!selectedId || !activeTree) return;
    const path = pathToNode(activeTree, selectedId);
    if (path.length === 0) return;
    setOpenIds((prev) => {
      const next = new Set(prev);
      // All ancestors (everything except the leaf itself) must be open.
      for (let i = 0; i < path.length - 1; i++) next.add(path[i]);
      return next;
    });
  }, [selectedId, activeTree]);

  const selectedNode = useMemo(
    () => findNode(activeTree, selectedId ?? "") ?? null,
    [activeTree, selectedId],
  );

  const hoverNode = useMemo(
    () => findNode(activeTree, hoverId ?? "") ?? null,
    [activeTree, hoverId],
  );

  const activeRect: Rect | null = useMemo(() => {
    const n = hoverNode ?? selectedNode;
    return n?.frame ?? null;
  }, [hoverNode, selectedNode]);

  const ancestorRects = useMemo(() => {
    if (!selectedNode || !activeTree) return [];
    const path: Rect[] = [];
    const walk = (n: LayerNode): boolean => {
      if (n.id === selectedNode.id) return true;
      for (const c of n.children) {
        if (walk(c)) {
          if (n.frame) path.push(n.frame);
          return true;
        }
      }
      return false;
    };
    walk(activeTree);
    return path;
  }, [activeTree, selectedNode]);

  const overlayRects = useMemo(() => {
    return flatten(activeTree)
      .map(({ node, level }) =>
        node.frame
          ? { id: node.id, rect: node.frame, name: node.componentName, level }
          : null,
      )
      .filter(Boolean) as { id: string; rect: Rect; name: string; level: number }[];
  }, [activeTree]);

  // Actions
  const sendTouch = useCallback((x: number, y: number) => {
    socketRef.current?.send({ type: "touch", action: "tap", x, y });
  }, []);

  const sendSwipe = useCallback(
    (x1: number, y1: number, x2: number, y2: number, durationMs?: number) => {
      socketRef.current?.send({
        type: "swipe",
        x1,
        y1,
        x2,
        y2,
        duration: durationMs ? durationMs / 1000 : undefined,
      });
    },
    [],
  );

  const sendType = useCallback((text: string) => {
    if (!text) return;
    socketRef.current?.send({ type: "type", text });
  }, []);

  const sendKey = useCallback((hid: number) => {
    socketRef.current?.send({ type: "key", keyCode: String(hid) });
  }, []);

  const sendInspect = useCallback((x: number, y: number) => {
    pendingInspectRef.current += 1;
    const reqId = String(pendingInspectRef.current);
    socketRef.current?.send({
      type: "inspect",
      x,
      y,
      requestStack: true,
      reqId,
    });
  }, []);

  /**
   * Hit-test the current AX tree at (x, y) and select the deepest match.
   * Runs whenever the user taps or clicks somewhere on the preview in
   * drive mode, so the Layers panel always mirrors what's under the user's
   * finger (even without entering Inspect).
   */
  const selectAtPoint = useCallback(
    (x: number, y: number) => {
      const hit = hitTest(axTree, x, y);
      if (!hit) return;
      setTreeSource("ax");
      setSelectedId(hit.id);
    },
    [axTree],
  );

  // Wrap sendTouch so driving the app also selects the element beneath the
  // tap. The selection will auto-scroll-into-view in the Layers panel.
  const driveTap = useCallback(
    (x: number, y: number) => {
      sendTouch(x, y);
      selectAtPoint(x, y);
      window.setTimeout(() => void refreshAxTree(), 350);
    },
    [sendTouch, selectAtPoint, refreshAxTree],
  );

  const driveSwipe = useCallback(
    (x1: number, y1: number, x2: number, y2: number, durationMs?: number) => {
      sendSwipe(x1, y1, x2, y2, durationMs);
      window.setTimeout(() => void refreshAxTree(), 400);
    },
    [sendSwipe, refreshAxTree],
  );

  /**
   * Tap the centre of a layer's rect. Used from the Properties panel
   * and implicitly lets any agent (human or LLM) drive the app from the
   * accessibility tree without touching the sim preview.
   */
  const tapLayerCenter = useCallback(
    (node: LayerNode) => {
      if (!node.frame) return;
      const c = rectCenter(node.frame);
      driveTap(c.x, c.y);
    },
    [driveTap],
  );

  const handleHome = useCallback(() => {
    socketRef.current?.send({ type: "button", button: "home" });
    window.setTimeout(() => void refreshAxTree(), 400);
  }, [refreshAxTree]);
  const handleMultitask = useCallback(() => {
    socketRef.current?.send({ type: "multitask" });
    window.setTimeout(() => void refreshAxTree(), 1200);
  }, [refreshAxTree]);
  const handleLock = useCallback(
    () => socketRef.current?.send({ type: "button", button: "lock" }),
    [],
  );
  const handleRotate = useCallback(
    () => socketRef.current?.send({ type: "key", keyCode: "rotate" }),
    [],
  );

  const handleOpenInEditor = useCallback((node: LayerNode) => {
    if (!node.source) return;
    const url = `vscode://file/${node.source.fileName}:${node.source.line0Based + 1}:${node.source.column0Based + 1}`;
    window.open(url, "_self");
  }, []);

  const toggleOpen = useCallback((id: string, open: boolean) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full flex-col bg-background text-foreground">
        <Toolbar
          deviceName={config?.simulator.name}
          wsOpen={wsOpen}
          bridge={bridgeStatus}
          inspectMode={inspectMode}
          onToggleInspect={setInspectMode}
          inspectAvailable={inspectAvailable}
          leftPanelOpen={leftPanelOpen}
          onToggleLeftPanel={setLeftPanelOpen}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={setRightPanelOpen}
          onHome={handleHome}
          onMultitask={handleMultitask}
          onLock={handleLock}
          onRotate={handleRotate}
        />

        <div className="flex min-h-0 flex-1">
          <PanelGroup direction="horizontal" className="flex-1">
            {/* Layers */}
            {leftPanelOpen && (
              <>
                <Panel
                  defaultSize={22}
                  minSize={16}
                  maxSize={38}
                  className="flex min-w-0 flex-col border-r border-border/70 bg-card/40"
                >
                  <SidebarHeader
                    title="Layers"
                    subtitle={
                      treeSource === "ax"
                        ? axTree
                          ? `${countNodes(axTree)} accessibility elements`
                          : axLoading
                            ? "Loading accessibility tree…"
                            : axError
                              ? "axe describe-ui unavailable"
                              : "Waiting for sim-server"
                        : tree
                          ? `${countNodes(tree)} react components`
                          : "Inspect a component to populate"
                    }
                    right={
                      <div className="flex items-center gap-1">
                        <div className="flex overflow-hidden rounded-md border border-border/70 bg-background/70 text-[10px]">
                          <button
                            type="button"
                            onClick={() => setTreeSource("ax")}
                            className={cn(
                              "px-2 py-1 uppercase tracking-wider transition",
                              treeSource === "ax"
                                ? "bg-primary/15 text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            iOS
                          </button>
                          <button
                            type="button"
                            onClick={() => setTreeSource("react")}
                            disabled={bridgeStatus !== "connected" || !tree}
                            title={
                              bridgeStatus !== "connected"
                                ? "No RN bridge connected — launch a React Native app with the agent-simulator Metro plugin"
                                : !tree
                                  ? "Inspect a component to populate the React tree"
                                  : "Show React component hierarchy"
                            }
                            className={cn(
                              "border-l border-border/70 px-2 py-1 uppercase tracking-wider transition",
                              treeSource === "react"
                                ? "bg-primary/15 text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                              (bridgeStatus !== "connected" || !tree) &&
                                "cursor-not-allowed opacity-40",
                            )}
                          >
                            React
                          </button>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6"
                          title="Re-read accessibility tree"
                          onClick={() => void refreshAxTree()}
                        >
                          <RefreshCw
                            className={cn("size-3", axLoading && "animate-spin")}
                          />
                        </Button>
                      </div>
                    }
                  />
                  <div className="min-h-0 flex-1">
                    <LayerTree
                      root={activeTree}
                      selectedId={selectedId}
                      onSelect={(n) => setSelectedId(n.id)}
                      onHover={(n) => setHoverId(n?.id ?? null)}
                      openIds={openIds}
                      onToggleOpen={toggleOpen}
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="group w-0.5 bg-transparent">
                  <div className="mx-auto h-full w-px bg-border/60 transition-colors group-hover:bg-primary/40" />
                </PanelResizeHandle>
              </>
            )}

            {/* Simulator */}
            <Panel minSize={30} className="flex min-w-0 flex-col">
              <div className="relative flex min-h-0 flex-1 flex-col">
                <SimulatorView
                  streamUrl={config?.streamUrl}
                  inspectMode={inspectMode}
                  pinned={pinned}
                  onPinnedChange={setPinned}
                  activeRect={activeRect}
                  ancestorRects={ancestorRects}
                  overlayRects={overlayRects}
                  selectedNode={selectedNode}
                  onTap={driveTap}
                  onInspect={sendInspect}
                  onSwipe={driveSwipe}
                  onType={sendType}
                  onKey={sendKey}
                />
                {/* Floating hint when bridge is missing */}
                <div className="pointer-events-none absolute left-0 right-0 top-0 flex justify-center p-3">
                  <div className="pointer-events-auto max-w-sm">
                    <ConnectionHelp
                      wsOpen={wsOpen}
                      bridgeConnected={bridgeStatus === "connected"}
                    />
                  </div>
                </div>
              </div>
            </Panel>

            {/* Properties */}
            {rightPanelOpen && (
              <>
                <PanelResizeHandle className="group w-0.5 bg-transparent">
                  <div className="mx-auto h-full w-px bg-border/60 transition-colors group-hover:bg-primary/40" />
                </PanelResizeHandle>
                <Panel
                  defaultSize={26}
                  minSize={18}
                  maxSize={42}
                  className="flex min-w-0 flex-col border-l border-border/70 bg-card/40"
                >
                  <SidebarHeader
                    title="Properties"
                    subtitle={
                      selectedNode
                        ? `Selected · ${selectedNode.componentName}`
                        : "No selection"
                    }
                  />
                  <div className="min-h-0 flex-1">
                    <PropertyPanel
                      node={selectedNode}
                      onOpenInEditor={handleOpenInEditor}
                      onTapCenter={tapLayerCenter}
                    />
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {/* Footer status line */}
        <footer
          className={cn(
            "h-6 shrink-0 border-t border-border/70 bg-background/80",
            "flex items-center gap-3 px-3 text-[10px] uppercase tracking-wider text-muted-foreground",
          )}
        >
          <span>
            {config?.simulator.udid
              ? `${config.simulator.udid.slice(0, 8)}…`
              : "—"}
          </span>
          <span>·</span>
          <span>{inspectMode ? (pinned ? "Inspect pinned" : "Inspect on") : "Inspect off"}</span>
          <span>·</span>
          <span>{lastResult?.stack?.length ?? 0} frames in last inspect</span>
          <span className="ml-auto">
            I · inspect &nbsp; Esc · {pinned ? "unpin" : "exit inspect"} &nbsp; wheel · scroll &nbsp; drag · swipe &nbsp; type · keyboard
          </span>
        </footer>
      </div>
    </TooltipProvider>
  );
}

function countNodes(n: LayerNode): number {
  let count = 1;
  for (const c of n.children) count += countNodes(c);
  return count;
}

function idForLeaf(r: InspectResult, depth: number) {
  const f = r.stack?.[depth];
  if (!f) return "";
  const src = f.source
    ? `${f.source.fileName}:${f.source.line0Based}:${f.source.column0Based}`
    : "nosrc";
  return `${depth}|${f.componentName}|${src}`;
}
