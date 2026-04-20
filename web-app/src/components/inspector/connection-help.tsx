import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function ConnectionHelp({
  wsOpen,
  bridgeConnected,
}: {
  wsOpen: boolean;
  bridgeConnected: boolean;
}) {
  if (wsOpen && bridgeConnected) return null;

  return (
    <div
      className={cn(
        "rounded-md border bg-card/60 p-2.5 text-[11px] leading-snug",
        !wsOpen
          ? "border-destructive/40 text-destructive-foreground"
          : "border-amber-500/40 text-amber-200"
      )}
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <AlertCircle className="size-3.5" />
        {wsOpen ? "Waiting for inspector bridge" : "Server unreachable"}
      </div>
      <p className="mt-1 text-muted-foreground">
        {wsOpen
          ? "Run your Expo / RN app with the agent-simulator metro plugin enabled and the bridge will register automatically."
          : "The agent-simulator server isn't responding on :3200. Start it with `bun start` or `bun demo`."}
      </p>
    </div>
  );
}
