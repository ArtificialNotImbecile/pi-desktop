import { useRef } from "react";

type AnyFunction = (...args: never[]) => unknown;

type CallbackProps<T> = {
  [K in keyof T as T[K] extends AnyFunction ? K : never]: T[K];
};

// Returns identity-stable wrappers for every function-valued prop. Parent
// components (App, ChatPage) recreate handler closures on each render, which
// would defeat React.memo on Sidebar/Composer during stream ticks; the wrappers
// keep one identity forever while always invoking the latest closure.
// Assumes the set of function props is fixed after the first render.
export function useStableCallbacks<T extends object>(source: T): CallbackProps<T> {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const stableRef = useRef<CallbackProps<T> | null>(null);
  if (!stableRef.current) {
    const stable: Record<string, AnyFunction> = {};
    for (const key of Object.keys(source) as Array<keyof T & string>) {
      if (typeof source[key] !== "function") continue;
      stable[key] = ((...args: never[]) =>
        (sourceRef.current[key] as AnyFunction)(...args)) as AnyFunction;
    }
    stableRef.current = stable as CallbackProps<T>;
  }
  return stableRef.current;
}
