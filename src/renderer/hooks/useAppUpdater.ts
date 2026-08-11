import { useCallback, useEffect, useState } from "react";
import type { AppUpdateState } from "../../shared/ipc";
import { getBridge } from "../desktopApi";

const INITIAL_STATE: AppUpdateState = {
  phase: "idle",
  supported: false,
  installMode: "automatic",
  currentVersion: "",
  availableVersion: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  lastCheckedAt: null,
  error: null
};

export function useAppUpdater() {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const bridge = getBridge();
    const unsubscribe = bridge.onAppUpdateStateChanged((next) => {
      if (active) setState(next);
    });
    void bridge.getAppUpdateState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const check = useCallback(async () => {
    const next = await getBridge().checkForAppUpdate();
    setState(next);
    return next;
  }, []);

  const download = useCallback(async () => {
    const next = await getBridge().downloadAppUpdate();
    setState(next);
    return next;
  }, []);

  const install = useCallback(async () => {
    const next = await getBridge().installAppUpdate();
    setState(next);
    return next;
  }, []);

  const openDownloadPage = useCallback(async () => {
    const next = await getBridge().openAppUpdateDownloadPage();
    setState(next);
    return next;
  }, []);

  return { state, loading, check, download, install, openDownloadPage };
}
