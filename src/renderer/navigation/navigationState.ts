import { useCallback, useMemo, useState } from "react";
import { routeToPath, type JasmineRoute } from "./routes";

export type NavigationEntry = {
  route: JasmineRoute;
  path: string;
};

export type NavigationState = {
  current: NavigationEntry;
  backStack: NavigationEntry[];
  forwardStack: NavigationEntry[];
};

export type NavigateMode = "push" | "replace";

export function createNavigationEntry(route: JasmineRoute): NavigationEntry {
  return {
    route,
    path: routeToPath(route)
  };
}

export function useJasmineNavigation(initialRoute: JasmineRoute = { name: "newChat" }) {
  const [state, setState] = useState<NavigationState>(() => ({
    current: createNavigationEntry(initialRoute),
    backStack: [],
    forwardStack: []
  }));

  const navigate = useCallback((route: JasmineRoute, mode: NavigateMode = "push") => {
    setState((current) => {
      const nextEntry = createNavigationEntry(route);
      if (current.current.path === nextEntry.path) return current;
      if (mode === "replace") {
        return {
          ...current,
          current: nextEntry
        };
      }
      return {
        current: nextEntry,
        backStack: [...current.backStack, current.current].slice(-25),
        forwardStack: []
      };
    });
  }, []);

  const goBack = useCallback(() => {
    setState((current) => {
      const previous = current.backStack.at(-1);
      if (!previous) return current;
      return {
        current: previous,
        backStack: current.backStack.slice(0, -1),
        forwardStack: [current.current, ...current.forwardStack].slice(0, 25)
      };
    });
  }, []);

  const goForward = useCallback(() => {
    setState((current) => {
      const next = current.forwardStack[0];
      if (!next) return current;
      return {
        current: next,
        backStack: [...current.backStack, current.current].slice(-25),
        forwardStack: current.forwardStack.slice(1)
      };
    });
  }, []);

  const replace = useCallback((route: JasmineRoute) => navigate(route, "replace"), [navigate]);

  return useMemo(() => ({
    route: state.current.route,
    path: state.current.path,
    canGoBack: state.backStack.length > 0,
    canGoForward: state.forwardStack.length > 0,
    navigate,
    replace,
    goBack,
    goForward
  }), [goBack, goForward, navigate, replace, state.backStack.length, state.current.path, state.current.route, state.forwardStack.length]);
}
