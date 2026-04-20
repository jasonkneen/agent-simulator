import * as React from "react";

type Theme = "light" | "dark" | "system";

type ThemeContext = {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
};

const Ctx = React.createContext<ThemeContext | null>(null);

const STORAGE_KEY = "agent-simulator.theme";

function resolve(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

function applyTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem(STORAGE_KEY) as Theme) || "dark";
  });
  const [resolved, setResolved] = React.useState<"light" | "dark">(() =>
    resolve(theme)
  );

  React.useEffect(() => {
    const r = resolve(theme);
    setResolved(r);
    applyTheme(r);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      const r = resolve("system");
      setResolved(r);
      applyTheme(r);
    };
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [theme]);

  return (
    <Ctx.Provider value={{ theme, resolved, setTheme: setThemeState }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
