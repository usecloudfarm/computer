import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const KEY = "cloudfarm.theme";

function initial(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The theme, as a class on `<html>`.
 *
 * Tailwind's dark variant is wired to `.dark` on an ancestor, so the class is
 * the state — a React-only value would leave the two out of step for anything
 * styled outside the tree, the Radix portals included.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return [theme, () => setTheme((current) => (current === "dark" ? "light" : "dark"))];
}
