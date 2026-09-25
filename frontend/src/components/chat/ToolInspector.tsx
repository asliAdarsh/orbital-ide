import { useState } from "react";
import { Check, ChevronDown, ChevronRight, LoaderCircle, TriangleAlert, Wrench } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { SectionLabel } from "@/components/common/SectionLabel";
import { cn, formatDuration } from "@/lib/utils";
import type { ToolCall, ToolResult } from "@/types/protocol";

export interface ToolInspectorProps {
  /** Newest first, matching the store's ordering. */
  calls: ToolCall[];
  results: Record<string, ToolResult>;
  className?: string;
}

const MAX_OUTPUT_LINES = 40;

interface ToolRowProps {
  call: ToolCall;
  result: ToolResult | undefined;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function ToolRow({ call, result, expanded, onToggle }: ToolRowProps) {
  const [showAll, setShowAll] = useState(false);
  const failed = result !== undefined && !result.ok;
  const outputLines = result?.output ? result.output.split("\n") : [];

  return (
    <div
      className={cn(
        "border-b border-border",
        failed && "bg-destructive/10",
        result === undefined && "animate-rail-pulse",
      )}
    >
      <button
        type="button"
        onClick={() => {
          onToggle(call.id);
        }}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
          {call.name}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">{call.agent}</span>
        {result ? (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {formatDuration(result.durationMs)}
          </span>
        ) : null}
        {result === undefined ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <TriangleAlert className="size-3 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3 shrink-0 text-primary" />
        )}
      </button>
      {expanded ? (
        <div className="space-y-2 px-2 pb-2">
          <pre className="overflow-x-auto rounded border border-border bg-chrome-sunken p-2 font-mono text-2xs">
            {JSON.stringify(call.args, null, 2)}
          </pre>
          {result === undefined ? (
            <p className="text-2xs text-muted-foreground">running</p>
          ) : (
            <>
              {result.error ? (
                <p className="whitespace-pre-wrap text-2xs text-destructive">{result.error}</p>
              ) : null}
              {outputLines.length > 0 ? (
                <pre className="overflow-x-auto rounded border border-border bg-chrome-sunken p-2 font-mono text-2xs">
                  {(showAll ? outputLines : outputLines.slice(0, MAX_OUTPUT_LINES)).join("\n")}
                </pre>
              ) : null}
              {outputLines.length > MAX_OUTPUT_LINES ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowAll((prev) => !prev);
                  }}
                  className="text-2xs text-accent hover:underline"
                >
                  {showAll ? "show less" : `show all ${outputLines.length} lines`}
                </button>
              ) : null}
              {result.truncated ? (
                <p className="text-2xs text-muted-foreground">output clipped by the backend</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ToolInspector({ calls, results, className }: ToolInspectorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <SectionLabel
        right={<span className="text-2xs text-muted-foreground">{calls.length}</span>}
      >
        Live Tool Execution
      </SectionLabel>
      {calls.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No tool activity"
          hint="Tool calls from the running agent appear here."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {calls.map((call) => (
            <ToolRow
              key={call.id}
              call={call}
              result={results[call.id]}
              expanded={expandedId === call.id}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
