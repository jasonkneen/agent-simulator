import type { InspectResult, LayerNode, StackFrame } from "./types";

/**
 * Convert a single inspect result's component stack into a linear chain of
 * LayerNode entries (root → leaf). The LEAF (depth 0) is the most specific
 * component — what the user actually tapped — and the root (highest depth) is
 * the outermost ancestor.
 */
export function stackToChain(result: InspectResult): LayerNode[] {
  if (!result.stack) return [];
  const chain: LayerNode[] = result.stack.map((f, i) => ({
    id: idForFrame(f, i),
    componentName: f.componentName,
    source: f.source,
    frame: f.frame ?? (i === 0 ? result.frame : undefined),
    depth: i,
    children: [],
  }));
  // Nest: each item becomes the child of the next-higher-depth item, so the
  // root is chain[chain.length - 1] and the leaf is chain[0].
  for (let i = 0; i < chain.length - 1; i++) {
    chain[i + 1].children.push(chain[i]);
  }
  return chain;
}

/** A stable-ish id for a stack frame, used for React keys + selection tracking. */
export function idForFrame(f: StackFrame, depth: number): string {
  const src = f.source
    ? `${f.source.fileName}:${f.source.line0Based}:${f.source.column0Based}`
    : "nosrc";
  return `${depth}|${f.componentName}|${src}`;
}

/**
 * Merge the latest stack into an accumulated tree so the side panel can show
 * everything we've inspected so far as a Figma-style hierarchy, with the most
 * recent selection path highlighted.
 */
export function mergeStackIntoTree(
  prev: LayerNode | null,
  result: InspectResult
): LayerNode | null {
  if (!result.stack || result.stack.length === 0) return prev;

  // Reverse so the outermost ancestor comes first.
  const reversed = [...result.stack].reverse();

  const rootFrame = reversed[0];
  const rootId = idForFrame(rootFrame, reversed.length - 1);

  let root: LayerNode =
    prev && prev.id === rootId
      ? prev
      : {
          id: rootId,
          componentName: rootFrame.componentName,
          source: rootFrame.source,
          frame: rootFrame.frame,
          depth: reversed.length - 1,
          children: [],
        };

  let cursor = root;
  for (let i = 1; i < reversed.length; i++) {
    const f = reversed[i];
    const depth = reversed.length - 1 - i;
    const id = idForFrame(f, depth);
    let child = cursor.children.find((c) => c.id === id);
    if (!child) {
      child = {
        id,
        componentName: f.componentName,
        source: f.source,
        frame: f.frame ?? (i === reversed.length - 1 ? result.frame : undefined),
        depth,
        children: [],
      };
      cursor.children = [...cursor.children, child];
    } else if (i === reversed.length - 1 && result.frame) {
      // Freshen the leaf's frame with the outer inspect frame, which is most
      // accurate for the clicked view.
      child.frame = result.frame;
    }
    cursor = child;
  }

  return root;
}

/** Flatten a tree to a depth-ordered list for rendering. */
export function flatten(node: LayerNode | null): { node: LayerNode; level: number }[] {
  if (!node) return [];
  const out: { node: LayerNode; level: number }[] = [];
  const walk = (n: LayerNode, level: number) => {
    out.push({ node: n, level });
    for (const c of n.children) walk(c, level + 1);
  };
  walk(node, 0);
  return out;
}

/** Find node by id anywhere in the tree. */
export function findNode(
  root: LayerNode | null,
  id: string
): LayerNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

/**
 * Return the chain of node ids from the root down to and including the
 * given id. Used to programmatically expand the layers panel when a node
 * is selected via the simulator preview.
 */
export function pathToNode(
  root: LayerNode | null,
  id: string
): string[] {
  const out: string[] = [];
  const walk = (n: LayerNode): boolean => {
    if (n.id === id) {
      out.push(n.id);
      return true;
    }
    for (const c of n.children) {
      if (walk(c)) {
        out.push(n.id);
        return true;
      }
    }
    return false;
  };
  if (root) walk(root);
  return out.reverse();
}

/**
 * Find the deepest layer node whose frame contains `(x, y)` — coordinates
 * in [0, 1] sim-ratio space. Returns null if no node matches. The leaf
 * (deepest) result gives the most specific selection to highlight.
 */
export function hitTest(
  root: LayerNode | null,
  x: number,
  y: number
): LayerNode | null {
  if (!root) return null;
  const recurse = (n: LayerNode): LayerNode | null => {
    if (!contains(n.frame, x, y)) return null;
    // Walk children in reverse (later siblings usually draw on top).
    for (let i = n.children.length - 1; i >= 0; i--) {
      const hit = recurse(n.children[i]);
      if (hit) return hit;
    }
    return n;
  };
  return recurse(root);
}

function contains(
  rect: { x: number; y: number; width: number; height: number } | undefined,
  x: number,
  y: number
) {
  if (!rect) return false;
  return (
    x >= rect.x &&
    y >= rect.y &&
    x <= rect.x + rect.width &&
    y <= rect.y + rect.height
  );
}
