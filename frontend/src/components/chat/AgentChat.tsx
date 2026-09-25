import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare, Send, Square } from "lucide-react";
import { CapabilityDialog } from "@/components/chat/CapabilityDialog";
import { CommandApproval } from "@/components/chat/CommandApproval";
import { ComposerAttachments } from "@/components/chat/ComposerAttachments";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PermissionPicker } from "@/components/chat/PermissionPicker";
import { TodoList } from "@/components/chat/TodoList";
import { EmptyState } from "@/components/common/EmptyState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { COMPOSER_MODES, useAppStore, type ApprovalCard, type ComposerMode } from "@/store/app-store";
import { REASONING_EFFORTS, isReasoningEffort, type ChatMessage } from "@/types/protocol";

export interface AgentChatProps {
  messages: ChatMessage[];
  running: boolean;
  /** The Plan path: a conversational turn with the phase's specialist. */
  onSend: (content: string) => void;
  onCancel: () => void;
  className?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Controls rendered on the left of the action row beneath the textarea. */
  toolbar?: ReactNode;
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

export function AgentChat({
  messages,
  running,
  onSend,
  onCancel,
  className,
  disabled,
  disabledReason,
  toolbar,
  placeholder = "Describe what to build, or ask about the current phase",
  approvals,
  onApprove,
  onBuild,
  defaultMode,
}: AgentChatProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  const submit = () => {
    const content = draft.trim();
    if (!content || running) return;
    setDraft("");
    // The socket reads the picks, the effort, the permission and the enabled capabilities off the
    // store as it builds the frame, so they are still in place while the handler runs and the picks
    // are dropped the moment it returns: a pick belongs to one message, and the chip disappearing
    // is the confirmation that it went.
    if (mode === "build" && onBuild) onBuild(content);
    else onSend(content);
    clearContext();
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {messages.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No messages yet"
              hint="Describe the task, then run a phase to start the agents."
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
      {disabled ? (
        <Alert className="m-2">
          <AlertTitle>Agent unavailable</AlertTitle>
          <AlertDescription>
            {disabledReason ?? "This session cannot run agents right now."}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="border-t border-border p-2">
          {/* Above the textarea, and capped, so unfolding it never pushes the transcript away. */}
          {todos.length > 0 ? <TodoList items={todos} running={running} className="mb-1.5" /> : null}
          <Textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
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
            {toolbar}
            <PermissionPicker />
            <CapabilityDialog />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                loading={running}
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
    </div>
  );
}
