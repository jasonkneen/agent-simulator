import { useEffect, useState } from "react";
import type { SourceLocation } from "@/lib/types";

export type SourceSnippet = {
  file: string;
  startLine0: number;
  endLine0: number;
  targetLine0: number;
  totalLines: number;
  lines: string[];
  language: string;
};

export type UseSourceState = {
  snippet: SourceSnippet | null;
  error: string | null;
  loading: boolean;
};

/**
 * Fetch a window of source lines around the given component source
 * location (file + zero-based line/col). Renders nothing (returns null)
 * when no location is provided.
 */
export function useSourceFile(
  loc: SourceLocation | undefined,
  context = 14
): UseSourceState {
  const [snippet, setSnippet] = useState<SourceSnippet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loc) {
      setSnippet(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({
      file: loc.fileName,
      line: String(loc.line0Based),
      context: String(context),
    });
    fetch(`/api/source?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SourceSnippet;
      })
      .then((data) => {
        if (cancelled) return;
        setSnippet(data);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setSnippet(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loc?.fileName, loc?.line0Based, loc?.column0Based, context]);

  return { snippet, error, loading };
}
