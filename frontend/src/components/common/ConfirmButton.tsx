import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";

export interface ConfirmButtonProps {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  disabled?: boolean;
}

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Confirm?",
  variant = "secondary",
  size = "xs",
  className,
  disabled = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const handleClick = () => {
    if (!armed) {
      clearTimer();
      setArmed(true);
      timer.current = window.setTimeout(() => {
        setArmed(false);
        timer.current = null;
      }, 3000);
      return;
    }
    clearTimer();
    setArmed(false);
    onConfirm();
  };

  return (
    <Button
      type="button"
      variant={armed ? "destructive" : variant}
      size={size}
      className={className}
      disabled={disabled}
      onClick={handleClick}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
