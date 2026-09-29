/**
 * The sessions panel: every chat this account has, which one this window is on, and what to do with
 * one.
 *
 * It sits in the left sidebar beside the workspace tree because a chat is the same kind of thing —
 * a place the user goes back to — and because a chat outlives the folder it started in: the scope
 * toggle is what makes the difference visible, and the row's workspace label is what says whose
 * chat a row is when the list is showing every folder's.
 *
 * Switching a chat is not a local swap of what is on screen. The chat id is the runtime session id,
 * so opening one re-reads its state from the server and re-subscribes the socket — which is why this
 * panel talks to the socket rather than patching the store itself.
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eraser,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { errorMessage } from "@/lib/api";
import { baseName, cn, formatRelativeAge } from "@/lib/utils";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { useAppStore, type ChatScope } from "@/store/app-store";
import { ConfirmButton } from "@/components/common/ConfirmButton";
import { SectionLabel } from "@/components/common/SectionLabel";
import { StatusDot } from "@/components/common/StatusDot";
import { toast } from "@/components/common/Toaster";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Chat } from "@/types/protocol";

const SCOPES: ReadonlyArray<{ id: ChatScope; label: string; hint: string }> = [
  { id: "workspace", label: "This workspace", hint: "Only chats started in the open folder" },
  { id: "all", label: "All workspaces", hint: "Every chat this account has" },
];

/** The workspace a row belongs to, as much of it as a row has room for. */
function workspaceLabel(chat: Chat): string {
  return chat.workspace === null ? "no folder" : baseName(chat.workspace);
}

