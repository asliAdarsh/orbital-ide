import { Toaster as SonnerToaster, toast } from "sonner";

export { toast };

export interface ToasterProps {
  className?: string;
}

export function Toaster({ className }: ToasterProps) {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      richColors={false}
      className={className}
      toastOptions={{
        classNames: {
          toast: "rounded border border-border bg-chrome text-foreground",
          title: "text-xs font-medium text-foreground",
          description: "font-mono text-2xs text-muted-foreground",
          actionButton: "rounded bg-primary px-2 text-2xs text-primary-foreground",
          cancelButton: "rounded bg-chrome-raised px-2 text-2xs text-muted-foreground",
          error: "border-destructive/40 text-destructive",
          success: "border-primary/40 text-primary",
          warning: "border-phase-test/40 text-phase-test",
          info: "border-border text-muted-foreground",
        },
      }}
    />
  );
}
