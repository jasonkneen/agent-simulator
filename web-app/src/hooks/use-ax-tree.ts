import { useCallback, useEffect, useState } from "react";
import { axTreeToLayerTree, type AxNode } from "@/lib/ax-tree";
import type { LayerNode } from "@/lib/types";

export type AxTreeState = {
  /** The iOS accessibility hierarchy, normalised to sim-ratio frames. */
  tree: LayerNode | null;
  /** Last error message from `/api/tree`, if any. */
  error: string | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Force a fresh `axe describe-ui` call. */
  refresh: () => Promise<void>;
};

/**
 * Load the iOS accessibility tree from the sim-server (`/api/tree`) and
 * keep it in sync. By default the tree is fetched once at mount; callers
 * can trigger a refresh manually (e.g. after sending a tap, or on a
 * "Refresh" button).
 */
export function useAxTree(pollMs?: number): AxTreeState {
  const [tree, setTree] = useState<LayerNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tree", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as AxNode[];
      const next = axTreeToLayerTree(raw);
      setTree(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + optional poll.
  useEffect(() => {
    void refresh();
    if (!pollMs || pollMs <= 0) return;
    const id = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(id);
  }, [refresh, pollMs]);

  return { tree, error, loading, refresh };
}
