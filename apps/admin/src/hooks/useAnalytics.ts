import { useEffect, useRef, useState } from 'react';
import type { AnalyticsSnapshot } from '@gateway/shared-types';
import { API_BASE } from '../api/client';

// Live analytics via fetch() streaming instead of EventSource: EventSource
// cannot send an Authorization header, and putting the token in the query
// string would leak it into logs/history. Manual reconnect with backoff.

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export function useAnalyticsStream(token: string | null): {
  snapshot: AnalyticsSnapshot | null;
  previous: AnalyticsSnapshot | null;
  status: StreamStatus;
} {
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [previous, setPrevious] = useState<AnalyticsSnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const latest = useRef<AnalyticsSnapshot | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('connecting');
      return;
    }
    // Mutable holder (not a plain boolean) so checks survive TS narrowing
    // across awaits and closures.
    const alive = { current: true };
    let attempt = 0;
    const controller = new AbortController();

    const applySnapshot = (snap: AnalyticsSnapshot): void => {
      setPrevious(latest.current);
      latest.current = snap;
      setSnapshot(snap);
    };

    const connect = async (): Promise<void> => {
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const res = await fetch(`${API_BASE}/api/analytics/stream`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
        attempt = 0;
        if (alive.current) setStatus('live');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !alive.current) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                applySnapshot(JSON.parse(line.slice(5).trim()) as AnalyticsSnapshot);
              } catch {
                // Ignore malformed events; the next heartbeat replaces them.
              }
            }
          }
        }
      } catch (err) {
        if (!alive.current || (err instanceof DOMException && err.name === 'AbortError')) return;
        attempt += 1;
        if (attempt > 8) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cleanup may run during the backoff await
          if (alive.current) setStatus('error');
          return;
        }
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        await new Promise((r) => setTimeout(r, backoff));
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cleanup may run during the backoff await
        if (alive.current) void connect();
      }
    };

    void connect();
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [token]);

  return { snapshot, previous, status };
}
