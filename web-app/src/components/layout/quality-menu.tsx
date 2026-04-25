import { Gauge, Check } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CaptureSettings } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Capture-quality presets.
 *
 *   fps     how often a frame is pulled from the simulator
 *   scale   retina factor applied to the output image (0.33 = one
 *           device-point per pixel, i.e. the size the browser paints at)
 *   quality JPEG quality 0-100
 *   mode    'mjpeg' = axe screenshot-polling loop (reliable, idle-safe,
 *           axe hard-caps at 30 fps)
 *           'simstream' = CoreSimulator IOSurface + VideoToolbox H.264
 *           as fMP4 over WebSocket (Komand-style native streaming)
 *           'bgra'  = FBVideoStreamConfiguration push-stream off
 *           SimDeviceIOClient. Uncapped up to the simulator's native
 *           render rate (60 fps). Only emits frames while the sim is
 *           actually rendering; stalls on idle screens.
 *
 * Every preset keeps clickability: taps travel as [0, 1] ratios and the
 * stream resolution is purely cosmetic.
 */
export const QUALITY_PRESETS: Record<
  "eco" | "balanced" | "smooth" | "max" | "fluid",
  CaptureSettings
> = {
  eco:      { fps: 2,  quality: 45, scale: 0.25, mode: "mjpeg" },
  balanced: { fps: 3,  quality: 55, scale: 0.33, mode: "mjpeg" },
  smooth:   { fps: 10, quality: 65, scale: 0.33, mode: "mjpeg" },
  max:      { fps: 30, quality: 80, scale: 0.33, mode: "mjpeg" },
  fluid:    { fps: 60, quality: 70, scale: 0.33, mode: "simstream" },
};

const PRESET_ORDER = ["eco", "balanced", "smooth", "max", "fluid"] as const;

const PRESET_DESCRIPTION: Record<keyof typeof QUALITY_PRESETS, string> = {
  eco:      "2 fps  \u00b7 300\u00d7650  \u00b7 battery-friendly",
  balanced: "3 fps  \u00b7 400\u00d7870  \u00b7 default",
  smooth:   "up to 10 fps \u00b7 400\u00d7870 \u00b7 good for scrolling",
  max:      "up to 30 fps \u00b7 400\u00d7870 \u00b7 max MJPEG (axe caps actual ~10)",
  fluid:    "Native fMP4 · CoreSimulator IOSurface + VideoToolbox",
};

function sameSettings(a: CaptureSettings, b: CaptureSettings) {
  return (
    a.fps === b.fps &&
    a.quality === b.quality &&
    Math.abs(a.scale - b.scale) < 1e-3 &&
    a.mode === b.mode
  );
}

export function detectPreset(s: CaptureSettings): keyof typeof QUALITY_PRESETS | "custom" {
  for (const name of PRESET_ORDER) {
    if (sameSettings(QUALITY_PRESETS[name], s)) return name;
  }
  return "custom";
}

export function QualityMenu({
  settings,
  onChange,
}: {
  settings: CaptureSettings;
  onChange: (next: Partial<CaptureSettings>) => void;
}) {
  const active = useMemo(() => detectPreset(settings), [settings]);
  const label = active === "custom" ? "Custom" : capitalize(active);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px] font-medium"
            >
              <Gauge className="size-3.5" />
              {label}
              <span className="text-muted-foreground">{settings.fps}fps</span>
              {settings.mode !== "mjpeg" && (
                <span className="rounded-sm bg-primary/15 px-1 text-[9px] font-semibold uppercase tracking-wider text-primary">
                  {settings.mode === "simstream" ? "fmp4" : "bgra"}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Stream quality — doesn't affect click accuracy.
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Stream quality
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRESET_ORDER.map((name) => {
          const p = QUALITY_PRESETS[name];
          const isActive = active === name;
          return (
            <DropdownMenuItem
              key={name}
              onSelect={() => onChange(p)}
              className="flex flex-col items-start gap-0.5 py-1.5"
            >
              <div className="flex w-full items-center gap-1.5">
                <span className="flex-1 font-medium">{capitalize(name)}</span>
                {p.mode !== "mjpeg" && (
                  <span className="rounded-sm bg-primary/15 px-1 text-[9px] font-semibold uppercase tracking-wider text-primary">
                    {p.mode === "simstream" ? "fmp4" : "bgra"}
                  </span>
                )}
                <Check
                  className={cn(
                    "size-3.5 text-primary",
                    !isActive && "invisible",
                  )}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">
                {PRESET_DESCRIPTION[name]}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Fine tune
        </DropdownMenuLabel>
        <div className="space-y-3 px-2 py-2">
          <SliderRow
            label="FPS"
            value={settings.fps}
            min={1}
            max={60}
            step={1}
            onChange={(v) => onChange({ fps: v })}
            format={(v) => `${v}`}
          />
          <SliderRow
            label="Quality"
            value={settings.quality}
            min={10}
            max={95}
            step={5}
            onChange={(v) => onChange({ quality: v })}
            format={(v) => `${v}`}
          />
          <SliderRow
            label="Scale"
            value={settings.scale}
            min={0.2}
            max={1.0}
            step={0.05}
            onChange={(v) => onChange({ scale: v })}
            format={(v) => v.toFixed(2)}
          />
          <ModeRow
            mode={settings.mode}
            onChange={(m) => onChange({ mode: m })}
          />
        </div>
        <DropdownMenuSeparator />
        <div className="px-2 pb-2 pt-1 text-[10px] leading-snug text-muted-foreground">
          Click accuracy is independent of stream size — taps carry [0, 1] ratios.
          <br />
          Actual FPS is capped by axe's screenshot loop in MJPEG. Native fMP4
          streams the simulator IOSurface through VideoToolbox; BGRA remains
          available as an experimental fallback.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <label className="block space-y-1">
      <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-foreground">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "h-1 w-full cursor-pointer appearance-none rounded-full bg-muted",
          "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
          "[&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:ring-2",
          "[&::-webkit-slider-thumb]:ring-background",
        )}
      />
    </label>
  );
}

function ModeRow({
  mode,
  onChange,
}: {
  mode: CaptureSettings["mode"];
  onChange: (m: CaptureSettings["mode"]) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      <span>Mode</span>
      <div className="ml-auto flex overflow-hidden rounded-md border border-border/70 bg-background/70 text-[10px]">
        <button
          type="button"
          onClick={() => onChange("mjpeg")}
          className={cn(
            "px-2 py-1 transition",
            mode === "mjpeg"
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          MJPEG
        </button>
        <button
          type="button"
          onClick={() => onChange("bgra")}
          className={cn(
            "border-l border-border/70 px-2 py-1 transition",
            mode === "bgra"
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          BGRA
        </button>
        <button
          type="button"
          onClick={() => onChange("simstream")}
          className={cn(
            "border-l border-border/70 px-2 py-1 transition",
            mode === "simstream"
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          fMP4
        </button>
      </div>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
