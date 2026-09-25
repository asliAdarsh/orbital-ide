/**
 * The repository and branching-strategy fields, shared by the create and the edit project dialogs.
 *
 * One component for both because the two values are validated as a pair — a repository is only ever
 * saved with a strategy — and two copies of that rule would drift apart. The strategy list itself
 * comes from the backend, so the UI can never offer an id the agents do not know how to follow.
 */

import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import type { BranchStrategyInfo } from "@/types/protocol";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface RepositoryFieldsValue {
  /** Raw text, trimmed by the dialog on submit. */
  repository: string;
  strategy: string | null;
}

export interface RepositoryFieldsProps {
  repository: string;
  strategy: string | null;
  onChange(next: RepositoryFieldsValue): void;
}

export function RepositoryFields({ repository, strategy, onChange }: RepositoryFieldsProps) {
  const [strategies, setStrategies] = useState<BranchStrategyInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasRepository = repository.trim().length > 0;

  // Load the catalogue once per mount, the first time a repository appears: an empty field costs
  // no request, and a failure is not retried on every keystroke.
  useEffect(() => {
    if (!hasRepository || strategies !== null || loadError !== null) return;
    let cancelled = false;
    void api
      .branchStrategies()
      .then((list) => {
        if (!cancelled) setStrategies(list);
      })
      .catch((cause: unknown) => {
        // An unreachable catalogue must not trap the user in the dialog: the field stays editable
        // and the backend still has the final say on whatever the pair turns out to be.
        if (!cancelled) setLoadError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [hasRepository, strategies, loadError]);

  const handleRepository = (value: string) => {
    // Clearing the remote clears the strategy with it: a strategy without a repository is refused.
    onChange({ repository: value, strategy: value.trim() ? strategy : null });
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          Repository (optional)
        </span>
        <Input
          value={repository}
          onChange={(event) => handleRepository(event.target.value)}
          placeholder="https://github.com/you/repo.git"
          className="h-7 font-mono text-2xs"
        />
        <span className="text-2xs leading-relaxed text-muted-foreground">
          The agents set this remote and work to the branches below.
        </span>
      </label>

      {hasRepository ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">Branching strategy</span>
          {loadError ? <p className="text-2xs leading-relaxed text-destructive">{loadError}</p> : null}
          {strategies ? (
            <div role="radiogroup" aria-label="Branching strategy" className="flex flex-col gap-1.5">
              {strategies.map((option) => {
                const selected = option.id === strategy;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onChange({ repository, strategy: option.id })}
                    className={cn(
                      "flex flex-col gap-0.5 rounded border border-border px-2 py-1.5 text-left transition-colors hover:bg-chrome-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                      selected && "border-primary/50 bg-primary/10",
                    )}
                  >
                    <span className="text-2xs font-medium text-foreground">{option.label}</span>
                    <span className="text-2xs leading-relaxed text-muted-foreground">{option.summary}</span>
                    <span className="font-mono text-2xs text-muted-foreground">{option.branches}</span>
                    <span className="text-2xs leading-relaxed text-muted-foreground">{option.workflow}</span>
                  </button>
                );
              })}
            </div>
          ) : loadError ? null : (
            <p className="text-2xs leading-relaxed text-muted-foreground">Loading strategies…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
