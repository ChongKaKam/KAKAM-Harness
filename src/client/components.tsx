import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X, LoaderCircle, ArrowUpRight } from 'lucide-react';
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? 'small' : ''}`}>
      d<span>·</span>
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <ArrowUpRight size={26} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Spinner() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>正在加载…</span>
    </div>
  );
}
export function ErrorNote({ text }: { text?: string }) {
  return text ? (
    <div className="error-note" role="alert">
      {text}
    </div>
  ) : null;
}
export function Modal({
  title,
  children,
  close,
  className,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      // Close while connected so the native dialog releases focus before React removes it.
      // Keep dismissal in the caller: some dialogs deliberately refuse to close while busy.
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : 'modal'}
      aria-labelledby={headingId}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <h2 id={headingId}>{title}</h2>
        <button type="button" className="icon-button" onClick={close} aria-label="关闭">
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let valid = true;
    setError('');
    loader()
      .then((d) => {
        if (valid) setData(d);
      })
      .catch((e) => {
        if (valid) setError(e.message);
      });
    return () => {
      valid = false;
    };
  }, [...dependencies, revision]);
  return { data, error, reload: () => setRevision((n) => n + 1) };
}
