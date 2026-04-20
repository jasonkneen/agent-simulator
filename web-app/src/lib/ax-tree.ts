import type { AxProperties, LayerNode, Rect } from "./types";

/**
 * Raw `axe describe-ui` JSON node. The upstream schema has many more
 * fields; we only read the ones we render.
 */
export type AxNode = {
  frame?: { x: number; y: number; width: number; height: number };
  AXFrame?: string;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  role?: string | null;
  role_description?: string | null;
  type?: string | null;
  title?: string | null;
  help?: string | null;
  enabled?: boolean;
  subrole?: string | null;
  children?: AxNode[];
  pid?: number | null;
};

/**
 * Convert the raw describe-ui tree (an array whose first element is the
 * Application) into a normalised {@link LayerNode} rooted at that
 * Application. Every frame is converted from device points to a
 * sim-ratio so the overlay draws correctly regardless of simulator
 * zoom or pixel density.
 */
export function axTreeToLayerTree(raw: AxNode[] | AxNode | null | undefined): LayerNode | null {
  if (!raw) return null;
  const nodes = Array.isArray(raw) ? raw : [raw];
  const root = nodes[0];
  if (!root) return null;

  const rootFrame = frameOf(root);
  if (!rootFrame || rootFrame.width <= 0 || rootFrame.height <= 0) return null;

  // Every child frame is in the same (0,0)-origin device-point coordinate
  // system as the root, so ratio = frame.xy / root.wh.
  const deviceW = rootFrame.width;
  const deviceH = rootFrame.height;

  const build = (node: AxNode, path: string, depth: number): LayerNode => {
    const f = frameOf(node);
    const rect: Rect | undefined = f
      ? {
          x: f.x / deviceW,
          y: f.y / deviceH,
          width: f.width / deviceW,
          height: f.height / deviceH,
        }
      : undefined;

    const name = displayName(node);
    const children = (node.children ?? []).map((c, i) =>
      build(c, `${path}/${i}`, depth + 1)
    );

    const ax: AxProperties = {
      type: node.type ?? undefined,
      role: node.role ?? undefined,
      roleDescription: node.role_description ?? undefined,
      subrole: node.subrole ?? undefined,
      label: node.AXLabel ?? undefined,
      value: node.AXValue ?? undefined,
      help: node.help ?? undefined,
      title: node.title ?? undefined,
      uniqueId: node.AXUniqueId ?? undefined,
      enabled: node.enabled,
      pid: node.pid ?? undefined,
      devicePointFrame: f ? { x: f.x, y: f.y, width: f.width, height: f.height } : undefined,
    };

    return {
      id: `ax|${path}|${node.type ?? "?"}|${node.AXUniqueId ?? node.AXLabel ?? ""}`,
      componentName: name,
      source: undefined,
      frame: rect,
      depth,
      children,
      ax,
    };
  };

  return build(root, "0", 0);
}

function frameOf(n: AxNode) {
  if (n.frame && typeof n.frame.width === "number") return n.frame;
  // Parse "{{x, y}, {w, h}}" as a fallback when only AXFrame is present.
  if (typeof n.AXFrame === "string") {
    const nums = n.AXFrame.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (nums && nums.length >= 4) {
      return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
    }
  }
  return undefined;
}

/**
 * Pick a human label for a node. AXLabel is the best (it's what the user
 * sees / VoiceOver reads); otherwise fall back to the accessibility type,
 * then the role.
 */
function displayName(n: AxNode): string {
  const label = (n.AXLabel ?? "").trim();
  if (label) {
    // Prefix with the type for disambiguation, e.g. "Button · Save".
    const t = n.type ?? n.role_description ?? "";
    if (t && !label.toLowerCase().includes(t.toLowerCase())) {
      return `${t} · ${label}`;
    }
    return label;
  }
  const value = (n.AXValue ?? "").trim();
  if (value) return `${n.type ?? "Element"} · ${value}`;
  return n.type ?? n.role_description ?? n.role ?? "Element";
}

/** Centre of a rect in [0, 1] sim-ratio space. */
export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
