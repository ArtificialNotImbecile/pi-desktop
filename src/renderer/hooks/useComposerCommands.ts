import { useCallback, useMemo, useState } from "react";

export type ComposerCommandState = {
  activeIndex: number;
  open: boolean;
  query: string;
  start: number;
};

const closedCommandState: ComposerCommandState = {
  activeIndex: 0,
  open: false,
  query: "",
  start: -1
};

export function useComposerCommands() {
  const [mention, setMention] = useState<ComposerCommandState>(closedCommandState);
  const [skillCommand, setSkillCommand] = useState<ComposerCommandState>(closedCommandState);
  const [promptCommand, setPromptCommand] = useState<ComposerCommandState>(closedCommandState);

  const closeMention = useCallback(() => {
    setMention(closedCommandState);
  }, []);

  const closeSkillCommand = useCallback(() => {
    setSkillCommand(closedCommandState);
  }, []);

  const closePromptCommand = useCallback(() => {
    setPromptCommand(closedCommandState);
  }, []);

  const updateCommandState = useCallback((value: string, cursor: number | null) => {
    if (cursor === null) return;
    const beforeCursor = value.slice(0, cursor);
    const slashMatch = /^\/([^\s/]*)$/.exec(beforeCursor);
    if (slashMatch) {
      closeMention();
      closeSkillCommand();
      setPromptCommand({ open: true, start: 0, query: slashMatch[1], activeIndex: 0 });
      return;
    }
    const skillMatch = /(^|\s)\$([^\s$]*)$/.exec(beforeCursor);
    if (skillMatch) {
      closeMention();
      closePromptCommand();
      const start = cursor - skillMatch[2].length - 1;
      setSkillCommand({ open: true, start, query: skillMatch[2], activeIndex: 0 });
      return;
    }
    const mentionMatch = /(^|\s)@([^\s@]*)$/.exec(beforeCursor);
    if (!mentionMatch) {
      closeMention();
      closeSkillCommand();
      closePromptCommand();
      return;
    }
    closeSkillCommand();
    closePromptCommand();
    const start = cursor - mentionMatch[2].length - 1;
    setMention({ open: true, start, query: mentionMatch[2], activeIndex: 0 });
  }, [closeMention, closePromptCommand, closeSkillCommand]);

  const setMentionActiveIndex = useCallback((activeIndex: number) => {
    setMention((current) => ({ ...current, activeIndex }));
  }, []);

  const setSkillCommandActiveIndex = useCallback((activeIndex: number) => {
    setSkillCommand((current) => ({ ...current, activeIndex }));
  }, []);

  const setPromptCommandActiveIndex = useCallback((activeIndex: number) => {
    setPromptCommand((current) => ({ ...current, activeIndex }));
  }, []);

  return useMemo(() => ({
    mention,
    skillCommand,
    promptCommand,
    updateCommandState,
    closeMention,
    closeSkillCommand,
    closePromptCommand,
    setMention,
    setSkillCommand,
    setPromptCommand,
    setMentionActiveIndex,
    setSkillCommandActiveIndex,
    setPromptCommandActiveIndex
  }), [
    closeMention,
    closePromptCommand,
    closeSkillCommand,
    mention,
    promptCommand,
    setMentionActiveIndex,
    setPromptCommandActiveIndex,
    setSkillCommandActiveIndex,
    skillCommand,
    updateCommandState
  ]);
}
