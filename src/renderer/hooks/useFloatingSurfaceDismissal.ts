import { useEffect } from "react";

type OpenSetter = (open: boolean) => void;

export function useFloatingSurfaceDismissal(options: {
  searchOpen: boolean;
  moreOpen: boolean;
  memoryOpen: boolean;
  activityOpen: boolean;
  modelMenuOpen: boolean;
  skillMenuOpen: boolean;
  commandOpen: boolean;
  settingsOpen: boolean;
  deleteThreadOpen: boolean;
  rememberDialogOpen: boolean;
  closeFloatingSurfaces(): void;
  setModelMenuOpen: OpenSetter;
  setSkillMenuOpen: OpenSetter;
  setMoreOpen: OpenSetter;
  setMemoryOpen: OpenSetter;
  setActivityOpen: OpenSetter;
}): void {
  useEffect(() => {
    const hasFloatingSurface =
      options.searchOpen ||
      options.moreOpen ||
      options.memoryOpen ||
      options.activityOpen ||
      options.modelMenuOpen ||
      options.skillMenuOpen ||
      options.commandOpen ||
      options.settingsOpen ||
      options.deleteThreadOpen ||
      options.rememberDialogOpen;
    if (!hasFloatingSurface) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") options.closeFloatingSurfaces();
    }

    function onMouseDown(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      if (options.modelMenuOpen && !target.closest(".model-menu") && !target.closest(".model-pill")) {
        options.setModelMenuOpen(false);
      }
      if (options.skillMenuOpen && !target.closest(".skill-menu") && !target.closest(".skill-tool")) {
        options.setSkillMenuOpen(false);
      }
      if (options.moreOpen && !target.closest(".side-footer") && !target.closest(".side-menu")) {
        options.setMoreOpen(false);
      }
      if (options.memoryOpen && !target.closest(".memory-panel") && !target.closest("[aria-label='Memory']") && !target.closest(".memory-dialog")) {
        options.setMemoryOpen(false);
      }
      if (options.activityOpen && !target.closest(".activity-panel") && !target.closest(".side-footer")) {
        options.setActivityOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [
    options.searchOpen,
    options.moreOpen,
    options.memoryOpen,
    options.activityOpen,
    options.modelMenuOpen,
    options.skillMenuOpen,
    options.commandOpen,
    options.settingsOpen,
    options.deleteThreadOpen,
    options.rememberDialogOpen
  ]);
}
