import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { LayerNode } from "@/lib/types";
import { useSourceFile } from "@/hooks/use-source-file";
import {
  FileCode2,
  ExternalLink,
  Hash,
  Ruler,
  Layers,
  MousePointerClick,
  Code2,
  Accessibility,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type PropertyPanelProps = {
  node: LayerNode | null;
  onOpenInEditor: (node: LayerNode) => void;
  onTapCenter?: (node: LayerNode) => void;
};

export function PropertyPanel({
  node,
  onOpenInEditor,
  onTapCenter,
}: PropertyPanelProps) {
  const { snippet, loading: snippetLoading, error: snippetError } = useSourceFile(
    node?.source,
  );

  if (!node) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-xs text-muted-foreground">
        <div className="max-w-[26ch] space-y-2">
          <Layers className="mx-auto size-5 text-muted-foreground/60" />
          <p>Select a layer to see its component properties.</p>
        </div>
      </div>
    );
  }

  const f = node.frame;
  const src = node.source;
  const fullPath = src ? `${src.fileName}:${src.line0Based + 1}:${src.column0Based + 1}` : null;
  const ax = node.ax;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {/* Identity */}
        <section className="space-y-2">
          <SectionTitle icon={<Hash className="size-3" />}>Component</SectionTitle>
          <div className="rounded-md border border-border/70 bg-muted/30 p-2.5">
            <div className="text-sm font-semibold">{node.componentName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>depth {node.depth}</span>
              {ax ? <span className="rounded-sm bg-muted px-1 py-px text-[9px]">ios a11y</span> : null}
              {src ? <span className="rounded-sm bg-muted px-1 py-px text-[9px]">react</span> : null}
            </div>
          </div>
        </section>

        {ax && (
          <>
            <Separator />
            <section className="space-y-2">
              <SectionTitle icon={<Accessibility className="size-3" />}>
                Accessibility
              </SectionTitle>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border/70 bg-muted/30 p-2.5 font-mono text-[11px] leading-snug">
                {ax.label && <Prop2 k="label" v={ax.label} />}
                {ax.value && <Prop2 k="value" v={ax.value} />}
                {ax.type && <Prop2 k="type" v={ax.type} />}
                {ax.roleDescription && ax.roleDescription !== ax.type && (
                  <Prop2 k="role" v={ax.roleDescription} />
                )}
                {ax.subrole && <Prop2 k="subrole" v={ax.subrole} />}
                {ax.title && <Prop2 k="title" v={ax.title} />}
                {ax.help && <Prop2 k="help" v={ax.help} />}
                {ax.uniqueId && <Prop2 k="uniqueId" v={ax.uniqueId} />}
                <Prop2 k="enabled" v={String(ax.enabled ?? true)} />
                {ax.pid !== undefined && <Prop2 k="pid" v={String(ax.pid)} />}
                {ax.devicePointFrame && (
                  <Prop2
                    k="frame"
                    v={`x ${ax.devicePointFrame.x.toFixed(1)}, y ${ax.devicePointFrame.y.toFixed(1)}, ${ax.devicePointFrame.width.toFixed(1)}×${ax.devicePointFrame.height.toFixed(1)} pt`}
                  />
                )}
              </div>
            </section>
          </>
        )}

        <Separator />

        {/* Source */}
        <section className="space-y-2">
          <SectionTitle icon={<FileCode2 className="size-3" />}>Source</SectionTitle>
          {src ? (
            <div className="space-y-2">
              <div className="rounded-md border border-border/70 bg-muted/30 p-2.5 font-mono text-[11px] leading-snug">
                <div className="truncate" title={src.fileName}>
                  {src.fileName}
                </div>
                <div className="text-muted-foreground">
                  line {src.line0Based + 1}, col {src.column0Based + 1}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 w-full gap-1.5 text-[11px]"
                onClick={() => onOpenInEditor(node)}
              >
                <ExternalLink className="size-3" />
                Open in editor
              </Button>
              <p className="text-[10px] leading-snug text-muted-foreground">
                Opens {fullPath} via the <code>vscode://</code> URL handler.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {ax
                ? "iOS accessibility node \u2014 no React source available. Enable Inspect and click the element to pick up the component's file + line."
                : "No source available. Make sure Babel's @babel/plugin-transform-react-jsx-source is enabled."}
            </p>
          )}
        </section>

        {src && (
          <>
            <Separator />
            <section className="space-y-2">
              <SectionTitle icon={<Code2 className="size-3" />}>
                Code
                {snippetLoading && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
              </SectionTitle>
              {snippet ? (
                <CodeSnippet snippet={snippet} target={src.line0Based} />
              ) : snippetError ? (
                <p className="text-[11px] text-muted-foreground">
                  Could not read source: {snippetError}
                </p>
              ) : null}
            </section>
          </>
        )}

        <Separator />

        {/* Layout */}
        <section className="space-y-2">
          <SectionTitle icon={<Ruler className="size-3" />}>Layout</SectionTitle>
          {f ? (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <Prop label="x" value={pct(f.x)} />
                <Prop label="y" value={pct(f.y)} />
                <Prop label="w" value={pct(f.width)} />
                <Prop label="h" value={pct(f.height)} />
              </div>
              {onTapCenter && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 w-full gap-1.5 text-[11px]"
                  onClick={() => onTapCenter(node)}
                >
                  <MousePointerClick className="size-3" />
                  Tap center
                </Button>
              )}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">Frame not available.</p>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function CodeSnippet({
  snippet,
  target,
}: {
  snippet: {
    startLine0: number;
    lines: string[];
  };
  target: number;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-muted/30 font-mono text-[11px] leading-relaxed">
      <div className="max-h-64 overflow-auto">
        <pre className="min-w-0">
          {snippet.lines.map((line, i) => {
            const lineNo = snippet.startLine0 + i;
            const isTarget = lineNo === target;
            return (
              <div
                key={lineNo}
                className={cn(
                  "flex gap-3 px-2.5",
                  isTarget && "bg-primary/15"
                )}
              >
                <span className="w-9 shrink-0 select-none text-right text-muted-foreground/60">
                  {lineNo + 1}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  {line.length ? line : " "}
                </span>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function SectionTitle({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-[11px]">{value}</div>
    </div>
  );
}

function Prop2({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="text-muted-foreground">{k}</div>
      <div className="min-w-0 break-words">{v}</div>
    </>
  );
}

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}
