/**
 * Resizable panel edges, persisted per panel.
 *
 * Three panels share this behaviour — the left rail, the right rail and the bottom dock —
 * and a drag handle needs more than `onPointerDown`: the listeners must be torn down if the
 * component unmounts mid-drag, and a `role="separator"` must be operable from the keyboard.
 * Keeping that in one place means the panels only supply their geometry.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Pointer direction that *increases* the panel's size. */
export type GrowDirection = "right" | "left" | "up";

const KEYBOARD_STEP = 16;

export interface PanelSizeOptions {
  /** localStorage key. One per panel, so sizes survive a reload independently. */
  storageKey: string;
  /** Starting size in pixels, also restored by double-click. */
  initial: number;
  min: number;
  max: number;
  grow: GrowDirection;
  /** Used for the handle's accessible name, e.g. "left sidebar". */
  label: string;
}

export interface PanelSize {
  size: number;
  /** True while the pointer is down, so the panel can disable transitions. */
  resizing: boolean;
  reset(): void;
  handleProps: {
    role: "separator";
    tabIndex: number;
    "aria-orientation": "horizontal" | "vertical";
    "aria-label": string;
    onPointerDown(event: PointerEvent<HTMLElement>): void;
    onDoubleClick(): void;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredSize(options: PanelSizeOptions): number {
  try {
    const stored = window.localStorage.getItem(options.storageKey);
    if (stored === null) return options.initial;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? clamp(parsed, options.min, options.max) : options.initial;
  } catch {
    // Storage can be unavailable (private mode); the panel still works for this session.
    return options.initial;
  }
}

export function usePanelSize(options: PanelSizeOptions): PanelSize {
  const { storageKey, initial, min, max, grow, label } = options;
  const [size, setSize] = useState(() => readStoredSize(options));
  const [resizing, setResizing] = useState(false);
  const sizeRef = useRef(size);

  useEffect(() => {
    sizeRef.current = size;
    try {
      window.localStorage.setItem(storageKey, String(size));
    } catch {
      // Persistence is best-effort.
    }
  }, [storageKey, size]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const startSize = sizeRef.current;
      const startX = event.clientX;
      const startY = event.clientY;
      setResizing(true);

      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        const outward =
          grow === "right"
            ? moveEvent.clientX - startX
            : grow === "left"
              ? startX - moveEvent.clientX
              : startY - moveEvent.clientY;
        setSize(clamp(startSize + outward, min, max));
      };
      const handleUp = () => {
        setResizing(false);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [grow, min, max],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) return;
      event.preventDefault();
      // A rail that grows leftwards moves the other way for the same arrow key.
      const sign = (forward ? 1 : -1) * (grow === "right" ? 1 : -1);
      setSize((current) => clamp(current + sign * KEYBOARD_STEP, min, max));
    },
    [grow, min, max],
  );

  const reset = useCallback(() => setSize(clamp(initial, min, max)), [initial, min, max]);

  return {
    size,
    resizing,
    reset,
    handleProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": grow === "up" ? "horizontal" : "vertical",
      "aria-label": `${label} resize handle — drag, use the arrow keys, or double-click to reset`,
      onPointerDown,
      onDoubleClick: reset,
      onKeyDown,
    },
  };
}
