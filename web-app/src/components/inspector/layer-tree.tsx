import { ChevronRight, Square, Box, Type } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LayerNode } from "@/lib/types";
import { cn } from "@/lib/utils";

export type LayerTreeProps = {
  root: LayerNode | null;
  selectedId: string | null;
  onSelect: (node: LayerNode) => void;
  onHover: (node: LayerNode | null) => void;
  /**
   * Controlled open-state. Nodes whose id is in this set are expanded;
   * everything else is collapsed. Passing `null` falls back to the legacy
   * "every top-two levels auto-open" behaviour.
   */
  openIds?: Set<string> | null;
  onToggleOpen?: (id: string, open: boolean) => void;
};

/**
 * Figma-style layer hierarchy. The currently selected node is highlighted
 * and auto-scrolled into view; the one under the pointer is marked for the
 * simulator overlay. Open/closed state is controlled from the parent so
 * tapping an element in the preview can programmatically expand its
 * ancestor chain.
 */
export function LayerTree({
  root,
  selectedId,
  onSelect,
  onHover,
  openIds,
  onToggleOpen,
}: LayerTreeProps) {
  if (!root) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-xs text-muted-foreground">
        <div className="max-w-[24ch] space-y-1">
          <p>No components inspected yet.</p>
          <p className="text-muted-foreground/70">
            Enable <span className="font-semibold text-foreground">Inspect</span> and
            click anywhere in the simulator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-max min-w-full py-1">
        <LayerRow
          node={root}
          level={0}
          selectedId={selectedId}
          onSelect={onSelect}
          onHover={onHover}
          openIds={openIds ?? null}
          onToggleOpen={onToggleOpen}
        />
      </div>
    </div>
  );
}

/**
 * Width of one indent step in pixels. Has to be small for RN trees,
 * where a leaf can live 25+ levels deep. The vertical guide line keeps
 * the hierarchy readable even at 4px per step.
 */
const INDENT_PX = 4;

function LayerRow({
  node,
  level,
  selectedId,
  onSelect,
  onHover,
  openIds,
  onToggleOpen,
}: {
  node: LayerNode;
  level: number;
  selectedId: string | null;
  onSelect: (node: LayerNode) => void;
  onHover: (node: LayerNode | null) => void;
  openIds: Set<string> | null;
  onToggleOpen?: (id: string, open: boolean) => void;
}) {
  // Controlled open state when openIds is provided; otherwise "top 2 levels".
  const controlled = openIds !== null;
  const open = controlled ? openIds!.has(node.id) : level < 2;
  const hasChildren = node.children.length > 0;
  const isSelected = node.id === selectedId;
  const Icon = iconFor(node.componentName);

  // Auto-scroll selected row into view whenever it changes.
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isSelected) {
      rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [isSelected]);

  return (
    <div>
      <div
        ref={rowRef}
        role="treeitem"
        aria-selected={isSelected}
        onMouseEnter={() => onHover(node)}
        onMouseLeave={() => onHover(null)}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node);
        }}
        className={cn(
          "group relative flex cursor-pointer select-none items-center pr-3 text-[11px] leading-[18px] whitespace-nowrap",
          "hover:bg-accent/70",
          isSelected && "bg-primary/15 text-foreground hover:bg-primary/20"
        )}
      >
        {/* Indent guides — a thin vertical line at every ancestor depth. */}
        {Array.from({ length: level }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className="h-full shrink-0 border-l border-border/40"
            style={{ width: INDENT_PX }}
          />
        ))}
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleOpen?.(node.id, !open);
          }}
          className={cn(
            "grid h-full shrink-0 place-items-center text-muted-foreground transition-transform",
            hasChildren ? "opacity-100" : "opacity-0",
            open ? "rotate-90" : "rotate-0"
          )}
          style={{ width: 10 }}
        >
          <ChevronRight className="size-[10px]" />
        </button>
        <Icon
          className={cn(
            "mr-1 size-[11px] shrink-0",
            isSelected ? "text-primary" : "text-muted-foreground"
          )}
        />
        <span className="shrink-0 truncate font-medium">
          {node.componentName}
        </span>
        {node.source?.fileName && (
          <span className="ml-2 shrink-0 truncate text-[10px] font-normal text-muted-foreground/60">
            {basename(node.source.fileName)}
          </span>
        )}
      </div>

      {hasChildren && open && (
        <div>
          {node.children.map((c) => (
            <LayerRow
              key={c.id}
              node={c}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onHover={onHover}
              openIds={openIds}
              onToggleOpen={onToggleOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function iconFor(name: string) {
  const n = name.toLowerCase();
  if (n.includes("text")) return Type;
  if (n.includes("view") || n.includes("group") || n.includes("stack")) return Box;
  return Square;
}

function basename(p: string) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
