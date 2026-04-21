import {
  Crosshair,
  Home,
  Lock,
  RotateCw,
  Signal,
  SignalZero,
  Smartphone,
  PanelLeft,
  PanelRight,
  SquareStack,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { QualityMenu } from "@/components/layout/quality-menu";
import type { BridgeStatus, CaptureSettings } from "@/lib/types";
import { cn } from "@/lib/utils";

export type ToolbarProps = {
  deviceName?: string;
  wsOpen: boolean;
  bridge: BridgeStatus;
  inspectMode: boolean;
  onToggleInspect: (v: boolean) => void;
  /**
   * Inspect is a React-Native-only feature — tapping into a native app
   * like Settings or Maps can't produce a component stack. When false the
   * toggle is rendered disabled with an explanatory tooltip.
   */
  inspectAvailable: boolean;
  leftPanelOpen: boolean;
  onToggleLeftPanel: (v: boolean) => void;
  rightPanelOpen: boolean;
  onToggleRightPanel: (v: boolean) => void;
  onHome: () => void;
  onMultitask: () => void;
  onLock: () => void;
  onRotate: () => void;
  capture?: CaptureSettings;
  onCaptureChange?: (next: Partial<CaptureSettings>) => void;
};

export function Toolbar(props: ToolbarProps) {
  const {
    deviceName,
    wsOpen,
    bridge,
    inspectMode,
    onToggleInspect,
    inspectAvailable,
    leftPanelOpen,
    onToggleLeftPanel,
    rightPanelOpen,
    onToggleRightPanel,
    onHome,
    onMultitask,
    onLock,
    onRotate,
    capture,
    onCaptureChange,
  } = props;

  return (
    <header className="relative z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-background/80 px-3 backdrop-blur">
      {/* Brand */}
      <div className="flex items-center gap-2 pr-2">
        <div className="grid size-6 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/20">
          <Smartphone className="size-3.5" />
        </div>
        <div className="leading-none">
          <div className="text-[13px] font-semibold tracking-tight">agent-simulator</div>
          <div className="text-[10px] text-muted-foreground">iOS preview · mcp-ready</div>
        </div>
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Device + connection chips */}
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 text-[11px] font-medium">
          {deviceName ?? "No device"}
        </span>
        <StatusPill label="stream" on={wsOpen} />
        <StatusPill
          label={bridge === "connected" ? "bridge" : "bridge idle"}
          on={bridge === "connected"}
          dim={bridge !== "connected"}
        />
      </div>

      <div className="flex-1" />

      {/* One toggle. On = inspect React components, off = drive the app.
          Only available when a React Native bridge is connected. */}
      <div className="flex items-center gap-1">
        <ToolbarToggle
          active={inspectMode}
          onClick={() => onToggleInspect(!inspectMode)}
          disabled={!inspectAvailable}
          label="Inspect"
          hint={
            !inspectAvailable
              ? "Inspect only works for React Native apps. Launch an RN / Expo app with the agent-simulator plugin to enable."
              : inspectMode
                ? "Click the sim to inspect an element (I to toggle off)"
                : "Enable inspect mode (I) — otherwise clicks drive the app"
          }
          icon={<Crosshair className="size-3.5" />}
        />
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Device actions */}
      <div className="flex items-center gap-0.5">
        <IconTip label="Home" onClick={onHome}>
          <Home className="size-3.5" />
        </IconTip>
        <IconTip label="App switcher" onClick={onMultitask}>
          <SquareStack className="size-3.5" />
        </IconTip>
        <IconTip label="Lock" onClick={onLock}>
          <Lock className="size-3.5" />
        </IconTip>
        <IconTip label="Rotate" onClick={onRotate}>
          <RotateCw className="size-3.5" />
        </IconTip>
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Quality */}
      {capture && onCaptureChange && (
        <>
          <QualityMenu settings={capture} onChange={onCaptureChange} />
          <Separator orientation="vertical" className="mx-1 h-6" />
        </>
      )}

      {/* Panel toggles */}
      <div className="flex items-center gap-0.5">
        <IconTip
          label={leftPanelOpen ? "Hide layers" : "Show layers"}
          onClick={() => onToggleLeftPanel(!leftPanelOpen)}
          active={leftPanelOpen}
        >
          <PanelLeft className="size-3.5" />
        </IconTip>
        <IconTip
          label={rightPanelOpen ? "Hide properties" : "Show properties"}
          onClick={() => onToggleRightPanel(!rightPanelOpen)}
          active={rightPanelOpen}
        >
          <PanelRight className="size-3.5" />
        </IconTip>
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <ThemeToggle />
    </header>
  );
}

function ToolbarToggle({
  active,
  onClick,
  label,
  hint,
  icon,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "default" : "ghost"}
          size="sm"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "h-7 gap-1.5 px-2 text-[11px] font-medium",
            active && "ring-1 ring-primary/40",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          {icon}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function IconTip({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function StatusPill({
  label,
  on,
  dim,
}: {
  label: string;
  on: boolean;
  dim?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider",
        on
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-border/70 bg-muted/40 text-muted-foreground",
        dim && "opacity-80"
      )}
    >
      {on ? <Signal className="size-3" /> : <SignalZero className="size-3" />}
      {label}
    </span>
  );
}