export function SessionsPanel() {
  const chats = useAppStore((store) => store.chats);
  const chatsLoading = useAppStore((store) => store.chatsLoading);
  const chatsError = useAppStore((store) => store.chatsError);
  const scope = useAppStore((store) => store.chatScope);
  const setChatScope = useAppStore((store) => store.setChatScope);
  const activeChatId = useAppStore((store) => store.activeChatId);
  const projectPath = useAppStore((store) => store.project?.projectPath ?? null);
  const loadChats = useAppStore((store) => store.loadChats);
  const createChat = useAppStore((store) => store.createChat);
  const renameChat = useAppStore((store) => store.renameChat);
  const clearChat = useAppStore((store) => store.clearChat);
  const refreshChat = useAppStore((store) => store.refreshChat);
  const deleteChat = useAppStore((store) => store.deleteChat);
  // Stable module function: it is what the effect below depends on, and the hook's own object
  // changes identity whenever the socket's status does.
  const { openChat } = useAgentSocket();

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadChats().then(() => {
      const state = useAppStore.getState();
      // Reopen the newest chat when this window has none: it is the conversation the user was last
      // in, and leaving the session id unset would have the backend create a chat on the fly under
      // the local fallback id instead.
      const first = state.chats[0];
      if (state.activeChatId === null && first !== undefined) void openChat(first.id);
    });
  }, [loadChats, openChat, projectPath]);

  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? chats
      : chats.filter(
          (chat) =>
            chat.title.toLowerCase().includes(needle) ||
            (chat.workspace ?? "").toLowerCase().includes(needle),
        );

  useEffect(() => {
    // A filter can hide the row that was highlighted; the index must never point at nothing.
    setHighlight((current) => Math.min(current, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    setHighlight(0);
  }, [needle, scope]);

  const open = (id: string) => {
    if (id === activeChatId) return;
    void openChat(id);
  };

  const moveHighlight = (step: number) => {
    if (visible.length === 0) return;
    setHighlight((current) => (current + step + visible.length) % visible.length);
  };

  const startNewChat = async () => {
    const created = await createChat();
    if (created) await openChat(created.id);
  };

  const commitRename = async () => {
    if (renaming === null) return;
    const title = renaming.value.trim();
    const id = renaming.id;
    setRenaming(null);
    if (title === "") return;
    await renameChat(id, title).catch((cause: unknown) => toast.error(errorMessage(cause)));
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = visible[highlight];
      if (target) open(target.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // First Escape gives back the unfiltered list, a second one puts the panel away.
      if (query !== "") setQuery("");
      else setCollapsed(true);
    }
  };

  const scopeButton = (entry: (typeof SCOPES)[number], index: number) => (
    <button
      key={entry.id}
      type="button"
      aria-pressed={scope === entry.id}
      title={entry.hint}
      onClick={() => setChatScope(entry.id)}
      className={cn(
        "h-5 flex-1 px-1 text-2xs transition-colors",
        scope === entry.id
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:text-foreground",
        index > 0 && "border-l border-border",
      )}
    >
      {entry.label}
    </button>
  );

  return (
    <>
      <SectionLabel
        right={
          <>
            {chatsLoading ? <span className="font-mono text-2xs text-muted-foreground">…</span> : null}
            <Button
              size="icon"
              variant="ghost"
              className="size-5"
              aria-label="New chat"
              title="Start a new chat"
              onClick={() => void startNewChat()}
            >
              <Plus className="size-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-5"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand chats" : "Collapse chats"}
              title={collapsed ? "Expand the chat list" : "Collapse the chat list"}
              onClick={() => setCollapsed((current) => !current)}
            >
              {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
            </Button>
          </>
        }
      >
        Chats
      </SectionLabel>

      {collapsed ? null : (
        <>
          <div className="space-y-1 px-2 pb-1">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70"
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                spellCheck={false}
                aria-label="Search chats"
                placeholder="Search chats"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                className="h-6 w-full border border-input bg-chrome-sunken pl-5 pr-1.5 text-2xs text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div
              role="group"
              aria-label="Chat scope"
              className="flex items-center rounded border border-border"
            >
              {SCOPES.map(scopeButton)}
            </div>
          </div>

          {chatsError !== null ? (
            <p className="px-2 py-1 text-2xs text-destructive">{chatsError}</p>
          ) : null}

          <ScrollArea className="max-h-56 shrink-0">
            {visible.length === 0 ? (
              <p className="px-2 py-1 text-2xs text-muted-foreground">
                {chats.length === 0
                  ? "No chats yet. Send a message, or press + to start one."
                  : "No chat matches that search."}
              </p>
            ) : (
              visible.map((chat, index) => (
                <div
                  key={chat.id}
                  className={cn(
                    "group flex items-start gap-1.5 border-b border-border px-2 py-1",
                    chat.id === activeChatId && "bg-primary/10",
                    index === highlight && "bg-chrome-raised",
                  )}
                >
                  <StatusDot state={chat.runStatus} className="mt-1" />
                  {renaming?.id === chat.id ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      aria-label="Chat title"
                      onChange={(event) => setRenaming({ id: chat.id, value: event.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitRename();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setRenaming(null);
                        }
                      }}
                      className="h-5 min-w-0 flex-1 border border-input bg-chrome-sunken px-1 text-2xs text-foreground"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => open(chat.id)}
                      onMouseEnter={() => setHighlight(index)}
                      onFocus={() => setHighlight(index)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                          // The search box is the list's keyboard home: arrows move the highlight
                          // there, and leaving focus on a row would split that behaviour in two.
                          searchRef.current?.focus();
                        }
                      }}
                      title={`${chat.title} — ${chat.workspace ?? "no folder"}`}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex items-center gap-1">
                        {chat.id === activeChatId ? (
                          <Check className="size-3 shrink-0 text-primary" aria-hidden />
                        ) : null}
                        <span className="truncate text-2xs text-foreground">{chat.title}</span>
                      </span>
                      <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                        <span className="shrink-0">{formatRelativeAge(chat.updatedAt)}</span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{workspaceLabel(chat)}</span>
                        <span className="shrink-0">
                          {chat.messageCount === 1 ? "1 message" : `${chat.messageCount} messages`}
                        </span>
                      </span>
                    </button>
                  )}
                  {/* Subdued but never hidden: a row's actions are how the list is maintained, and
                      a control that only exists on hover is a control a user cannot find. */}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-40 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      aria-label={`Rename ${chat.title}`}
                      title="Rename this chat"
                      onClick={() => setRenaming({ id: chat.id, value: chat.title })}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      aria-label={`Clear ${chat.title}`}
                      title="Empty this chat's transcript, keeping the chat"
                      onClick={() => {
                        void clearChat(chat.id).catch((cause: unknown) =>
                          toast.error(errorMessage(cause)),
                        );
                      }}
                    >
                      <Eraser className="size-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      aria-label={`Refresh ${chat.title}`}
                      title="Re-read this chat from the server"
                      onClick={() => {
                        void refreshChat(chat.id).catch((cause: unknown) =>
                          toast.error(errorMessage(cause)),
                        );
                      }}
                    >
                      <RefreshCw className="size-3" />
                    </Button>
                    <ConfirmButton
                      size="xs"
                      variant="ghost"
                      className="h-5 px-1"
                      confirmLabel="sure?"
                      label={`Delete ${chat.title}`}
                      onConfirm={() => {
                        void deleteChat(chat.id).catch((cause: unknown) =>
                          toast.error(errorMessage(cause)),
                        );
                      }}
                    >
                      <Trash2 className="size-3" />
                    </ConfirmButton>
                  </div>
                </div>
              ))
            )}
          </ScrollArea>
        </>
      )}
    </>
  );
}
