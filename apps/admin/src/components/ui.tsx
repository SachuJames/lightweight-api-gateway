import type { ReactNode } from 'react';

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint !== undefined && <div className="hint">{hint}</div>}
    </div>
  );
}

type BadgeColor = 'green' | 'yellow' | 'red' | 'blue' | 'gray';

export function Badge({ color, children }: { color: BadgeColor; children: ReactNode }) {
  return <span className={`badge ${color}`}>{children}</span>;
}

export function CircuitBadge({ state }: { state: string | undefined }) {
  if (state === 'OPEN') return <Badge color="red">OPEN</Badge>;
  if (state === 'HALF_OPEN') return <Badge color="yellow">HALF-OPEN</Badge>;
  if (state === 'CLOSED') return <Badge color="green">CLOSED</Badge>;
  return <Badge color="gray">no data</Badge>;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? <Badge color="green">enabled</Badge> : <Badge color="gray">disabled</Badge>;
}

export function Spinner({ text = 'Loading…' }: { text?: string }) {
  return <div className="spinner">{text}</div>;
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="alert error">
      <strong>Something went wrong:</strong> {error.message}
      {onRetry && (
        <>
          {' '}
          <button className="btn-link" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="modal-actions">
          <button className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
