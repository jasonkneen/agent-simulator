/** A rectangle in [0,1] sim-ratio coordinates. */
export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** A source location (file + zero-based line/column). */
export type SourceLocation = {
  fileName: string;
  line0Based: number;
  column0Based: number;
};

/** One frame of the component stack for an inspected element. */
export type StackFrame = {
  componentName: string;
  source?: SourceLocation;
  /** Bounds of the component's rendered view. */
  frame?: Rect;
};

export type InspectResult = {
  type: "inspectResult";
  reqId?: string;
  frame?: Rect;
  stack?: StackFrame[];
  error?: string;
};

/**
 * Capture pipeline settings. The UI can change them at runtime via
 * `setCapture` WS messages; the server respawns sim-server with the new
 * values and broadcasts a `configChanged` event so every preview
 * reconnects its MJPEG <img>.
 */
export type CaptureSettings = {
  fps: number;
  quality: number;
  scale: number;
  mode: "mjpeg" | "bgra";
};

export type SimConfig = {
  streamUrl: string;
  snapshotUrl: string;
  simulator: { udid: string; name: string };
  capture: CaptureSettings;
};

export type BridgeStatus = "disconnected" | "connecting" | "connected";

/**
 * Structured data for an iOS accessibility node — everything the UI
 * surfaces in the Properties panel when an AX layer is selected. All
 * fields mirror the raw `axe describe-ui` schema but are typed here for
 * convenience.
 */
export type AxProperties = {
  type?: string;
  role?: string;
  roleDescription?: string;
  subrole?: string;
  label?: string;
  value?: string;
  help?: string;
  title?: string;
  uniqueId?: string;
  enabled?: boolean;
  pid?: number;
  /** Device-point frame — not sim-ratio. */
  devicePointFrame?: { x: number; y: number; width: number; height: number };
};

/** A node in the hierarchical layer tree (derived from stacks across inspections). */
export type LayerNode = {
  id: string;
  componentName: string;
  source?: SourceLocation;
  frame?: Rect;
  /** Depth in the stack, 0 = leaf (the actually tapped element). */
  depth: number;
  /** Children (higher-depth items) if we built a tree from multiple selections. */
  children: LayerNode[];
  /** iOS accessibility properties, when this node comes from the AX tree. */
  ax?: AxProperties;
};
