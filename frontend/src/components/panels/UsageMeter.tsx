import { Gauge } from "lucide-react";

import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatBytes, formatDuration } from "@/lib/utils";

/** Compact token counts: `12.4K`, `200K` — the trigger must stay narrower than a status pill. */
const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function UsageMeter() {
  const usage = useAppStore((s) => s.usage);

  // Nothing has run yet. Showing "0 / 0" would imply a window we never measured.
  const idle = usage.modelCalls === 0 && usage.toolCalls === 0;
  const pct =
    usage.contextWindow > 0
      ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))
      : null;

  const rows: Array<[string, string]> = [
    ["Model calls", usage.modelCalls.toLocaleString()],
    ["Tool calls", usage.toolCalls.toLocaleString()],
    ["Prompt characters", formatBytes(usage.promptChars)],
    ["Completion characters", formatBytes(usage.completionChars)],
    ["Context high-water", `${compactNumber.format(usage.contextTokens)} tokens`],
    [
      "Context window",
      usage.contextWindow > 0 ? `${compactNumber.format(usage.contextWindow)} tokens` : "unknown",
    ],
    ["Elapsed", formatDuration(usage.runningMs)],
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="h-[18px] gap-1.5 px-1.5 font-mono text-2xs"
          title="Local usage and context readout"
        >
          <Gauge className="h-3.5 w-3.5 text-muted-foreground/70" />
          {idle ? (
            <span className="text-muted-foreground/60">no usage yet</span>
          ) : (
            <>
              <span className="text-muted-foreground">
                {usage.contextWindow > 0
                  ? `${compactNumber.format(usage.contextTokens)}/${compactNumber.format(usage.contextWindow)}`
                  : compactNumber.format(usage.contextTokens)}
                {pct !== null && <span className="text-muted-foreground/60"> · {pct}%</span>}
              </span>
              <span className="text-muted-foreground/60">
                {usage.modelCalls.toLocaleString()} calls
              </span>
            </>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-64">
        <dl className="flex flex-col gap-1">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        <div aria-hidden className="mt-2 h-1 w-full overflow-hidden bg-chrome-sunken">
          <div className="h-full bg-primary" style={{ width: `${pct ?? 0}%` }} />
        </div>

        <p className="mt-2 text-muted-foreground/70">
          Measured locally — the provider's token counts are unreliable.
        </p>
      </PopoverContent>
    </Popover>
  );
}
