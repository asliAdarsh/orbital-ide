import { useAppStore, type LogLevel } from "@/store/app-store";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { usePanelSize } from "@/hooks/usePanelSize";
import { PHASE_SPECS } from "@/types/protocol";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentChat } from "@/components/chat/AgentChat";
import { AgentRoster } from "@/components/chat/AgentRoster";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { ToolInspector } from "@/components/chat/ToolInspector";
import { toast } from "@/components/common/Toaster";

const LOG_LEVEL_CLASS: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-phase-test",
  error: "text-destructive",
};

const MAX_LOG_ROWS = 500;

const MIN_WIDTH = 260;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 340;

export function RightSidebar() {
  const activePhase = useAppStore((s) => s.activePhase);
  const messages = useAppStore((s) => s.messages);
  const running = useAppStore((s) => s.running);
  const toolCalls = useAppStore((s) => s.toolCalls);
  const toolResults = useAppStore((s) => s.toolResults);
  const logs = useAppStore((s) => s.logs);
  const approvals = useAppStore((s) => s.approvals);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const noteApprovalDecision = useAppStore((s) => s.noteApprovalDecision);
  const socket = useAgentSocket();

  const { size: width, handleProps } = usePanelSize({
    storageKey: "orbital.rightSidebarWidth",
    initial: DEFAULT_WIDTH,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    grow: "left",
    label: "right sidebar",
  });

  const activeAgent = PHASE_SPECS.find((info) => info.id === activePhase)?.agent ?? "orchestrator";

  // Plan and design are worked out in conversation — the architect researches, plans and revises
  // both as you talk — so that is the side the composer starts on there. The phases that build,
  // test and push are runs, and start on Build. Either can be chosen per message; this is only the
  // default.
  const defaultMode: "plan" | "build" =
    activePhase === "plan" || activePhase === "design" ? "plan" : "build";
  const composerPlaceholder =
    activePhase === "plan"
      ? "Describe what you want to build…"
      : activePhase === "design"
        ? "Ask for a new screen or a change to one…"
        : undefined;

  const submit = (content: string, build: boolean) => {
    const prompt = content.trim();
    if (!prompt) return;
    if (!projectPath) {
      toast.error("Open a folder before starting a run.");
      return;
    }
    // The socket layer records the user's turn for both paths; adding it here as well put two
    // identical bubbles in the transcript for every send.
    if (build) socket.run(activePhase, prompt, projectPath);
    else socket.chat(activePhase, prompt, projectPath);
  };

  const recentLogs = logs.slice(-MAX_LOG_ROWS);

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-chrome"
    >
      {/* Sits astride the border so the grab target is wider than the line itself. */}
      <div {...handleProps} className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary" />
      </div>
      <Tabs defaultValue="agent" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0">
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col">
          <AgentRoster activeAgent={activeAgent} phase={activePhase} />
          <AgentChat
            messages={messages}
            running={running}
            onSend={(content) => submit(content, false)}
            onBuild={(content) => submit(content, true)}
            defaultMode={defaultMode}
            onCancel={() => socket.cancel()}
            approvals={approvals}
            onApprove={(requestId, approved, remember) => {
              // The card records the decision locally so its buttons settle immediately; the
              // frame carries the same answer back so the waiting tool can resume.
              noteApprovalDecision(requestId, approved);
              socket.approve(requestId, approved, remember);
            }}
            className="min-h-0 flex-1"
            toolbar={<ModelPicker />}
            placeholder={composerPlaceholder}
            disabled={projectPath === null}
            disabledReason="Open a folder to start a run."
          />
        </TabsContent>

        <TabsContent value="tools" className="min-h-0 flex-1">
          <ToolInspector calls={toolCalls} results={toolResults} className="h-full" />
        </TabsContent>

        <TabsContent value="logs" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {recentLogs.length === 0 ? (
              <p className="px-3 py-2 text-2xs text-muted-foreground">No log entries yet.</p>
            ) : (
              recentLogs.map((entry, index) => (
                <div
                  key={`${entry.ts}-${index}`}
                  className={cn("flex gap-2 border-b border-border px-3 py-1 font-mono text-2xs", LOG_LEVEL_CLASS[entry.level])}
                >
                  <span className="shrink-0 text-muted-foreground">{new Date(entry.ts).toLocaleTimeString()}</span>
                  <span className="min-w-0 break-words">{entry.message}</span>
                </div>
              ))
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
