import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface ConfirmRequest {
  title: string;
  lines: string[];
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
}

let enqueue: ((request: ConfirmRequest) => void) | null = null;

/**
 * Asks in a small card centred on the page (same look as 本週臨時異動) instead of the
 * browser's confirm box. Resolves true on the confirm button, false on
 * 取消 or Esc. Falls back to window.confirm if the host is not mounted.
 */
export function askConfirm(title: string, lines: string[], confirmLabel = "仍要儲存"): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(window.confirm(`${title}\n${lines.map((line) => `• ${line}`).join("\n")}`));
      return;
    }
    enqueue({ title, lines, confirmLabel, resolve });
  });
}

/** Mounted once in App; shows pending confirmations one at a time. */
export default function ConfirmPopupHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const current = queue[0];

  useEffect(() => {
    enqueue = (request) => setQueue((pending) => [...pending, request]);
    return () => {
      enqueue = null;
    };
  }, []);

  const answer = useCallback(
    (confirmed: boolean) => {
      if (!current) return;
      current.resolve(confirmed);
      setQueue((pending) => pending.slice(1));
    },
    [current],
  );

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, answer]);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30 p-4"
      data-testid="confirm-popup-overlay"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={current.title}
        className="flex w-[400px] max-w-full max-h-full flex-col rounded-xl border-2 border-destructive bg-white p-5 shadow-2xl dark:bg-card"
        data-testid="confirm-popup"
      >
        <div className="flex shrink-0 items-center gap-2">
          <div className="h-2 w-2 shrink-0 rounded-full bg-destructive" aria-hidden="true"></div>
          <h3 className="text-base font-medium text-foreground">{current.title}</h3>
        </div>
        <ul className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto text-sm text-destructive">
          {current.lines.map((line, index) => (
            <li key={index} className="leading-relaxed">
              • {line}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => answer(false)} data-testid="button-confirm-cancel">
            取消
          </Button>
          <Button size="sm" onClick={() => answer(true)} autoFocus data-testid="button-confirm-ok">
            {current.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
