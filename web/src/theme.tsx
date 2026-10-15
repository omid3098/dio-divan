// Light, dark and system modes and shadcn's theme presets (Settings → Appearance). The mode is the `dark` class on the root,
// the preset a `data-preset` attribute (see `themes.css`, generated from shadcn's own presets). Both are kept per browser.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { PRESETS, type PresetId } from './themes.ts';

export type Mode = 'light' | 'dark' | 'system';
const MODE_KEY = 'divan-theme';
const PRESET_KEY = 'divan-preset';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const MODES: readonly Mode[] = ['light', 'dark', 'system'];
const PRESET_IDS = PRESETS.map((item) => item.id) as readonly PresetId[];
const storedMode = (): Mode => read(MODE_KEY, MODES, 'system');
const storedPreset = (): PresetId => read(PRESET_KEY, PRESET_IDS, 'neutral');

const resolvedDark = (mode: Mode): boolean =>
  mode === 'system' ? window.matchMedia(DARK_QUERY).matches : mode === 'dark';

function apply(mode: Mode, preset: PresetId): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolvedDark(mode));
  root.dataset.preset = preset;
}

/** Applied before the first frame is drawn, so a dark page does not flash light. */
export function applyStoredTheme(): void {
  apply(storedMode(), storedPreset());
}

interface Theme {
  mode: Mode;
  setMode: (next: Mode) => void;
  preset: PresetId;
  setPreset: (next: PresetId) => void;
  /** Whether the page is dark right now (the mode, or the system's choice). */
  dark: boolean;
}

const Context = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(storedMode);
  const [preset, setPresetState] = useState<PresetId>(storedPreset);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const update = () => setSystemDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // a change of the system's scheme re-applies "system"
  // biome-ignore lint/correctness/useExhaustiveDependencies: `systemDark` is what triggers it
  useEffect(() => apply(mode, preset), [mode, preset, systemDark]);

  const setMode = useCallback((next: Mode) => {
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // storage that is off only loses the choice for next time
    }
    setModeState(next);
  }, []);
  const setPreset = useCallback((next: PresetId) => {
    try {
      localStorage.setItem(PRESET_KEY, next);
    } catch {
      // as above
    }
    setPresetState(next);
  }, []);

  const value = useMemo<Theme>(
    () => ({
      mode,
      setMode,
      preset,
      setPreset,
      dark: mode === 'system' ? systemDark : mode === 'dark',
    }),
    [mode, setMode, preset, setPreset, systemDark],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTheme(): Theme {
  const value = useContext(Context);
  if (!value) throw new Error('ThemeProvider is missing');
  return value;
}
