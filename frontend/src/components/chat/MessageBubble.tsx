import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentId, ChatMessage } from "@/types/protocol";

export interface MessageBubbleProps {
  message: ChatMessage;
}

const AGENT_LABEL: Record<AgentId, string> = {
  orchestrator: "Orchestrator",
  architect: "Architect",
  code_engine: "Code Engine",
  qa: "QA",
};

const AGENT_CODE: Record<AgentId, string> = {
  orchestrator: "OR",
  architect: "AR",
  code_engine: "CE",
  qa: "QA",
};

/** Phase hue per agent: the roster and the chat chip must read as the same identity. */
const AGENT_CHIP: Record<AgentId, string> = {
  orchestrator: "bg-phase-plan/15 text-phase-plan",
  architect: "bg-phase-design/15 text-phase-design",
  code_engine: "bg-phase-build/15 text-phase-build",
  qa: "bg-phase-test/15 text-phase-test",
};

/** Coarse relative stamp — chat density does not warrant a date library. */
function relativeTime(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function MarkdownParagraph({ children }: { children?: ReactNode }) {
  return <p className="my-1 text-xs leading-relaxed">{children}</p>;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  return (
    <pre className="my-2 overflow-x-auto rounded-md border border-border bg-chrome-sunken p-3 font-mono text-2xs">
      {children}
    </pre>
  );
}

/**
 * react-markdown v9 dropped the `inline` flag, so fenced blocks are identified by
 * their `language-*` class; a fence with no language inherits the block surface
 * from the surrounding `pre`, which shares the same background.
 */
function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  if (typeof className === "string" && className.startsWith("language-")) {
    return <code className="font-mono">{children}</code>;
  }
  return <code className="rounded bg-chrome-sunken px-1 font-mono text-2xs">{children}</code>;
}

function MarkdownList({ children }: { children?: ReactNode }) {
  return <ul className="my-1 list-disc pl-4 text-xs">{children}</ul>;
}

function MarkdownOrderedList({ children }: { children?: ReactNode }) {
  return <ol className="my-1 list-decimal pl-4 text-xs">{children}</ol>;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
      {children}
    </a>
  );
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return <table className="my-2 border-collapse border border-border text-2xs">{children}</table>;
}

function MarkdownHeaderCell({ children }: { children?: ReactNode }) {
  return <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>;
}

function MarkdownCell({ children }: { children?: ReactNode }) {
  return <td className="border border-border px-2 py-1 align-top">{children}</td>;
}

const MARKDOWN_COMPONENTS: Components = {
  p: MarkdownParagraph,
  pre: MarkdownPre,
  code: MarkdownCode,
  ul: MarkdownList,
  ol: MarkdownOrderedList,
  a: MarkdownLink,
  table: MarkdownTable,
  th: MarkdownHeaderCell,
  td: MarkdownCell,
};

const REMARK_PLUGINS = [remarkGfm];

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const toolCount = message.toolCalls.length;

  return (
    <div className={cn("flex gap-2", isUser && "flex-row-reverse")}>
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-2xs font-medium",
          isUser ? "bg-secondary text-muted-foreground" : AGENT_CHIP[message.agent],
        )}
      >
        {isUser ? "me" : AGENT_CODE[message.agent]}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("flex items-center gap-1.5", isUser && "justify-end")}>
          <span className="text-2xs font-medium text-foreground">
            {isUser ? "you" : AGENT_LABEL[message.agent]}
          </span>
          {message.phase ? (
            <span className="text-2xs text-muted-foreground">{message.phase}</span>
          ) : null}
          <span className="text-2xs text-muted-foreground">{relativeTime(message.createdAt)}</span>
          {toolCount > 0 ? (
            <Badge variant="secondary">
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 min-w-0">
          {isUser ? (
            <p className="whitespace-pre-wrap rounded border border-border bg-chrome px-2 py-1.5 text-xs leading-relaxed">
              {message.content}
            </p>
          ) : message.role === "assistant" ? (
            <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
              {message.content}
            </Markdown>
          ) : (
            <p className="whitespace-pre-wrap font-mono text-2xs text-muted-foreground">
              {message.content}
            </p>
          )}
          {message.streaming ? (
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-caret-blink bg-primary align-middle" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
