import { Wordmark } from "./wordmark";

export function PageFooter() {
	return (
		<footer className="mt-24 flex flex-col gap-4 border-border border-t py-10 sm:flex-row sm:items-baseline sm:justify-between">
			<Wordmark />
			<p className="max-w-[62ch] text-[14px] text-muted-foreground leading-relaxed sm:text-right">
				Agenda de Leiria e dos concelhos do distrito, recolhida automaticamente
				das fontes originais. Cada evento leva ao sítio de onde veio.
			</p>
		</footer>
	);
}
