import { createContext, type ReactNode, useContext } from "react";
import { type Saved, useSaved } from "@/hooks/use-saved";

const SavedContext = createContext<Saved | null>(null);

/**
 * One `useSaved()` for a whole page. Every row's save button used to run its
 * own — a session subscription plus query and mutation observers each, so a
 * long agenda meant thousands of observers. Buttons now read this instead.
 */
export function SavedProvider({ children }: { children: ReactNode }) {
	const saved = useSaved();
	return (
		<SavedContext.Provider value={saved}>{children}</SavedContext.Provider>
	);
}

export function useSavedStore(): Saved {
	const saved = useContext(SavedContext);
	if (!saved)
		throw new Error("useSavedStore must be used inside <SavedProvider>");
	return saved;
}
