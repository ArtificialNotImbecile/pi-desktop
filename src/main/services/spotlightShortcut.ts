import type { SpotlightShortcutStatus } from "../../shared/ipc.js";

export type GlobalShortcutBackend = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
};

type ShortcutSnapshot = {
  desiredAccelerator: string | null;
  registeredAccelerator: string | null;
};

export class SpotlightShortcutManager {
  private desiredAccelerator: string | null = null;
  private registeredAccelerator: string | null = null;

  constructor(
    private readonly backend: GlobalShortcutBackend,
    private readonly onShortcut: () => void
  ) {}

  initialize(accelerator: string): boolean {
    const next = accelerator.trim();
    this.desiredAccelerator = next;
    try {
      if (!this.backend.register(next, this.onShortcut)) return false;
      this.registeredAccelerator = next;
      return true;
    } catch {
      return false;
    }
  }

  replace(accelerator: string): () => void {
    const next = accelerator.trim();
    const previous = this.snapshot();
    if (previous.registeredAccelerator === next && this.backend.isRegistered(next)) {
      this.desiredAccelerator = next;
      return () => undefined;
    }

    let registered = false;
    try {
      registered = this.backend.register(next, this.onShortcut);
    } catch {
      registered = false;
    }
    if (!registered) {
      throw new Error(`The shortcut ${next} is already in use or unavailable. Choose another shortcut.`);
    }

    if (previous.registeredAccelerator && previous.registeredAccelerator !== next) {
      this.backend.unregister(previous.registeredAccelerator);
    }
    this.desiredAccelerator = next;
    this.registeredAccelerator = next;

    return () => this.restore(previous, next);
  }

  getStatus(defaultAccelerator: string): SpotlightShortcutStatus {
    const accelerator = this.desiredAccelerator ?? defaultAccelerator;
    return {
      accelerator,
      defaultAccelerator,
      registered: this.registeredAccelerator === accelerator && this.backend.isRegistered(accelerator)
    };
  }

  dispose(): void {
    if (this.registeredAccelerator) this.backend.unregister(this.registeredAccelerator);
    this.registeredAccelerator = null;
  }

  private snapshot(): ShortcutSnapshot {
    return {
      desiredAccelerator: this.desiredAccelerator,
      registeredAccelerator: this.registeredAccelerator
    };
  }

  private restore(previous: ShortcutSnapshot, replacement: string): void {
    let restored = previous.registeredAccelerator === null;
    if (previous.registeredAccelerator && previous.registeredAccelerator !== replacement) {
      try {
        restored = this.backend.register(previous.registeredAccelerator, this.onShortcut);
      } catch {
        restored = false;
      }
    } else if (previous.registeredAccelerator === replacement) {
      restored = this.backend.isRegistered(replacement);
    }

    if (replacement !== previous.registeredAccelerator) this.backend.unregister(replacement);
    this.desiredAccelerator = previous.desiredAccelerator;
    this.registeredAccelerator = restored ? previous.registeredAccelerator : null;
  }
}
