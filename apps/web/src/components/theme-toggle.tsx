import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/utils/theme";

/**
 * One button, and its label names where the click lands ("mudar para tema
 * claro"), so the icon never has to carry the meaning on its own.
 */
export function ThemeToggle() {
	const { theme, toggle } = useTheme();
	const goingTo = theme === "dark" ? "claro" : "escuro";
	const Icon = theme === "dark" ? Sun : Moon;

	return (
		<button
			type="button"
			onClick={toggle}
			aria-label={`Mudar para tema ${goingTo}`}
			className="focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-[4px] border border-muted-foreground/60 text-muted-foreground hover:border-primary/60 hover:text-foreground motion-safe:transition-colors sm:size-10"
		>
			<Icon aria-hidden="true" strokeWidth={1.5} className="size-[18px]" />
		</button>
	);
}
