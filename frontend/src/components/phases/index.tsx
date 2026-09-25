import { useAgentSocket } from "@/hooks/useAgentSocket";
import { PHASE_PROMPTS } from "@/lib/phase-prompts";
import { PHASE_SPECS } from "@/types/protocol";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/components/common/Toaster";
import { BuildPhase } from "@/components/phases/BuildPhase";
import { DesignPhase } from "@/components/phases/DesignPhase";
import { PhaseGate } from "@/components/phases/PhaseGate";
import { PlanPhase } from "@/components/phases/PlanPhase";
import { SyncPhase } from "@/components/phases/SyncPhase";
import { TestPhase } from "@/components/phases/TestPhase";

export { BuildPhase } from "@/components/phases/BuildPhase";
export { DesignPhase } from "@/components/phases/DesignPhase";
export { PlanPhase } from "@/components/phases/PlanPhase";
export { SyncPhase } from "@/components/phases/SyncPhase";
export { TestPhase } from "@/components/phases/TestPhase";

export function PhaseCanvas() {
  const activePhase = useAppStore((s) => s.activePhase);
  const running = useAppStore((s) => s.running);
  const projectPath = useAppStore((s) => s.project?.projectPath ?? null);
  const socket = useAgentSocket();

  const handleRun = (prompt: string) => {
    if (!projectPath) {
      toast.error("Open a folder before running a phase.");
      return;
    }
    // The auto-advance preference decides whether the pipeline continues past this phase.
    socket.run(activePhase, prompt, projectPath);
  };

  // Moving on is the user's call, made from the phase they have just read: the next phase starts
  // without auto-advance, so it stops again for its own review.
  const position = PHASE_SPECS.findIndex((info) => info.id === activePhase);
  const next = position >= 0 ? (PHASE_SPECS[position + 1] ?? null) : null;
  const handleAdvance = next
    ? () => {
        if (!projectPath) {
          toast.error("Open a folder before running a phase.");
          return;
        }
        socket.run(next.id, PHASE_PROMPTS[next.id], projectPath, false);
      }
    : null;

  const body = (() => {
    switch (activePhase) {
      case "plan":
        return (
          <PlanPhase
            onRun={handleRun}
            onCancel={() => socket.cancel()}
            running={running}
            nextPhase={next ?? null}
            onAdvance={handleAdvance}
          />
        );
      case "design":
        return (
          <DesignPhase
            onRun={handleRun}
            onCancel={() => socket.cancel()}
            running={running}
            nextPhase={next ?? null}
            onAdvance={handleAdvance}
          />
        );
      case "build":
        return <BuildPhase onRun={handleRun} onCancel={() => socket.cancel()} running={running} />;
      case "test":
        return <TestPhase onRun={handleRun} onCancel={() => socket.cancel()} running={running} />;
      case "sync":
        return <SyncPhase onRun={handleRun} onCancel={() => socket.cancel()} running={running} />;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{body}</div>
      <PhaseGate />
    </div>
  );
}
