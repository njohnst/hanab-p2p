import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/** How long a toast stays on screen unless it is dismissed or replaced. */
export const TOAST_DURATION_MS = 4000;

/**
 * Above everything else, react-modal overlays included (z-index 9999, see
 * ~/components/ui/modal). Only effective because the toast is portaled into
 * document.body, where it competes with the overlays in the root stacking
 * context: inside the app it would be capped by .aspect-ratio--object's
 * z-index of 100 (see pages/_app).
 */
const TOAST_Z_INDEX = 10000;

export interface ToastMessage {
  /** Unique per showToast call, so showing the same text again still restarts the timer. */
  id: number;
  text: string;
}

/**
 * State for a single toast slot: showToast replaces whatever is displayed and
 * restarts its timer, dismissToast hides it. Pass `toast` and `dismissToast`
 * to <Toast>.
 */
export function useToast() {
  const lastId = useRef(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string) => {
    lastId.current += 1;
    setToast({ id: lastId.current, text });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  return { toast, showToast, dismissToast };
}

interface Props {
  toast: ToastMessage | null;
  onDismiss: () => void;
  durationMs?: number;
}

/**
 * A short message floating at the top center of the screen, above modals.
 * It goes away after `durationMs` or when clicked. The live region stays
 * mounted while empty so that screen readers announce every new message.
 *
 * Rendered into document.body rather than in place, for two reasons:
 * - stacking: the app root (.aspect-ratio--object in pages/_app) is a
 *   z-index:100 stacking context, so nothing inside it can be drawn above the
 *   body-level react-modal overlays, and a tap meant for the toast would land
 *   on the overlay and close the modal instead;
 * - accessibility: react-modal sets aria-hidden on #__next while a modal is
 *   open, which would take the live region out of the accessibility tree and
 *   swallow any message shown meanwhile.
 * Nothing is rendered until mounted, so it is safe to pre-render.
 */
export default function Toast(props: Props) {
  const { toast, onDismiss, durationMs = TOAST_DURATION_MS } = props;
  const { t } = useTranslation();

  // Set once mounted; there is no document.body to portal into while pre-rendering.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(document.body);
  }, []);

  // Keep the timer independent of the callback's identity: only a new message restarts it.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!toast) return;

    const timer = setTimeout(() => onDismissRef.current(), durationMs);

    return () => clearTimeout(timer);
  }, [toast, durationMs]);

  if (!container) return null;

  return createPortal(
    <div
      aria-atomic="true"
      aria-live="polite"
      className="fixed left-0 right-0 flex justify-center ph3"
      role="status"
      style={{ top: "1rem", zIndex: TOAST_Z_INDEX, pointerEvents: "none" }}
    >
      {toast && (
        <button
          key={toast.id}
          className="toast mw6 bg-white black ph3 pv2 br2 bn shadow-2 f6 fw5 lh-copy tc pointer"
          style={{ pointerEvents: "auto" }}
          title={t("toastDismiss", "Click to dismiss")}
          type="button"
          onClick={() => onDismiss()}
        >
          {toast.text}
        </button>
      )}
      <style jsx>{`
        .toast {
          animation: toast-in 150ms ease-out;
        }

        @keyframes toast-in {
          from {
            opacity: 0;
            transform: translateY(-0.5rem);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .toast {
            animation: none;
          }
        }
      `}</style>
    </div>,
    container
  );
}
