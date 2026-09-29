/**
 * The composer's slash-command palette, and the `/help` window that shows the same catalogue.
 *
 * Commands are typed in the composer, so the palette itself never takes focus: in "commands" mode
 * the textarea is the filter box and arrow/enter/escape arrive through {@link SlashPaletteHandle}.
 * `/agents` and `/skill` cannot be filtered that way — what they list is not a command — so they
 * switch the panel into their own mode with their own filter box, which does take focus.
 *
 * The list and `/help` are rendered from one catalogue ({@link SLASH_COMMANDS}), which is what keeps
 * the two from ever describing the command set differently.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState, useCallback, forwardRef, type ReactNode } from "react";
import { Check, FileText, Folder, Sparkles, Terminal } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import { fuzzyScore } from "@/lib/composer-triggers";
import { SLASH_COMMANDS, type SlashCommand } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/store/app-store";
import { PHASE_SPECS, type Phase, type SkillInfo } from "@/types/protocol";

export type PaletteMode = "commands" | "agents" | "skills";

export interface SlashPaletteHandle {
  /** True when the keystroke belonged to the palette, so the composer must not act on it. */
  handleKeyDown(event: React.KeyboardEvent<HTMLElement>): boolean;
}

export interface SlashPaletteProps {
  mode: PaletteMode;
  /** Commands mode: what was typed after the slash. The sub-modes filter with their own box. */
  query: string;
  onRun(command: SlashCommand): void;
  /** A phase, and with it the specialist the chat then talks to. */
  onPickAgent(phase: Phase): void;
  onPickSkill(skill: SkillInfo): void;
  onClose(): void;
}

/** One row of the palette, whatever mode produced it. */
interface Row {
  key: string;
  /** The label, shown in the composer's font; a command is quoted as it would be typed. */
  label: string;
  description: string;
  icon: ReactNode;
  selected?: boolean;
  act(): void;
}

