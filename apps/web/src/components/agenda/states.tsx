import { RefreshCw, SearchX } from "lucide-react";
import type { Agenda } from "@/hooks/use-agenda";
import { plural } from "@/utils/format";
import { BUTTON, MICRO } from "./layout";

/** Loading: a few plausible rows, so the page keeps its shape. */
export function AgendaSkeleton() {
	const rows = [0, 1, 2];

	return (
		<>
			<p role="status" className="sr-only">
				A carregar a agenda…
			</p>
			<div className="mt-2" aria-hidden="true">
				{rows.map((group) => (
					<div key={group} className="mt-8 first:mt-0">
						<div className="h-5 w-36 rounded-[2px] bg-card motion-safe:animate-pulse" />
						{rows.map((row) => (
							<div key={row} className="mt-5 flex gap-3">
								<div className="hidden size-16 shrink-0 rounded-[4px] bg-card motion-safe:animate-pulse sm:block" />
								<div className="min-w-0 flex-1 space-y-2 pt-1">
									<div className="h-4 w-2/3 rounded-[2px] bg-card motion-safe:animate-pulse" />
									<div className="h-3 w-1/3 rounded-[2px] bg-card motion-safe:animate-pulse" />
								</div>
							</div>
						))}
					</div>
				))}
			</div>
		</>
	);
}

export function AgendaError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div role="alert" className="mt-4 max-w-[46ch]">
			<p className="p443-card-title">Não foi possível carregar a agenda.</p>
			<p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">
				A leitura dos dados falhou. Tenta de novo.
			</p>
			<p className="mt-3 line-clamp-3 break-words font-mono text-[12px] text-muted-foreground/70">
				{message}
			</p>
			<button type="button" onClick={onRetry} className={`${BUTTON} mt-5`}>
				<RefreshCw aria-hidden="true" strokeWidth={1.5} className="size-4" />
				Tentar de novo
			</button>
		</div>
	);
}

/**
 * Empty, in three flavours: a search that found nothing (name the term, offer
 * the way out), facets that excluded everything, and a genuinely empty window.
 */
export function AgendaEmpty({ agenda }: { agenda: Agenda }) {
	const term = agenda.filters.q.trim();

	const headline = term
		? `Nada corresponde a “${term}”.`
		: agenda.isFiltered
			? "Nenhum evento cumpre estes filtros."
			: `Ainda não há eventos nos próximos ${agenda.window.days} dias.`;

	const hint = agenda.isFiltered
		? "Experimenta outro termo ou limpa os filtros."
		: "A agenda é recolhida das fontes originais todos os dias, por isso volta a aparecer sozinha.";

	return (
		<div className="mt-8 max-w-[46ch]">
			<SearchX
				aria-hidden="true"
				strokeWidth={1.5}
				className="size-5 text-muted-foreground"
			/>
			<p className="p443-card-title mt-4">{headline}</p>
			<p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">
				{hint}
			</p>
			{agenda.isFiltered ? (
				<button
					type="button"
					onClick={agenda.clearFilters}
					className={`${BUTTON} mt-5`}
				>
					Limpar filtros
				</button>
			) : null}
		</div>
	);
}

/**
 * The window query stops at its row cap; say so rather than silently cutting.
 * With headroom restored this fires only when the window genuinely outgrows
 * the cap, which is the signal to page instead of raise it again.
 */
export function TruncationNote({
	count,
	days,
}: {
	count: number;
	days: number;
}) {
	return (
		<p className="mb-4 text-muted-foreground text-sm">
			Estão listados os primeiros {count} eventos dos próximos {days} dias.{" "}
			<span className="text-foreground">Há mais além destes.</span>
		</p>
	);
}

export function EventCount({
	total,
	shown,
	days,
}: {
	total: number;
	shown: number;
	days: number;
}) {
	if (shown !== total) {
		return (
			<>
				{shown} de {total} {plural(total, "evento", "eventos")}
			</>
		);
	}
	return (
		<>
			{total} {plural(total, "evento", "eventos")} nos próximos {days} dias
		</>
	);
}
