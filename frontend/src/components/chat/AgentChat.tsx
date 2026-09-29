import { useEffect, useRef, useState } from "react";
import { MessageSquare, Pause, Play, Send, Square } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import { findComposerTrigger } from "@/lib/composer-triggers";
import { commandById, type SlashCommand } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { COMPOSER_MODES, useAppStore, type ApprovalCard, type ComposerMode } from "@/store/app-store";
import { AttachmentChips, ComposerAttachments, MAX_ATTACHMENTS } from "@/components/chat/ComposerAttachments";
import { CapabilityDialog } from "@/components/chat/CapabilityDialog";
import { CommandApproval } from "@/components/chat/CommandApproval";
import { MentionPicker, type MentionPickerHandle } from "@/components/chat/MentionPicker";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PermissionPicker } from "@/components/chat/PermissionPicker";
import { ProviderModelPicker } from "@/components/chat/ProviderModelPicker";
import { SideAnswers } from "@/components/chat/SideAnswers";
import { SlashHelpDialog, SlashPalette, type PaletteMode, type SlashPaletteHandle } from "@/components/chat/SlashPalette";
import { TodoList } from "@/components/chat/TodoList";
import { EmptyState } from "@/components/common/EmptyState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/common/Toaster";
import { REASONING_EFFORTS, isReasoningEffort, type ChatMessage, type Phase, type SkillInfo } from "@/types/protocol";

export interface AgentChatProps {
  messages: ChatMessage[];
  running: boolean;
  /** The Plan path: a conversational turn with the phase's specialist. */
  onSend: (content: string) => void;
  onCancel: () => void;
  className?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Overrides the composer's default prompt text for this phase. */
  placeholder?: string;
  /** Commands the agent is holding for a decision, newest first. Omit to render no gate. */
  approvals?: ApprovalCard[];
  /** Reports the user's answer on a held command. Omit to render no gate. */
  onApprove?: (requestId: string, approved: boolean, remember: boolean) => void;
  /**
   * The Build path: run this phase for real. Omit where running makes no sense — the toggle then
   * states Plan rather than offering a Build button that does nothing.
   */
  onBuild?: (content: string) => void;
  /** Which side the composer starts on; the phase decides. A change re-defaults the toggle. */
  defaultMode?: ComposerMode;
}

/** Roughly six rows of the composer at its 22px line box. */
const COMPOSER_MAX_HEIGHT_PX = 132;

/**
 * The open palette: which list, what filters it, and the composer text it was opened from.
 *
 * `start`/`end` are the range of the typed trigger in the composer, so taking a command can remove
 * the `/word` it was chosen from instead of leaving it in the message. In the sub-modes the range is
 * empty — there is no trigger left to take back, because entering the mode removed it.
 */
interface PaletteState {
  mode: PaletteMode;
  query: string;
  start: number;
  end: number;
}

/** The `@` trigger currently open, and the range of composer text it covers. */
interface MentionState {
  query: string;
  start: number;
  end: number;
}