export const SlashPalette = forwardRef<SlashPaletteHandle, SlashPaletteProps>(function SlashPalette(
  { mode, query, onRun, onPickAgent, onPickSkill, onClose },
  ref,
) {
  // The sub-modes' own filter text; commands mode filters on the composer's `query` instead.
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const activePhase = useAppStore((store) => store.activePhase);
  // A workspace skill id is only unique within its workspace, so the list and the body are read for
  // the chat's workspace — which is not the open project when the panel is on another folder's chat.
  const chatWorkspace = useAppStore(
    (store) => store.chats.find((chat) => chat.id === store.activeChatId)?.workspace ?? store.project?.projectPath ?? null,
  );

  useEffect(() => {
    // Each entry into a mode starts from the whole list rather than the last search.
    setFilter("");
    setHighlight(0);
  }, [mode]);

  useEffect(() => {
    // Focus the moment the panel becomes the thing being typed into; commands mode deliberately
    // leaves the caret in the composer. Focusing on a mode change too, so `/agents` then typing
    // filters the specialists.
    if (mode !== "commands") filterRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== "skills") return;
    let live = true;
    setSkillsError(null);
    void api.skills(chatWorkspace).then(
      (response) => {
        if (live) setSkills(response.skills);
      },
      (cause: unknown) => {
        if (!live) return;
        setSkillsError(errorMessage(cause, "The skills could not be listed."));
        setSkills([]);
      },
    );
    return () => {
      live = false;
    };
  }, [mode, chatWorkspace]);

  const rows = useMemo<Row[]>(() => {
    if (mode === "commands") {
      const scored = SLASH_COMMANDS.map((command) => ({
        command,
        score: fuzzyScore(query.trim(), command.id),
      }))
        .filter((entry): entry is { command: SlashCommand; score: number } => entry.score !== null)
        .sort((a, b) => b.score - a.score);
      return scored.map(({ command }) => ({
        key: command.id,
        label: `/${command.id}${command.argument ? " …" : ""}`,
        description: command.description,
        icon: <Terminal className="size-3 shrink-0 text-muted-foreground" aria-hidden />,
        act: () => onRun(command),
      }));
    }
    if (mode === "agents") {
      return PHASE_SPECS.map((spec) => ({
        key: spec.id,
        label: spec.title,
        description: `${spec.agent} · ${spec.description}`,
        icon: <Sparkles className="size-3 shrink-0 text-phase-design" aria-hidden />,
        // Which specialist the chat is on now, so picking a different one is a visible change.
        selected: spec.id === activePhase,
        act: () => onPickAgent(spec.id),
      })).filter((row) => fuzzyScore(filter.trim(), `${row.label} ${row.description}`) !== null);
    }
    return (skills ?? [])
      .map((skill) => ({
        key: skill.id,
        label: skill.name,
        description: skill.description || `${skill.source} skill`,
        icon:
          skill.source === "workspace" ? (
            <Folder className="size-3 shrink-0 text-phase-design" aria-hidden />
          ) : (
            <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          ),
        act: () => onPickSkill(skill),
      }))
      .filter((row) => fuzzyScore(filter.trim(), `${row.label} ${row.description}`) !== null);
  }, [mode, query, filter, skills, activePhase, onRun, onPickAgent, onPickSkill]);

  useEffect(() => {
    setHighlight(0);
  }, [rows.length]);

  const active = rows[Math.min(highlight, Math.max(0, rows.length - 1))] ?? null;

  /**
   * One key handler for both places keys arrive from: the composer forwards the textarea's keys
   * here, and the sub-modes' own filter box calls this directly. Two implementations would be two
   * answers to "what does Enter do here".
   */
  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return true;
      }
      if (rows.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + rows.length) % rows.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (active) active.act();
        return true;
      }
      return false;
    },
    [rows.length, active, onClose],
  );

  useImperativeHandle(ref, () => ({ handleKeyDown: handleKey }), [handleKey]);

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 right-0 z-40 mb-1 max-h-72 overflow-y-auto border border-border bg-popover"
    >
      {mode !== "commands" ? (
        <div className="border-b border-border p-1">
          <Input
            ref={filterRef}
            value={filter}
            aria-label={mode === "agents" ? "Filter specialists" : "Filter skills"}
            placeholder={mode === "agents" ? "Filter specialists…" : "Filter skills…"}
            onChange={(event) => setFilter(event.target.value)}
            // The same handler the composer forwards: one palette, one set of keys.
            onKeyDown={handleKey}
            className="h-6 text-2xs"
          />
        </div>
      ) : null}

      {mode === "skills" && skills === null ? (
        <p className="px-2 py-1 font-mono text-2xs text-muted-foreground">loading skills…</p>
      ) : skillsError !== null ? (
        <p className="px-2 py-1 text-2xs text-destructive">{skillsError}</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-1 font-mono text-2xs text-muted-foreground">
          {mode === "commands" ? `no command matches /${query.trim()}` : "nothing matches"}
        </p>
      ) : (
        rows.map((row, index) => (
          <button
            key={row.key}
            type="button"
            role="option"
            aria-selected={index === highlight}
            // Focus stays where the user is typing; a click that moved it would break the next key.
            onMouseDown={(event) => event.preventDefault()}
            onClick={row.act}
            onMouseEnter={() => setHighlight(index)}
            className={cn(
              "flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs transition-colors",
              index === highlight ? "bg-chrome-raised" : "hover:bg-chrome-raised",
            )}
          >
            {row.icon}
            <span className="shrink-0 font-mono text-foreground">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.description}</span>
            {row.selected ? <Check className="size-3 shrink-0 text-primary" aria-hidden /> : null}
          </button>
        ))
      )}
      {mode !== "commands" ? (
        <p className="border-t border-border px-2 py-1 text-muted-foreground">
          Enter picks; Escape closes.
        </p>
      ) : null}
    </div>
  );
});

/** The same catalogue, outside the palette: what `/help` opens. */
export function SlashHelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Composer commands</DialogTitle>
          <DialogDescription>
            Type one at the start of the message. A command with … takes the rest of the line as its
            argument.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          {SLASH_COMMANDS.map((command) => (
            <div key={command.id} className="flex items-baseline gap-2 border-b border-border py-1 last:border-b-0">
              <span className="w-24 shrink-0 font-mono text-2xs text-foreground">
                /{command.id}
                {command.argument ? " …" : ""}
              </span>
              <span className="min-w-0 flex-1 text-2xs leading-relaxed text-muted-foreground">
                {command.description}
              </span>
            </div>
          ))}
        </div>
        <Button size="xs" variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
