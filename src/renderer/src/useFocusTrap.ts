import { useEffect } from 'react';

/**
 * Elements that can receive keyboard focus. Disabled controls are excluded up
 * front; visibility and tabindex are checked per-element in isFocusable.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** A plain shape rather than React.RefObject so callers can pass any ref. */
type ElementRef<T extends HTMLElement = HTMLElement> = { current: T | null };

export type FocusTrapOptions = {
  /** Preferred first focus target. Falls back to the first focusable child. */
  initialFocusRef?: ElementRef;
};

function isFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  // Covers display:none, visibility:hidden, and detached subtrees. Works for
  // children of position:fixed containers, where offsetParent is unreliable.
  return element.getClientRects().length > 0;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

function canRestoreTo(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && document.contains(element) && isFocusable(element);
}

/**
 * Traps keyboard focus inside `containerRef` while `active` is true, and
 * restores focus to whatever was focused before activation.
 *
 * Tab handling only — callers keep their own Esc and backdrop-click handlers.
 * The focusable set is queried on every Tab, so content that appears while the
 * overlay is open (scan results, validation errors) is picked up automatically.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: ElementRef,
  options: FocusTrapOptions = {},
): void {
  const { initialFocusRef } = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) {
      return;
    }

    const previouslyFocused = document.activeElement;

    // Deterministic initial focus: the caller's preferred target, else the
    // first focusable child, else the dialog itself.
    const initial = initialFocusRef?.current ?? getFocusable(container)[0] ?? null;
    if (initial) {
      initial.focus();
    } else {
      if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
      }
      container.focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || !containerRef.current) {
        return;
      }
      const focusable = getFocusable(containerRef.current);

      // Nothing tabbable inside — keep focus pinned to the dialog.
      if (focusable.length === 0) {
        event.preventDefault();
        containerRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      // Focus escaped the container (or never entered) — pull it back.
      if (!(current instanceof HTMLElement) || !containerRef.current.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Capture phase so the trap wins before anything else reacts to Tab.
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // The trigger may have been removed while the overlay was open (a deleted
      // card, a re-rendered list). Fall back rather than throwing.
      if (canRestoreTo(previouslyFocused)) {
        previouslyFocused.focus();
      } else {
        document.body.focus();
      }
    };
  }, [active, containerRef, initialFocusRef]);
}
