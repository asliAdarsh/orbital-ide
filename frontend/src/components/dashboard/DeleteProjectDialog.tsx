/**
 * Delete a project's folder, or merely drop it from Orbital's list.
 *
 * Two outcomes share one dialog because they are easily confused and the difference is whether the
 * user's files survive: the destructive button is explicit about deleting the folder and its
 * contents, and the path is printed so a wrong pick is noticed before the click. The softer
 * "remove from list" escape hatch exists so nobody deletes a folder trying to tidy the launcher.
 */

import { useState } from "react";

import { api, errorMessage } from "@/lib/api";
import type { ProjectEntry } from "@/types/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface DeleteProjectDialogProps {
  /** The project being deleted; `null` keeps the dialog closed. */
  project: ProjectEntry | null;
  onOpenChange(open: boolean): void;
  /** Called once the folder and its files are gone. */
  onDeleted(): void;
  /** Called after the entry was dropped from the list; nothing on disk was touched. */
  onRemoved(): void;
}

export function DeleteProjectDialog({
  project,
  onOpenChange,
  onDeleted,
  onRemoved,
}: DeleteProjectDialogProps) {
  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      {/* Keyed by id so a failure message from one project never appears over another's dialog. */}
      {project ? (
        <DeleteProjectForm
          key={project.id}
          project={project}
          onOpenChange={onOpenChange}
          onDeleted={onDeleted}
          onRemoved={onRemoved}
        />
      ) : null}
    </Dialog>
  );
}

interface DeleteProjectFormProps {
  project: ProjectEntry;
  onOpenChange(open: boolean): void;
  onDeleted(): void;
  onRemoved(): void;
}

function DeleteProjectForm({
  project,
  onOpenChange,
  onDeleted,
  onRemoved,
}: DeleteProjectFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"delete" | "remove" | null>(null);

  const handleDelete = async () => {
    setBusy("delete");
    setError(null);
    try {
      await api.deleteProject(project.id, true);
      onDeleted();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    setBusy("remove");
    setError(null);
    try {
      await api.deleteProject(project.id, false);
      onRemoved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <DialogContent className="w-[min(30rem,92vw)]">
      <DialogHeader>
        <DialogTitle>Delete “{project.name}”?</DialogTitle>
        <DialogDescription>
          The folder below and everything inside it is permanently deleted. This cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <p className="break-all rounded border border-border bg-chrome-sunken px-2 py-1.5 font-mono text-2xs text-foreground">
          {project.path}
        </p>

        <div className="flex flex-col gap-2 rounded border border-border bg-chrome-raised p-2">
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Only want it gone from Orbital's list? Removing leaves the folder exactly as it is.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            loading={busy === "remove"}
            disabled={busy !== null}
            onClick={() => void handleRemove()}
          >
            Remove from list instead
          </Button>
        </div>

        {error ? <p className="text-2xs leading-relaxed text-destructive">{error}</p> : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          loading={busy === "delete"}
          disabled={busy !== null}
          onClick={() => void handleDelete()}
        >
          Delete project and files
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
