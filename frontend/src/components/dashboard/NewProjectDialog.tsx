/**
 * Create a project: choose where it goes, name it, say what it is for, and — when it is tied to a
 * Git repository — pick the branch model its agents follow.
 *
 * A dialog rather than a panel in the launcher because creating is a one-off errand — a few fields
 * and a directory chooser — and a launcher that permanently spends a third of its width on a form
 * for it cannot show the projects themselves as the main thing.
 */

import { useState } from "react";
import { FolderOpen } from "lucide-react";

import { chooseFolderPath } from "@/hooks/useOpenProject";
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

export interface NewProjectDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Called with the registered project once the folder exists and the registry knows it. */
  onCreated(project: ProjectEntry): void;
}

export function NewProjectDialog({ open, onOpenChange, onCreated }: NewProjectDialogProps) {
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repository, setRepository] = useState("");
  const [strategy, setStrategy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const hasRepository = repository.trim().length > 0;
  // The backend refuses a repository with no strategy, so the button never offers that pair: the
  // strategy chooser appears as soon as the field is typed in, and the user must pick one.
  const canCreate =
    directory.trim().length > 0 && name.trim().length > 0 && !creating && (!hasRepository || strategy !== null);

  const handleChoose = async () => {
    setError(null);
    try {
      const picked = await chooseFolderPath("Select the folder to create this project in");
      if (picked.path) {
        setDirectory(picked.path);
        return;
      }
      // A cancelled dialog is not an error, but a picker that could not run must say why.
      setError(picked.reason);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const project = await api.createProject({
        parent: directory.trim(),
        name: name.trim(),
        description: description.trim() || null,
        repository: repository.trim() || null,
        // Unreachable with a repository but no strategy — `canCreate` guards the button — and empty
        // without a repository, where the field has already cleared it.
        branchStrategy: strategy,
      });
      setDirectory("");
      setName("");
      setDescription("");
      setRepository("");
      setStrategy(null);
      onCreated(project);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The strategy chooser makes this dialog taller than the viewport on short screens; the
          content scrolls so the Create button never ends up off-screen. */}
      <DialogContent className="max-h-[88vh] w-[min(34rem,92vw)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            The folder is created inside the directory you choose, and added to this list.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Directory</span>
            <span className="flex items-center gap-2">
              <Input
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder={"C:\\path\\to\\projects"}
                className="h-7 flex-1 font-mono text-2xs"
              />
              <Button size="sm" variant="secondary" onClick={() => void handleChoose()}>
                <FolderOpen className="h-3.5 w-3.5" />
                Choose…
              </Button>
            </span>
          </label>

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
          <Button size="sm" loading={creating} disabled={!canCreate} onClick={() => void handleCreate()}>
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
