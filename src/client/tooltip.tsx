import { useId, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './tooltip.css';

/** Non-interactive, top-layer tooltip; hover/focus on desktop, tap to pin on touch. */
export function Tooltip({
  label,
  children,
  content,
  className = 'icon-button',
}: {
  label: string;
  children: ReactNode;
  content: ReactNode;
  className?: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const [open, setOpen] = useState(false);
  const show = () => {
    clearTimeout(leaveTimer.current);
    panel.current?.showPopover();
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(leaveTimer.current);
    panel.current?.hidePopover();
    setOpen(false);
    pinned.current = false;
  };
  const leave = () => {
    if (!pinned.current && document.activeElement !== button.current)
      leaveTimer.current = setTimeout(hide, 120);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = button.current!.getBoundingClientRect();
      const bounds = panel.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth;
      const height = viewport?.height ?? innerHeight;
      panel.current!.style.left = `${Math.max(left + 12, Math.min(anchor.left, left + width - bounds.width - 12))}px`;
      const above = anchor.top - bounds.height - 8;
      panel.current!.style.top = `${Math.max(top + 12, Math.min(above >= top + 12 ? above : anchor.bottom + 8, top + height - bounds.height - 12))}px`;
    };
    const dismiss = (event: PointerEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel.current!);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={show}
        onBlur={hide}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') show();
        }}
        onPointerLeave={leave}
        onClick={() => {
          if (pinned.current) hide();
          else {
            pinned.current = true;
            show();
          }
        }}
      >
        {children}
      </button>
      <div
        ref={panel}
        id={id}
        role="tooltip"
        popover="manual"
        className="ds-tooltip"
        onPointerEnter={show}
        onPointerLeave={leave}
      >
        {content}
      </div>
    </>
  );
}
