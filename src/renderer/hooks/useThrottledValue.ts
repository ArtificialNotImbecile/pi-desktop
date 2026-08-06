import { useEffect, useRef, useState } from "react";

// Returns `value`, but updates at most once per `intervalMs` (leading edge
// immediate, trailing edge guaranteed). Used to keep per-stream-tick derived
// work such as the right-panel artifact/taxonomy scans at <= 1 recompute per
// second while a response is running (plan Phase 5.3).
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdateRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (Object.is(throttled, value)) return;
    const elapsed = Date.now() - lastUpdateRef.current;
    if (elapsed >= intervalMs) {
      lastUpdateRef.current = Date.now();
      setThrottled(value);
      return;
    }
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastUpdateRef.current = Date.now();
      setThrottled(valueRef.current);
    }, intervalMs - elapsed);
  }, [value, intervalMs, throttled]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return throttled;
}
