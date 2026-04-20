import { useEffect, useState } from "react";
import type { SimConfig } from "@/lib/types";

export function useSimConfig() {
  const [config, setConfig] = useState<SimConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const load = async () => {
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
        setTimeout(load, Math.min(1000 * attempt, 5000));
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, error };
}
