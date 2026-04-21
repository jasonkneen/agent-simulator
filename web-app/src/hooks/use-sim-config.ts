import { useCallback, useEffect, useState } from "react";
import type { SimConfig } from "@/lib/types";

/**
 * Hook that owns the current `/api/config` payload. Exposes `setConfig`
 * so WS events (configChanged) can push an updated stream URL / capture
 * settings without forcing a full page reload.
 */
export function useSimConfig() {
  const [config, setConfig] = useState<SimConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SimConfig;
      setConfig(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const run = async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SimConfig;
        if (!cancelled) {
          setConfig(data);
          setError(null);
        }
      } catch (e) {
        if (cancelled) return;
        attempt++;
        setError(e instanceof Error ? e.message : String(e));
        setTimeout(run, Math.min(1000 * attempt, 5000));
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, error, setConfig, refresh: load };
}
