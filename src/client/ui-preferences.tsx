import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Bot } from 'lucide-react';
import { api, patch } from './api';
import type { UiPreferences } from '../shared/types';
import {
  shellTokens,
  defaultAccent,
  isAccentColor,
  defaultPattern,
  isColorPattern,
  patternFromAccent,
  type ColorMode,
} from '../shared/appearance';
import {
  fontSizes,
  defaultFontSize,
  fontStorageKey,
  readFontSize,
  type FontSize,
} from '../shared/typography';
const defaults: UiPreferences = {
  theme: 'system',
  assistantIcon: null,
  accentColor: defaultAccent,
  colorPattern: defaultPattern,
};
const UiContext = createContext({
  preferences: defaults,
  resolvedTheme: 'light' as ColorMode,
  fontSize: defaultFontSize,
  setFontSize: (_value: FontSize): boolean => false,
  activate: (_id?: string) => {},
  save: async (_value: UiPreferences) => {},
});
export function UiProvider({ children }: { children: ReactNode }) {
  const [fontSize, updateFontSize] = useState<FontSize>(defaultFontSize);
  const [preferences, setPreferences] = useState<UiPreferences>(() => {
    const theme = localStorage.getItem('drift:theme');
    const accentColor = localStorage.getItem('drift:accent');
    const colorPattern = localStorage.getItem('drift:pattern');
    return {
      ...defaults,
      theme: theme === 'dark' || theme === 'light' ? theme : 'system',
      accentColor: isAccentColor(accentColor) ? accentColor : defaultAccent,
      colorPattern: isColorPattern(colorPattern)
        ? colorPattern
        : isAccentColor(accentColor)
          ? patternFromAccent(accentColor)
          : defaultPattern,
    };
  });
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const identity = useRef<string | undefined>(undefined);
  const activate = useCallback((id?: string) => {
    identity.current = id;
    updateFontSize(readFontSize(id));
    setPreferences((prev) => ({ ...prev, assistantIcon: null }));
    if (id)
      api<UiPreferences>('/preferences')
        .then((value) => {
          if (identity.current === id) setPreferences({ ...defaults, ...value });
        })
        .catch(() => {});
  }, []);
  const setFontSize = useCallback((value: FontSize) => {
    updateFontSize(value);
    if (!identity.current) return false;
    try {
      localStorage.setItem(fontStorageKey(identity.current), value);
      return true;
    } catch {
      return false;
    }
  }, []);
  useLayoutEffect(() => {
    const size = fontSizes.find((item) => item.id === fontSize)!;
    document.documentElement.dataset.fontSize = fontSize;
    document.documentElement.style.setProperty('--font-scale', String(size.scale));
    document.documentElement.style.setProperty('--detail-scale', String(size.detailScale));
  }, [fontSize]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        identity.current &&
        (event.key === null || event.key === fontStorageKey(identity.current))
      )
        updateFontSize(readFontSize(identity.current));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const save = useCallback(async (value: UiPreferences) => {
    const id = identity.current;
    const saved = await patch<UiPreferences>('/preferences', value);
    if (identity.current === id) setPreferences(saved);
  }, []);
  const resolvedTheme =
    preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    localStorage.setItem('drift:theme', preferences.theme);
  }, [resolvedTheme, preferences.theme]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.colorPattern = preferences.colorPattern;
    for (const [name, value] of Object.entries(shellTokens(resolvedTheme)))
      root.style.setProperty(name, value);
    localStorage.setItem('drift:pattern', preferences.colorPattern);
  }, [preferences.colorPattern, resolvedTheme]);
  return (
    <UiContext.Provider
      value={{ preferences, resolvedTheme, fontSize, setFontSize, activate, save }}
    >
      {children}
    </UiContext.Provider>
  );
}
export const useUi = () => useContext(UiContext);
export function AssistantAvatar() {
  const { preferences } = useUi();
  return (
    <span className="assistant-avatar">
      {preferences.assistantIcon ? (
        <img src={preferences.assistantIcon} alt="Chatbot 头像" />
      ) : (
        <Bot size={19} aria-label="Chatbot 头像" />
      )}
    </span>
  );
}
