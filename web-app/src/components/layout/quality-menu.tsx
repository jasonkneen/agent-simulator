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
 * Capture-quality presets. Tuning knobs:
 *
 *   - fps     how often the capture loop pulls a frame
 *   - scale   retina factor applied to the output image (0.33 = one
 *             device-point per pixel, i.e. the same resolution the
 *             browser paints the preview at)
 *   - quality JPEG quality 0\u2013100
 *
 * Every preset keeps clickability (coords are [0,1] ratios regardless of
 * pixel count). Lower presets just mean a blurrier / choppier preview.
 */
export const QUALITY_PRESETS: Record<
  "eco" | "balanced" | "smooth" | "max",
  CaptureSettings
> = {
  eco:      { fps: 2,  quality: 45, scale: 0.25, mode: "mjpeg" },
  balanced: { fps: 3,  quality: 55, scale: 0.33, mode: "mjpeg" },
  smooth:   { fps: 10, quality: 65, scale: 0.33, mode: "mjpeg" },
  max:      { fps: 15, quality: 80, scale: 0.5,  mode: "mjpeg" },
};

const PRESET_ORDER = ["eco", "balanced", "smooth", "max"] as const;

const PRESET_DESCRIPTION: Record<keyof typeof QUALITY_PRESETS, string> = {
  eco: "2 fps \u00b7 300\u00d7650 \u00b7 battery-friendly",
  balanced: "3 fps \u00b7 400\u00d7870 \u00b7 default",
  smooth: "10 fps \u00b7 400\u00d7870 \u00b7 good for scrolling",
  max: "15 fps \u00b7 600\u00d71300 \u00b7 pixel-clean recordings",
};

/** True when `a` matches `b` on every relevant field. */
function sameSettings(a: CaptureSettings, b: CaptureSettings) {
  return (
    a.fps === b.fps &&
    a.quality === b.quality &&
    Math.abs(a.scale - b.scale) < 1e-3 &&
    a.mode === b.mode
  );
}

/** Pick which preset (if any) best matches a CaptureSettings. */
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
              <span className="text-muted-foreground">
                {settings.fps}fps
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Stream quality \u2014 doesn\u2019t affect click accuracy.
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
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
              <div className="flex w-full items-center">
                <span className="flex-1 font-medium">{capitalize(name)}</span>
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
            max={30}
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
        </div>
        <DropdownMenuSeparator />
        <div className="px-2 pb-2 pt-1 text-[10px] leading-snug text-muted-foreground">
          Click accuracy is independent of stream size \u2014 taps carry
          [0, 1] ratios.
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

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
