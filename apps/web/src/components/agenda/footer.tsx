import { MICRO } from "./layout";

export function PageFooter() {
	return (
		<footer className="mt-20 border-border border-t py-10">
			<p className="max-w-[62ch] text-muted-foreground text-sm leading-relaxed">
				Agenda de Leiria e dos concelhos do distrito, recolhida automaticamente
				das fontes originais. Cada linha abre no sítio de onde veio.
			</p>
			<p className={`${MICRO} mt-4 text-muted-foreground`}>
				FindLeiria · Leiria
			</p>
		</footer>
	);
}
