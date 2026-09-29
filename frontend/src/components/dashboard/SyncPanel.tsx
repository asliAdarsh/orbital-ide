/**
 * The account row on the launcher: who is signed in, what the account holds, and the one control
 * that moves the list.
 *
 * It is deliberately a block of text with a button in it rather than a status banner: syncing is an
 * addition to this screen, never a state of it, so nothing here spins over the list, covers it or
 * asks for a decision. A failure is a sentence in the same small type as the project count, and the
 * launcher keeps working exactly as it did.
 *
 * The account itself comes from `useAuth`, the same source the account popover uses — this panel
 * does not take a uid and hand it back, because there is nothing to coordinate: one subscriber,
 * one answer.
 */

import { CloudUpload, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { updatedLabel } from "@/components/dashboard/SyncedProject";
import { useAuth } from "@/hooks/useAuth";
import type { ProjectSyncApi } from "@/hooks/useProjectSync";

export function SyncPanel({ sync }: { sync: ProjectSyncApi }) {
  const { user } = useAuth();
  const account = user?.email ?? user?.uid ?? null;

  /** The facts about the account's list, once there is a list to describe. */
  const tally =
    sync.lastSyncedAt === null
      ? "Reading the account's projects…"
      : `${sync.syncedCount} ${sync.syncedCount === 1 ? "project" : "projects"} synced · ${updatedLabel(
          sync.lastSyncedAt / 1000,
        )}`;

  return (
    <div className="flex flex-col gap-1 border-t border-border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <CloudUpload aria-hidden className="h-3.5 w-3.5" />
          Sync
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={sync.syncNow}
          disabled={sync.syncing || sync.unavailable !== null}
          aria-label="Sync now"
          title="Sync now"
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>

      <p className="truncate text-2xs text-muted-foreground/80" title={account ?? undefined}>
        {account ?? "No account"}
      </p>

      {sync.unavailable === null ? (
        <p className="text-2xs leading-relaxed text-muted-foreground/60">
          {sync.syncing ? "Syncing…" : tally}
        </p>
      ) : (
        <p className="text-2xs leading-relaxed text-muted-foreground/60">{sync.unavailable}</p>
      )}

      {/* What the last one did, in its own line: a tally says how much is there, this says what
          moved, and a failure takes its place rather than hiding under it. */}
      {sync.error !== null ? (
        <p className="text-2xs leading-relaxed text-destructive">{sync.error}</p>
      ) : sync.result === null ? null : (
        <p className="text-2xs leading-relaxed text-muted-foreground/60">{sync.result}</p>
      )}

      {/* Per-project reasons — an artefact over the cap, a record kept as it was. Quiet, but never
          silent: a skipped file is the one thing a reader could otherwise not find out. */}
      {sync.notes.map((note) => (
        <p key={note} className="text-2xs leading-relaxed text-muted-foreground/60">
          {note}
        </p>
      ))}
    </div>
  );
}
