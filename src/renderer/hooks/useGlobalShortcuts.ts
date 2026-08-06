import { useEffect } from "react";

export function useGlobalShortcuts(input: {
  closeFloatingSurfaces(): void;
  openCommandPalette(): void;
  openSearch(): void;
  startNewChat(): void;
}) {
  useEffect(() => {
    function onGlobalKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        input.closeFloatingSurfaces();
        input.openCommandPalette();
      }
      if (key === "f") {
        event.preventDefault();
        input.closeFloatingSurfaces();
        input.openSearch();
      }
      if (key === "n") {
        event.preventDefault();
        input.startNewChat();
      }
    }

    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [input]);
}
