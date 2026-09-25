/**
 * Edit a registered project's name, description, repository and branching strategy.
 *
 * A dialog rather than inline editing in the card because this changes Orbital's own record, not
 * the folder — the distinction the description spells out, since a rename here deliberately does
 * not touch the directory on disk.
 */

import { useState } from "react";

import { api, errorMessage } from "@/lib/api";
import type { ProjectEntry } from "@/types/protocol";
import { RepositoryFields } from "@/components/dashboard/RepositoryFields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const LABEL = "block text-2xs text-muted-foreground";

export interface EditProjectDialogProps {
  /** The project being edited; `null` keeps the dialog closed. */
  project: ProjectEntry | null;
  onOpenChange(open: boolean): void;
  /** Called once the registry accepted the change, so the caller can refresh its list. */
  onSaved(): void;
}

export function EditProjectDialog({ project, onOpenChange, onSaved }: EditProjectDialogProps) {
  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      {/* Keyed by id so switching projects — or reopening — never seeds the form from the last one. */}
      {project ? (
        <EditProjectForm
          key={project.id}
          project={project}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      ) : null}
    </Dialog>
  );
}

interface EditProjectFormProps {
  project: ProjectEntry;
  onOpenChange(open: boolean): void;
  onSaved(): void;
}

function EditProjectForm({ project, onOpenChange, onSaved }: EditProjectFormProps) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [repository, setRepository] = useState(project.repository ?? "");
  const [strategy, setStrategy] = useState<string | null>(project.branchStrategy);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasRepository = repository.trim().length > 0;
  // Same rule the backend enforces on the resulting pair, checked here so the button never offers
  // a repository with no strategy to follow.
  const canSave = name.trim().length > 0 && !saving && (!hasRepository || strategy !== null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateProject(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        // An emptied field detaches the project from its remote, which takes the strategy with it.
        // The trim leaves "" in that case on purpose: the backend reads "" there as "clear", and
        // `null` as "not sent".
        repository: repository.trim(),
        branchStrategy: strategy,
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-h-[88vh] w-[min(34rem,92vw)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Edit project</DialogTitle>
        <DialogDescription>
          This changes Orbital's record of the project — its name, description, repository and branch
          model — not the folder on disk.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <p className="break-all font-mono text-2xs text-muted-foreground">{project.path}</p>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-app"
            className="h-7 font-mono text-2xs"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Description (optional)</span>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this project is for"
            rows={3}
            className="font-mono text-2xs"
          />
        </label>

        <RepositoryFields
          repository={repository}
          strategy={strategy}
          onChange={({ repository: next, strategy: nextStrategy }) => {
            setRepository(next);
            setStrategy(nextStrategy);
          }}
        />

        {error ? <p className="text-2xs leading-relaxed text-destructive">{error}</p> : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button size="sm" loading={saving} disabled={!canSave} onClick={() => void handleSave()}>
          Save changes
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
