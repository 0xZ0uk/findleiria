import { useCallback, useEffect, useState } from "react";

/**
 * Two-state theme, hand-rolled.
 *
 * next-themes was doing this before, but the page has exactly one surface and
 * one toggle: the class on `<html>` *is* the state, and index.html's inline
 * script sets it before first paint so a light-mode visitor never sees a dark
 * flash. No provider, no `system` third state, no transition on switch — the
 * color change should be instant, not animated.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "findleiria-theme";
/** Keys an earlier build stored its preference under (rebrand, pre-rewrite). */
const LEGACY_STORAGE_KEYS = ["unreal443-theme", "theme"];

function readStored(): Theme {
	if (typeof localStorage === "undefined") return "dark";
	try {
		const stored = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]
			.map((key) => localStorage.getItem(key))
			.find((value) => value !== null);
		return stored === "light" ? "light" : "dark";
	} catch {
		return "dark";
	}
}

function applyTheme(theme: Theme) {
	const root = document.documentElement;
	root.classList.remove("dark", "light");
	root.classList.add(theme);
	root.style.colorScheme = theme;

	// Tint the browser chrome from the token itself rather than a second hex.
	const canvas = getComputedStyle(root).getPropertyValue("--background").trim();
	if (canvas)
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute("content", canvas);
}

export function useTheme() {
	const [theme, setThemeState] = useState<Theme>(readStored);

	// The inline script in index.html already applied this; re-applying on mount
	// keeps the DOM and React state from drifting if anything else touched it.
	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	const setTheme = useCallback((next: Theme) => {
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Private mode: the class still flips, it just will not be remembered.
		}
		applyTheme(next);
		setThemeState(next);
	}, []);

	return {
		theme,
		setTheme,
		toggle: useCallback(
			() => setTheme(theme === "dark" ? "light" : "dark"),
			[setTheme, theme],
		),
	};
}
