import { useCallback, useState } from "react";
import type { SettingsSection } from "../components/settings/ProviderSettingsPanel";

export function useAppSurfaces() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("general");

  const closeFloatingSurfaces = useCallback(() => {
    setSearchOpen(false);
    setMoreOpen(false);
    setModelMenuOpen(false);
    setSkillMenuOpen(false);
    setCommandOpen(false);
    setMemoryOpen(false);
    setActivityOpen(false);
    setSettingsOpen(false);
  }, []);

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    moreOpen,
    setMoreOpen,
    memoryOpen,
    setMemoryOpen,
    activityOpen,
    setActivityOpen,
    modelMenuOpen,
    setModelMenuOpen,
    skillMenuOpen,
    setSkillMenuOpen,
    commandOpen,
    setCommandOpen,
    settingsOpen,
    setSettingsOpen,
    settingsInitialSection,
    setSettingsInitialSection,
    closeFloatingSurfaces
  };
}
