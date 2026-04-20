import { useEffect, useRef, useState, useCallback } from "react";
import { Pin, Keyboard } from "lucide-react";
import type { LayerNode, Rect } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SimulatorViewProps = {
  streamUrl: string | undefined;
  inspectMode: boolean;
  /** When true we stop chasing hover inspects and keep the current selection locked. */
  pinned: boolean;
  onPinnedChange: (v: boolean) => void;
  /** The element currently "hovered" for inspection (from the latest result). */
  activeRect: Rect | null;
  /** All ancestor rects in the selection chain (drawn dimly). */
  ancestorRects: Rect[];
  /** All sibling/peer rects in the layer tree (for the figma-like overlay). */
  overlayRects: { id: string; rect: Rect; name: string; level: number }[];
  /** The node the user has currently selected in the layer tree. */
  selectedNode: LayerNode | null;
  onTap: (x: number, y: number) => void;
  onInspect: (x: number, y: number) => void;
  onSwipe: (x1: number, y1: number, x2: number, y2: number, durationMs?: number) => void;
  onType: (text: string) => void;
  onKey: (hidKeycode: number) => void;
};

/** Throttle interval for continuous hover-inspect requests. */
const HOVER_THROTTLE_MS = 90;
/** Drag threshold beyond which we treat a mouse-drag as a swipe. */
const DRAG_SWIPE_THRESHOLD_RATIO = 0.02;
/** Wheel accumulation window \u2014 we flush one axe swipe per debounce. */
const WHEEL_DEBOUNCE_MS = 80;
/** Max ratio a single wheel swipe will cover, even on big trackpad flicks. */
const WHEEL_MAX_RATIO = 0.7;
/** Divisor to convert pixel wheel deltas to sim-ratio distance. */
const WHEEL_PIXEL_DIVISOR = 800;

/**
 * The main simulator canvas. Two modes:
 *
 *  - Drive (inspectMode=false): clicks are taps, drags are swipes, wheel
 *    events are swipes, keyboard passes through as text or HID keys.
 *  - Inspect: hover streams throttled inspect requests so the overlay
 *    follows the cursor; clicking pins the current selection. Esc unpins.
 */
