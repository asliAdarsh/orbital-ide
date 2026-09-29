/**
 * A project the account holds that is not on this machine.
 *
 * The record carries the title, the path, the last phase a machine saw and the run's artefacts.
 * What it does *not* carry is a folder, which is the whole reason these render apart from the
 * launcher's own cards: there is nothing here to open. Offering "Open" would either fail on a path
 * that does not exist or, worse, quietly create one — so the only thing these offer is a look at
 * what was recorded, and the path, so the reader knows where the folder is supposed to be.
 *
 * They are drawn with the same card and row shapes as the local projects so one list stays one
 * list, and marked as dashed and dimmed so the two are never confused at a glance.
 */

import { useState } from "react";
import { CloudOff, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  PROJECT_ARTEFACT_NAMES,
  type ProjectArtefactName,
  type SyncedProject,
} from "@/lib/firestore";
import { PHASE_SPECS } from "@/types/protocol";

/** The artefact names as a reader sees them, in the order the pipeline produces them. */
const ARTEFACT_LABELS: Record<ProjectArtefactName, string> = {
  plan: "Plan",
  agents: "Agents",
  report: "Test report",
};

/** A bare age, for the two places the sync reports a time. Epoch seconds in, words out. */
export function updatedLabel(seconds: number): string {
  const minutes = Math.round((Date.now() - seconds * 1000) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The phase's own title from the pipeline's list, or the raw id when it is not one this build knows. */
function phaseLabel(phase: string): string {
  const spec = PHASE_SPECS.find((entry) => (entry.id as string) === phase);
  return spec === undefined ? phase : spec.title;
}

/** One line of facts about the record: where it was left, and when it was stored. */
function recordSummary(project: SyncedProject): string {
  const phase = project.phase === "" ? null : phaseLabel(project.phase);
  const when = `synced ${updatedLabel(project.updatedAt)}`;
  return phase === null ? when : `${phase} · ${when}`;
}

/**
 * The recorded artefacts, one at a time, in a popover.
 *
 * A popover rather than a dialog because this is a glance, not a task — and the text is the run's
 * own, shown read-only: nothing here writes a file back onto a machine.
 */
function ArtefactMenu({ project }: { project: SyncedProject }) {
  const [open, setOpen] = useState(false);
  const present = PROJECT_ARTEFACT_NAMES.filter((name) => project.artefacts[name] !== undefined);

  if (present.length === 0) {
    return <span className="text-2xs text-muted-foreground/50">No artefacts recorded</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-2xs font-normal text-muted-foreground hover:text-foreground"
        >
          <FileText aria-hidden className="h-3 w-3" />
          {present.length === 1 ? "1 artefact" : `${present.length} artefacts`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-96 w-96 overflow-auto p-3">
        {present.map((name) => (
          <div key={name} className="mb-3 last:mb-0">
            <p className="mb-1 text-2xs font-medium text-foreground">{ARTEFACT_LABELS[name]}</p>
            <pre className="whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-2xs leading-relaxed text-muted-foreground">
              {project.artefacts[name]}
            </pre>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The grid shape: the same block a local project takes, marked as not being here. */
export function SyncedProjectCard({ project }: { project: SyncedProject }) {
  return (
    <li
      className="flex animate-fade-in flex-col overflow-hidden rounded border border-dashed border-border bg-chrome/50"
      data-synced-project={project.documentId}
    >
      <div className="flex aspect-[4/3] items-center justify-center border-b border-border bg-chrome text-muted-foreground/40">
        <CloudOff aria-hidden className="h-5 w-5" />
        <span className="sr-only">Synced on your account; not on this machine</span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-3 py-2">
        <span className="truncate text-xs font-medium text-foreground">{project.title}</span>
        <span className="truncate font-mono text-2xs text-muted-foreground/80" title={project.path}>
          {project.path}
        </span>
        <span className="text-2xs text-muted-foreground/70">{recordSummary(project)}</span>
        <div className="mt-auto pt-1">
          <ArtefactMenu project={project} />
        </div>
      </div>
    </li>
  );
}

/** The list shape: same facts on one line, with nothing that looks like an open action. */
export function SyncedProjectRow({ project }: { project: SyncedProject }) {
  return (
    <li
      className="flex animate-fade-in items-center gap-3 border-b border-border border-dashed px-3 py-2 last:border-b-0"
      data-synced-project={project.documentId}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-chrome text-muted-foreground/50">
        <CloudOff aria-hidden className="h-3.5 w-3.5" />
      </span>
      <span className="flex w-40 shrink-0 items-center gap-1.5 text-xs text-foreground">
        <span className="truncate">{project.title}</span>
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={project.path}>
        {project.path}
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-2xs text-muted-foreground lg:block">
        Not on this machine
      </span>
      <span className="shrink-0 text-2xs text-muted-foreground/70">{recordSummary(project)}</span>
      <ArtefactMenu project={project} />
    </li>
  );
}
