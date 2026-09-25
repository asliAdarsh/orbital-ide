/**
 * Markdown rendering, styled once for the whole app.
 *
 * The plan canvas and the launcher's documentation both show model- or repo-authored markdown, and
 * two component maps would drift the moment one of them gained a table or a blockquote the other
 * did not know about.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-sm font-medium text-foreground">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-xs font-medium uppercase tracking-wider text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 text-xs font-medium text-muted-foreground">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 text-xs leading-relaxed text-foreground">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5 text-xs text-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5 text-xs text-foreground">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-2 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ children, href }) => (
    <a className="text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="font-mono text-2xs text-foreground">{children}</code>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto border border-border bg-chrome-sunken p-2">{children}</pre>
  ),
  table: ({ children }) => <table className="my-2 w-full border-collapse text-2xs">{children}</table>,
  th: ({ children }) => (
    <th className="border border-border px-1.5 py-1 text-left font-medium text-muted-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-1.5 py-1 text-foreground">{children}</td>,
  hr: () => <hr className="my-3 border-border" />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
