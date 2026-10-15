// The interface language: English and Persian, chosen in Settings → Appearance (Auto from the browser, English, فارسی) and
// applied without a reload. One catalogue per language (`en.ts`, `fa.ts`); Latin digits in both (Dio Docs RTL-14). The root
// gets `lang` and `dir`, shadcn's DirectionProvider gets the direction, and every content block decides its own direction
// (see `components/bidi.tsx`).

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { DirectionProvider } from '@/components/ui/direction';
import { en } from './en.ts';
import { fa } from './fa.ts';

export type Lang = 'en' | 'fa';
export type LangPref = 'auto' | Lang;
export type Key = keyof typeof en;
export type Msg = string | { one: string; other: string };
export type Params = Record<string, string | number>;

const CATALOGS: Record<Lang, Record<Key, Msg>> = { en, fa };
const STORAGE_KEY = 'divan-lang';

export const dirOf = (lang: Lang): 'ltr' | 'rtl' => (lang === 'fa' ? 'rtl' : 'ltr');

/** The language the browser asks for first: Persian when that is `fa`, else English. */
export function browserLang(): Lang {
  const first = (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase();
  return first.startsWith('fa') ? 'fa' : 'en';
}

function storedPref(): LangPref {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'en' || value === 'fa' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

const resolve = (pref: LangPref): Lang => (pref === 'auto' ? browserLang() : pref);

// The language in force, for the few places that speak outside React (a toast raised from an event handler).
let current: Lang = resolve(storedPref());

function format(lang: Lang, msg: Msg, params?: Params): string {
  let text: string;
  if (typeof msg === 'string') text = msg;
  else {
    const count = Number(params?.count ?? 0);
    text = new Intl.PluralRules(lang).select(count) === 'one' ? msg.one : msg.other;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Whether the catalogues have this key (a code from a newer server may not be there yet). */
export const hasKey = (key: string): key is Key => key in en;

/** The language in force, for code that speaks outside React. */
export const currentLang = (): Lang => current;

/** A message in the language in force. */
export function translate(key: Key, params?: Params): string {
  return format(current, CATALOGS[current][key], params);
}

export interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  pref: LangPref;
  setPref: (next: LangPref) => void;
  t: (key: Key, params?: Params) => string;
  /** A message with parts that are not text: `{name}` is replaced by the node given for it. */
  tx: (key: Key, parts: Record<string, ReactNode>, params?: Params) => ReactNode;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LangPref>(storedPref);
  const lang = resolve(pref);
  current = lang;
  const dir = dirOf(lang);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = dir;
  }, [lang, dir]);

  const setPref = useCallback((next: LangPref) => {
    try {
      if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage that is off only loses the choice for next time
    }
    setPrefState(next);
  }, []);

  const value = useMemo<I18n>(() => {
    const t = (key: Key, params?: Params) => format(lang, CATALOGS[lang][key], params);
    const tx = (key: Key, parts: Record<string, ReactNode>, params?: Params): ReactNode => {
      const text = format(lang, CATALOGS[lang][key], params);
      return text.split(/(\{\w+\})/u).map((piece, index) => {
        const name = /^\{(\w+)\}$/u.exec(piece)?.[1];
        const node = name === undefined ? undefined : parts[name];
        // the pieces of a message never reorder, so the position is a stable key
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of fragments
        return <span key={index}>{node ?? piece}</span>;
      });
    };
    return { lang, dir, pref, setPref, t, tx };
  }, [lang, dir, pref, setPref]);

  return (
    <Context.Provider value={value}>
      <DirectionProvider direction={dir}>{children}</DirectionProvider>
    </Context.Provider>
  );
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error('I18nProvider is missing');
  return value;
}
