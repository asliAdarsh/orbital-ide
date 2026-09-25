/**
 * The documentation the launcher's **Learn** button opens.
 *
 * Served by the runtime rather than linked to a website: Orbital's whole surface is built to work
 * offline — bundled fonts, bundled editor, no CDN — and a help button that fails on a plane would
 * be the one part of it that does not. The backend reads the repository's own README, so the
 * documentation cannot drift from the project, and falls back to a built-in summary when the
 * README is not shipped beside the runtime.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ApiError, api } from "@/lib/api";
import { Markdown } from "@/components/common/Markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface LearnDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function LearnDialog({ open, onOpenChange }: LearnDialogProps) {
  const [docs, setDocs] = useState<{ markdown: string; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched when it is first opened rather than at boot: it is a few tens of kilobytes nobody
  // needs until they ask for it.
  useEffect(() => {
    if (!open || docs !== null) return;
    let cancelled = false;
    void api
      .docs()
      .then((response) => {
        if (!cancelled) setDocs(response);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? (cause.detail ?? cause.message) : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, docs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(52rem,92vw)]">
        <DialogHeader>
          <DialogTitle>Learn Orbital</DialogTitle>
          <DialogDescription>
            {docs?.source === "built-in"
              ? "The built-in guide: the five phases, how a run works, and where your projects live."
              : "The project's own documentation, served by the local runtime so it works offline."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[min(60vh,32rem)] rounded border border-border bg-background">
          <div className="p-4">
            {error ? (
              <p className="text-2xs leading-relaxed text-destructive">{error}</p>
            ) : docs ? (
              <Markdown>{docs.markdown}</Markdown>
            ) : (
              <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Loading the documentation…
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
