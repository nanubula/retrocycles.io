// Wires the account sync (configSync.ts) to the page: runs for a signed-in, registered player once
// the game is ready; a guest or a signed-out player makes no config call at all. Only App and the
// hooks talk to aa; the calls themselves are in platform/client.ts.
import { useEffect, useRef } from "react";
import type { Aa } from "../aa/types";
import { getMyConfig, putMyConfig } from "../platform/client";
import { LANGS, setLang, useLang } from "../i18n";
import type { Lang } from "../i18n";
import { onSettingsChanged } from "./changed";
import { createConfigSync } from "./configSync";
import type { ConfigSync } from "./configSync";
import { applyFrameRate, noteFrameRateSetting, setHudStyle, useHudStyle } from "./hudStyle";
import type { SettingsStore } from "./store";
import { SYNC_STATE_KEY } from "./sync";

export interface ConfigSyncUser {
  id: string;
  isGuest: boolean;
}

export function useConfigSync(aa: Aa | null, ready: boolean, apiUrl: string | null, user: ConfigSyncUser | null, store: SettingsStore): void {
  const storeRef = useRef(store);
  storeRef.current = store;
  const sync = useRef<ConfigSync | null>(null);
  const hud = useHudStyle();
  const lang = useLang();
  const userId = user && !user.isGuest ? user.id : null;

  useEffect(() => {
    if (!aa || !ready || !apiUrl || !userId) return;
    const s = createConfigSync({
      userId,
      get: () => getMyConfig(apiUrl),
      put: (text, version, keepalive) => putMyConfig(apiUrl, text, version, keepalive),
      exportConfig: () => aa.exportConfig(),
      importConfig: (text) => aa.importConfig(text),
      readPage: (key) => storeRef.current.page(key),
      writePage(key, value) {
        // the page's own setters, so what is on screen follows at once
        if (key === "rc.hudStyle") setHudStyle(value === "classic" ? "classic" : "modern");
        else if (key === "rc.showFps") {
          noteFrameRateSetting("SHOW_FPS", value === "1" ? "1" : "0");
          applyFrameRate(aa, value === "1");
        } else if (key === "rc.lang" && value) {
          if (LANGS.some((l) => l.id === value)) void setLang(value as Lang);
        } else storeRef.current.setPage(key, value);
      },
      applied: () => storeRef.current.touch(),
      loadState: () => {
        try {
          return localStorage.getItem(SYNC_STATE_KEY);
        } catch {
          return null;
        }
      },
      saveState: (text) => {
        try {
          localStorage.setItem(SYNC_STATE_KEY, text);
        } catch {
          // blocked storage: synced again next time
        }
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
      log: (line) => console.info(line)
    });
    sync.current = s;
    const off = onSettingsChanged(() => s.changed());
    const leave = () => void s.flush(true);
    window.addEventListener("pagehide", leave);
    void s.start();
    return () => {
      off();
      window.removeEventListener("pagehide", leave);
      s.stop();
      sync.current = null;
    };
  }, [aa, ready, apiUrl, userId]);

  // the HUD style and the language change without the store (Settings sets them itself)
  useEffect(() => {
    sync.current?.changed();
  }, [hud, lang]);
}