export function SimulatorView({
  streamUrl,
  inspectMode,
  pinned,
  onPinnedChange,
  activeRect,
  ancestorRects,
  overlayRects,
  selectedNode,
  onTap,
  onInspect,
  onSwipe,
  onType,
  onKey,
}: SimulatorViewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const lastHoverInspectRef = useRef<number>(0);

  /** Visual ring for the most recent tap/click. */
  const [tapPing, setTapPing] = useState<{ x: number; y: number; id: number } | null>(
    null,
  );
  /** Current drag-in-progress (drive mode). */
  const dragRef = useRef<{ startX: number; startY: number; startT: number; moved: boolean } | null>(null);
  const [dragLine, setDragLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );

  /** Wheel deltas accumulated for the current burst. */
  const wheelAccRef = useRef<{
    dx: number;
    dy: number;
    anchorX: number;
    anchorY: number;
    timer: number | null;
  }>({ dx: 0, dy: 0, anchorX: 0.5, anchorY: 0.5, timer: null });

  /** Whether the user has clicked into the sim to capture keyboard input. */
  const [kbFocused, setKbFocused] = useState(false);

  // Recompute rendered image size on resize so overlay matches.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const update = () => {
      const r = img.getBoundingClientRect();
      setImgSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(img);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [streamUrl]);

  // Leaving inspect mode or unpinning? Reset the hover throttle so the next
  // entry fires immediately.
  useEffect(() => {
    lastHoverInspectRef.current = 0;
  }, [inspectMode, pinned]);

  const toRatio = useCallback((ev: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, []);

  /** Fire a one-shot "I clicked here" ring on top of the sim. */
  const pingAt = useCallback((x: number, y: number) => {
    const id = performance.now();
    setTapPing({ x, y, id });
    window.setTimeout(() => {
      setTapPing((prev) => (prev && prev.id === id ? null : prev));
    }, 450);
  }, []);

  /* --- wheel / scroll --------------------------------------------------- */

  const flushWheel = useCallback(() => {
    const a = wheelAccRef.current;
    if (a.timer !== null) {
      window.clearTimeout(a.timer);
      a.timer = null;
    }
    const { dx, dy, anchorX, anchorY } = a;
    a.dx = 0;
    a.dy = 0;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    // Invert \u2014 a wheel scroll DOWN means the user wants the content to
    // move UP, which iOS models as a swipe-up gesture.
    const rx = clamp(-dx / WHEEL_PIXEL_DIVISOR, -WHEEL_MAX_RATIO, WHEEL_MAX_RATIO);
    const ry = clamp(-dy / WHEEL_PIXEL_DIVISOR, -WHEEL_MAX_RATIO, WHEEL_MAX_RATIO);
    const x1 = clamp(anchorX, 0, 1);
    const y1 = clamp(anchorY, 0, 1);
    const x2 = clamp(anchorX + rx, 0, 1);
    const y2 = clamp(anchorY + ry, 0, 1);
    onSwipe(x1, y1, x2, y2, 180);
  }, [onSwipe]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLElement>) => {
      if (inspectMode) return;
      e.preventDefault();
      const r = toRatio(e);
      const a = wheelAccRef.current;
      if (r) {
        a.anchorX = r.x;
        a.anchorY = r.y;
      }
      a.dx += e.deltaX;
      a.dy += e.deltaY;
      if (a.timer !== null) window.clearTimeout(a.timer);
      a.timer = window.setTimeout(flushWheel, WHEEL_DEBOUNCE_MS);
    },
    [flushWheel, inspectMode, toRatio],
  );

  /* --- keyboard passthrough -------------------------------------------- */

  useEffect(() => {
    if (!kbFocused || inspectMode) return;
    const handler = (e: KeyboardEvent) => {
      // Ignore when focus is on an input (e.g. toolbar text fields).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      // Let browser shortcuts through.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const hid = HID_FOR_KEY[e.key];
      if (hid !== undefined) {
        e.preventDefault();
        onKey(hid);
        return;
      }
      if (e.key.length === 1) {
        // Printable ASCII \u2014 axe handles uppercase, numbers, punctuation.
        e.preventDefault();
        onType(e.key);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [kbFocused, inspectMode, onKey, onType]);

  /* --- mouse down/move/up drag detection (drive mode) ------------------ */

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (inspectMode) return;
      const r = toRatio(e);
      if (!r) return;
      dragRef.current = {
        startX: r.x,
        startY: r.y,
        startT: performance.now(),
        moved: false,
      };
    },
    [inspectMode, toRatio],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const r = toRatio(e);
      setHover(r);
      if (!r) return;
      if (inspectMode) {
        if (pinned) return;
        const now = performance.now();
        if (now - lastHoverInspectRef.current >= HOVER_THROTTLE_MS) {
          lastHoverInspectRef.current = now;
          onInspect(r.x, r.y);
        }
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const dx = r.x - drag.startX;
      const dy = r.y - drag.startY;
      if (Math.hypot(dx, dy) >= DRAG_SWIPE_THRESHOLD_RATIO) {
        drag.moved = true;
        setDragLine({ x1: drag.startX, y1: drag.startY, x2: r.x, y2: r.y });
      }
    },
    [inspectMode, onInspect, pinned, toRatio],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (inspectMode) return;
      const drag = dragRef.current;
      dragRef.current = null;
      setDragLine(null);
      if (!drag) return;
      const r = toRatio(e);
      if (!r) return;
      if (drag.moved) {
        const dur = performance.now() - drag.startT;
        pingAt(r.x, r.y);
        onSwipe(drag.startX, drag.startY, r.x, r.y, Math.max(80, Math.min(600, dur)));
      } else {
        pingAt(r.x, r.y);
        onTap(r.x, r.y);
      }
    },
    [inspectMode, onSwipe, onTap, pingAt, toRatio],
  );

  const handleClickInspect = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!inspectMode) return;
      const r = toRatio(e);
      if (!r) return;
      onInspect(r.x, r.y);
      onPinnedChange(true);
      pingAt(r.x, r.y);
    },
    [inspectMode, onInspect, onPinnedChange, pingAt, toRatio],
  );

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden bg-background bg-grid-faint p-6 outline-none"
      tabIndex={0}
      onFocus={() => setKbFocused(true)}
      onBlur={() => setKbFocused(false)}
      onMouseDown={() => {
        // Clicking the backdrop (not the img) should still focus so shortcuts work.
        wrapperRef.current?.focus();
      }}
    >
      <div className="relative max-h-full">
        {streamUrl ? (
          <img
            ref={imgRef}
            src={streamUrl}
            alt="Simulator"
            draggable={false}
            onLoad={() => {
              const img = imgRef.current;
              if (!img) return;
              const r = img.getBoundingClientRect();
              setImgSize({ w: r.width, h: r.height });
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              setHover(null);
              dragRef.current = null;
              setDragLine(null);
            }}
            onClick={handleClickInspect}
            onWheel={handleWheel}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              "block max-h-[calc(100vh-5rem)] select-none rounded-[2.25rem] shadow-2xl ring-1 ring-border/60",
              inspectMode ? "cursor-crosshair" : "cursor-none",
            )}
          />
        ) : (
          <div className="grid h-[80vh] w-[400px] place-items-center rounded-3xl border border-dashed border-border/60 bg-muted/30 text-sm text-muted-foreground">
            Waiting for simulator stream…
          </div>
        )}

        {/* Overlays \u2014 only visible in inspect mode */}
        {imgSize && inspectMode && streamUrl && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{ width: imgSize.w, height: imgSize.h }}
          >
            {/* Ancestor chain \u2014 dim */}
            {ancestorRects.map((r, i) => (
              <RectBox
                key={`anc-${i}`}
                rect={r}
                imgSize={imgSize}
                className="border border-primary/25"
              />
            ))}

            {/* Peer siblings from the layer tree \u2014 extremely faint */}
            {overlayRects.map((o) => (
              <RectBox
                key={o.id}
                rect={o.rect}
                imgSize={imgSize}
                className={cn(
                  "border border-dashed border-primary/20",
                  o.level === 0 && "border-primary/40",
                )}
              />
            ))}

            {/* Active hover/selected \u2014 strong */}
            {activeRect && (
              <>
                <RectBox
                  rect={activeRect}
                  imgSize={imgSize}
                  className={cn(
                    "bg-primary/10 border-2",
                    pinned
                      ? "border-primary ring-2 ring-primary/30"
                      : "border-primary/80",
                  )}
                />
                <RectLabel
                  rect={activeRect}
                  imgSize={imgSize}
                  label={selectedNode?.componentName ?? "Element"}
                  pinned={pinned}
                />
              </>
            )}
          </div>
        )}

        {/* Drive-mode cursor (round dot that follows the pointer) */}
        {!inspectMode && hover && imgSize && (
          <div
            className="pointer-events-none absolute"
            style={{
              left: hover.x * imgSize.w,
              top: hover.y * imgSize.h,
              transform: "translate(-50%, -50%)",
            }}
          >
            <div className="size-4 rounded-full bg-primary/80 ring-2 ring-primary/30 shadow" />
          </div>
        )}

        {/* Drag indicator line (drive mode) */}
        {!inspectMode && dragLine && imgSize && (
          <svg
            className="pointer-events-none absolute inset-0"
            width={imgSize.w}
            height={imgSize.h}
            viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
          >
            <line
              x1={dragLine.x1 * imgSize.w}
              y1={dragLine.y1 * imgSize.h}
              x2={dragLine.x2 * imgSize.w}
              y2={dragLine.y2 * imgSize.h}
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              className="text-primary/70"
            />
            <circle
              cx={dragLine.x2 * imgSize.w}
              cy={dragLine.y2 * imgSize.h}
              r={6}
              className="fill-primary"
            />
          </svg>
        )}

        {/* Tap ping ring \u2014 fires on every tap, swipe-end and inspect click */}
        {tapPing && imgSize && (
          <div
            key={tapPing.id}
            className="pointer-events-none absolute"
            style={{
              left: tapPing.x * imgSize.w,
              top: tapPing.y * imgSize.h,
              transform: "translate(-50%, -50%)",
            }}
          >
            <div className="size-8 animate-tap-ping rounded-full border-2 border-primary/70" />
          </div>
        )}

        {/* Crosshair while in inspect mode */}
        {inspectMode && hover && imgSize && (
          <div
            className="pointer-events-none absolute inset-0 text-primary/70"
            style={{ width: imgSize.w, height: imgSize.h }}
          >
            <div
              className="absolute left-0 right-0 border-t border-dashed border-current"
              style={{ top: hover.y * imgSize.h }}
            />
            <div
              className="absolute top-0 bottom-0 border-l border-dashed border-current"
              style={{ left: hover.x * imgSize.w }}
            />
          </div>
        )}

        {/* Mode chip — pinned below the sim so it doesn't obscure the
            device status bar / Dynamic Island. `top: calc(100% + 6px)`
            anchors it to the sim image but renders it in the safe area
            underneath. */}
        {imgSize && (inspectMode || kbFocused) && (
          <div
            className="pointer-events-none absolute left-1/2 -translate-x-1/2"
            style={{ top: "calc(100% + 8px)" }}
          >
            {inspectMode ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shadow-md backdrop-blur",
                  pinned
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border/70 bg-background/70 text-muted-foreground",
                )}
              >
                {pinned ? (
                  <>
                    <Pin className="size-3" />
                    Inspect pinned · Esc to unpin
                  </>
                ) : (
                  <>Inspect · hover to preview, click to pin</>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 shadow-md backdrop-blur">
                <Keyboard className="size-3" />
                Keyboard · click outside to release
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RectBox({
  rect,
  imgSize,
  className,
}: {
  rect: Rect;
  imgSize: { w: number; h: number };
  className?: string;
}) {
  return (
    <div
      className={cn("absolute rounded-sm", className)}
      style={{
        left: rect.x * imgSize.w,
        top: rect.y * imgSize.h,
        width: rect.width * imgSize.w,
        height: rect.height * imgSize.h,
      }}
    />
  );
}

function RectLabel({
  rect,
  imgSize,
  label,
  pinned,
}: {
  rect: Rect;
  imgSize: { w: number; h: number };
  label: string;
  pinned: boolean;
}) {
  const left = rect.x * imgSize.w;
  const top = rect.y * imgSize.h;
  const anchorTop = top > 22 ? top - 20 : top + rect.height * imgSize.h + 4;
  return (
    <div
      className={cn(
        "absolute whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shadow",
        pinned
          ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
          : "bg-primary/90 text-primary-foreground",
      )}
      style={{ left, top: anchorTop }}
    >
      {pinned && <span className="mr-1">●</span>}
      {label}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Minimal HID keycode map for non-printable keys. axe `key <code>` accepts
 * USB-HID-style codes in the 0-255 range. These are the ones users
 * actually hit while driving a phone from a laptop.
 */
const HID_FOR_KEY: Record<string, number> = {
  Enter: 40,
  Return: 40,
  Tab: 43,
  Backspace: 42,
  Delete: 76,
  Escape: 41,
  " ": 44,
  ArrowLeft: 80,
  ArrowRight: 79,
  ArrowUp: 82,
  ArrowDown: 81,
  Home: 74,
  End: 77,
  PageUp: 75,
  PageDown: 78,
};