export function AgentChat({
  messages,
  running,
  onSend,
  onCancel,
  className,
  disabled,
  disabledReason,
  placeholder = "Describe what to build, or ask about the current phase",
  approvals,
  onApprove,
  onBuild,
  defaultMode,
}: AgentChatProps) {
  const [draft, setDraft] = useState("");
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<SlashPaletteHandle>(null);
  const mentionRef = useRef<MentionPickerHandle>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Single-field selectors: the composer re-renders for a new todo list, a new pick or a new
  // effort, and for nothing else the store holds.
  const todos = useAppStore((store) => store.todos);
  const tree = useAppStore((store) => store.tree);
  const attachments = useAppStore((store) => store.attachments);
  const reasoningEffort = useAppStore((store) => store.reasoningEffort);
  const setReasoningEffort = useAppStore((store) => store.setReasoningEffort);
  // The mode lives in the store because the capability defaults are per mode: switching sides here
  // is what reseeds what the agent may do, and the config dialog reads the same field.
  const mode = useAppStore((store) => store.composerMode);
  const applyCapabilityDefaults = useAppStore((store) => store.applyCapabilityDefaults);
  const attachContext = useAppStore((store) => store.attachContext);
  const detachContext = useAppStore((store) => store.detachContext);
  const clearContext = useAppStore((store) => store.clearContext);
  const sideAnswers = useAppStore((store) => store.sideAnswers);
  const dismissSideAnswer = useAppStore((store) => store.dismissSideAnswer);
  const paused = useAppStore((store) => store.paused);
  const activeChatId = useAppStore((store) => store.activeChatId);
  const activeFilePath = useAppStore((store) => store.activeFilePath);
  const activePhase = useAppStore((store) => store.activePhase);
  const setActivePhase = useAppStore((store) => store.setActivePhase);
  const createChat = useAppStore((store) => store.createChat);
  const clearChat = useAppStore((store) => store.clearChat);
  const renameChat = useAppStore((store) => store.renameChat);
  // A workspace skill id is unique only within its workspace, so the body is read for the chat's
  // workspace rather than for whatever folder happens to be open.
  const chatWorkspace = useAppStore(
    (store) => store.chats.find((chat) => chat.id === store.activeChatId)?.workspace ?? store.project?.projectPath ?? null,
  );
  const socket = useAgentSocket();
  const lastMessage = messages[messages.length - 1];
  const lastLength = lastMessage ? lastMessage.content.length : 0;
  const sendApproval = onApprove;
  // Each held command is paired with the call that answers it. Building the pair here is what
  // lets the gate render with a handler that is certainly defined — a card whose buttons called
  // nothing would be worse than no card at all.
  const held = (approvals ?? []).flatMap((request) =>
    sendApproval
      ? [
          {
            request,
            onDecide: (approved: boolean, remember: boolean) =>
              sendApproval(request.id, approved, remember),
          },
        ]
      : [],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, lastLength]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [draft]);

  // The phase is what picks the side, and a phase change is the only thing that moves
  // `defaultMode`: re-default with it instead of stranding the previous phase's choice here. The
  // store action is also what reseeds the capability defaults for the new mode.
  useEffect(() => {
    applyCapabilityDefaults(defaultMode ?? "plan");
  }, [defaultMode, applyCapabilityDefaults]);

  // Picking a mention with the mouse must not close the picker it is picking from.
  useEffect(() => {
    if (mention === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && composerRef.current?.contains(event.target)) return;
      setMention(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [mention]);

  /**
   * Decide what the caret is in, after every keystroke.
   *
   * Both lists are driven from the text alone, so a keystroke can open one, switch which one is
   * open, or close both — and closing on prose is what keeps a `/` typed mid-message from leaving a
   * palette hanging over the composer.
   */
  const syncTriggers = (value: string, caret: number) => {
    const trigger = findComposerTrigger(value, caret);
    if (trigger?.kind === "mention") {
      setPalette(null);
      setMention({ query: trigger.query, start: trigger.start, end: trigger.end });
      return;
    }
    if (trigger?.kind === "slash") {
      setMention(null);
      setPalette({ mode: "commands", query: trigger.query, start: trigger.start, end: trigger.end });
      return;
    }
    setMention(null);
    setPalette(null);
  };

  /** Replace the trigger the palette was opened from, if it is still in the composer. */
  const replaceTrigger = (text: string) => {
    if (palette === null) return;
    const { start, end } = palette;
    setDraft((current) => current.slice(0, start) + text + current.slice(end));
  };

  const startNewChat = async () => {
    // The new chat opens on the phase the composer is looking at, which is the specialist the user
    // was about to talk to.
    const created = await createChat({ phase: activePhase });
    if (created) await socket.openChat(created.id);
  };

  /**
   * `/explain`: name what the message is about and make sure it travels with it.
   *
   * Attachments are what the backend embeds, so the editor's own file is attached rather than
   * merely named — a prompt that says "this file" without carrying it explains nothing.
   */
  const composeExplain = () => {
    const alreadyAttached = attachments.length > 0;
    const targets = alreadyAttached
      ? attachments
      : activeFilePath !== null
        ? [activeFilePath]
        : [];
    if (targets.length === 0) {
      toast.error("Attach a file, or open one in the editor, then run /explain.");
      return;
    }
    if (!alreadyAttached) attachContext(targets[0]);
    setDraft(
      targets.length === 1
        ? `Explain ${targets[0]}: what it is responsible for, how it works, and anything surprising in it.`
        : `Explain these together — ${targets.join(", ")}. What is each responsible for, and how do they fit?`,
    );
  };

  const pickSkill = (skill: SkillInfo) => {
    setPalette(null);
    void api.skill(skill.id, chatWorkspace).then(
      ({ body }) => {
        // A skill is a prompt: its body becomes the message, ready to edit or to send as it is.
        setDraft(body);
      },
      (cause: unknown) => toast.error(errorMessage(cause, "The skill could not be read.")),
    );
  };

  /** Run a command. Commands that need an argument put themselves in the composer instead. */
  const runCommand = (command: SlashCommand, argument: string) => {
    if (command.argument) {
      replaceTrigger(`/${command.id} ${argument}`);
      setPalette(null);
      textareaRef.current?.focus();
      return;
    }
    switch (command.id) {
      case "model":
        replaceTrigger("");
        setPalette(null);
        setModelPickerOpen(true);
        return;
      case "agents":
        replaceTrigger("");
        // The panel switches lists rather than closing: what it shows is no longer a command.
        setPalette({ mode: "agents", query: "", start: 0, end: 0 });
        return;
      case "skill":
        replaceTrigger("");
        setPalette({ mode: "skills", query: "", start: 0, end: 0 });
        return;
      case "help":
        replaceTrigger("");
        setPalette(null);
        setHelpOpen(true);
        return;
      case "explain":
        replaceTrigger("");
        setPalette(null);
        composeExplain();
        return;
      case "new":
        replaceTrigger("");
        setPalette(null);
        void startNewChat();
        return;
      case "clear":
        replaceTrigger("");
        setPalette(null);
        if (activeChatId === null) {
          toast.error("No chat to clear.");
          return;
        }
        void clearChat(activeChatId).catch((cause: unknown) => toast.error(errorMessage(cause)));
        return;
      case "pause":
        replaceTrigger("");
        setPalette(null);
        socket.pause();
        return;
      case "resume":
        replaceTrigger("");
        setPalette(null);
        socket.resume();
        return;
      case "stop":
        replaceTrigger("");
        setPalette(null);
        onCancel();
        return;
    }
  };

  /** `/rename` and `/ask` are the two commands whose argument is the rest of the line. */
  const runCommandLine = (command: SlashCommand, argument: string) => {
    if (command.argument && argument === "") {
      // Nothing to act on yet: the command stays in the composer, with the trailing space that
      // makes the line read as "here comes the argument".
      setDraft(`/${command.id} `);
      textareaRef.current?.focus();
      return;
    }
    if (command.id === "ask") {
      setDraft("");
      const requestId = socket.ask(argument);
      // The frame never went out; the question stays in the composer rather than disappearing.
      if (requestId === null) setDraft(`/ask ${argument}`);
      return;
    }
    if (command.id === "rename") {
      if (activeChatId === null) {
        toast.error("No chat to rename.");
        setDraft(`/rename ${argument}`);
        return;
      }
      setDraft("");
      void renameChat(activeChatId, argument).catch((cause: unknown) => toast.error(errorMessage(cause)));
      return;
    }
    // A command that takes no argument, typed out by hand and submitted: run it as if picked.
    setDraft("");
    runCommand(command, "");
  };

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    const head = content.split(/\s+/, 1)[0];
    if (head.startsWith("/")) {
      const command = commandById(head.slice(1));
      if (command) {
        runCommandLine(command, content.slice(head.length).trim());
        return;
      }
    }
    if (running) return;
    setDraft("");
    // The message is going out, so the lists that were helping compose it have nothing left to
    // filter and must not be left hanging over an empty box.
    setMention(null);
    setPalette(null);
    // The socket reads the picks, the effort, the permission and the enabled capabilities off the
    // store as it builds the frame, so they are still in place while the handler runs and the picks
    // are dropped the moment it returns: a pick belongs to one message, and the chip disappearing
    // is the confirmation that it went.
    if (mode === "build" && onBuild) onBuild(content);
    else onSend(content);
    clearContext();
  };

  /** Add or remove a mention's path. The chip is the pick; the `@word` that produced it goes. */
  const toggleMention = (path: string) => {
    if (attachments.includes(path)) {
      detachContext(path);
      return;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast.warning(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      return;
    }
    attachContext(path);
    if (mention === null) return;
    const { start, end } = mention;
    setDraft((current) => current.slice(0, start) + current.slice(end));
    // The picker stays open on the workspace root, so one `@` can introduce several picks.
    setMention({ query: "", start, end: start });
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {messages.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No messages yet"
              hint="Describe the task, then run a phase to start the agents. Type / for commands, @ to attach a file."
            />
          ) : null}
          {/* Assistant prose is rendered as markdown inside MessageBubble's body. */}
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      {/*
        The gate sits between the transcript and the composer: the newest held command — the one
        needing an answer — is last, nearest the input. The stack is capped so a backlog of held
        commands scrolls here instead of squeezing the composer off-screen.
      */}
      {held.length > 0 ? (
        <div className="shrink-0 border-t border-border">
          <div className="max-h-[22rem] space-y-2 overflow-y-auto p-2">
            {[...held].reverse().map(({ request, onDecide }) => (
              <CommandApproval key={request.id} request={request} onDecide={onDecide} />
            ))}
          </div>
        </div>
      ) : null}
      {/* Side answers sit with the composer, not the transcript: they are about the turn in flight. */}
      <SideAnswers
        answers={sideAnswers}
        onDismiss={dismissSideAnswer}
        onCancel={socket.cancelAsk}
      />
      {disabled ? (
        <Alert className="m-2">
          <AlertTitle>Agent unavailable</AlertTitle>
          <AlertDescription>
            {disabledReason ?? "This session cannot run agents right now."}
          </AlertDescription>
        </Alert>
      ) : (
        // Relative, so the palettes can hang above the box the caret is in rather than over the
        // transcript they are choosing something for.
        <div ref={composerRef} className="relative border-t border-border p-2">
          {mention !== null ? (
            <MentionPicker
              ref={mentionRef}
              query={mention.query}
              selected={attachments}
              onToggle={toggleMention}
              onClose={() => setMention(null)}
            />
          ) : null}
          {palette !== null ? (
            <SlashPalette
              ref={paletteRef}
              mode={palette.mode}
              query={palette.query}
              onRun={(command) => runCommand(command, "")}
              onPickAgent={(phase: Phase) => {
                setActivePhase(phase);
                setPalette(null);
              }}
              onPickSkill={pickSkill}
              onClose={() => {
                setPalette(null);
                // Focus goes back to the caret: closing a list the composer opened must leave the
                // user where they were typing, not on the body.
                textareaRef.current?.focus();
              }}
            />
          ) : null}
          {/* Above the textarea, and capped, so unfolding it never pushes the transcript away. */}
          {todos.length > 0 ? <TodoList items={todos} running={running} className="mb-1.5" /> : null}
          {/* The picks sit against the caret: backspace at position 0 is what removes one. */}
          <AttachmentChips selected={attachments} onDetach={detachContext} />
          <Textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => {
              const { value, selectionStart } = event.target;
              setDraft(value);
              syncTriggers(value, selectionStart ?? value.length);
            }}
            onKeyDown={(event) => {
              // The lists are driven from the caret, so they see the key first: Enter picks a row
              // rather than sending, and Escape dismisses a list rather than the draft.
              if (mention !== null && mentionRef.current?.handleKeyDown(event)) return;
              if (palette !== null && paletteRef.current?.handleKeyDown(event)) return;
              if (event.key === "Backspace") {
                const { selectionStart, selectionEnd } = event.currentTarget;
                // The caret is against the chip row, so the only thing left of it is a chip.
                if (selectionStart === 0 && selectionEnd === 0 && attachments.length > 0) {
                  event.preventDefault();
                  detachContext(attachments[attachments.length - 1]);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-[30px] w-full resize-none text-xs"
          />
          {/*
            One wrapping row for every composer control: the mode, what to attach, the reasoning
            effort, the model, the permission and what the agent may do. At the sidebar's default
            width these do not fit on one line, and a wrapping row that flows across the full width
            is a line shorter than two fixed columns — the transcript keeps the difference.
          */}
          <div className="mt-1 flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1">
            {onBuild ? (
              <div
                role="group"
                aria-label="Composer mode"
                className="flex shrink-0 items-center rounded border border-border"
              >
                {COMPOSER_MODES.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={mode === option.id}
                    title={option.hint}
                    onClick={() => applyCapabilityDefaults(option.id)}
                    className={cn(
                      "h-6 px-2 text-2xs text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary/10 aria-pressed:text-foreground",
                      index > 0 && "border-l border-border",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              // No Build handler: one stated mode instead of a button that would do nothing.
              <span
                title={COMPOSER_MODES[0].hint}
                className="flex h-6 shrink-0 items-center rounded border border-border bg-primary/10 px-2 text-2xs text-foreground"
              >
                {COMPOSER_MODES[0].label}
              </span>
            )}
            <ComposerAttachments
              tree={tree}
              selected={attachments}
              onAttach={attachContext}
              onDetach={detachContext}
            />
            <select
              aria-label="Reasoning effort"
              title="Only reasoning models act on this; other models ignore the parameter, so Default is right for them."
              value={reasoningEffort}
              onChange={(event) => {
                const next = event.target.value;
                // The option values are the wire values; the guard is what keeps a hand-edited
                // selection from reaching the frame.
                setReasoningEffort(isReasoningEffort(next) ? next : "");
              }}
              className="h-6 shrink-0 border border-input bg-chrome-sunken px-1 text-2xs text-foreground outline-none"
            >
              <option value="">Default (not sent)</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            <ProviderModelPicker open={modelPickerOpen} onOpenChange={setModelPickerOpen} />
            <PermissionPicker />
            <CapabilityDialog />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                loading={running && !paused}
                disabled={draft.trim().length === 0}
                title={mode === "build" ? "Run this phase with this prompt" : "Send to the agent"}
                onClick={submit}
              >
                <Send className="size-3.5" />
                send
              </Button>
              {running ? (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={paused ? socket.resume : socket.pause}
                  aria-label={paused ? "resume" : "pause"}
                  title={paused ? "Continue the run from where it paused" : "Pause at the next step"}
                >
                  {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                </Button>
              ) : null}
              {running ? (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={onCancel}
                  aria-label="stop"
                  title="Stop the run"
                >
                  <Square className="size-3" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      )}
      <SlashHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
