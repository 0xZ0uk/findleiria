import { lazy, Suspense, useMemo } from "react";
import { CAPTION } from "@/components/agenda/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import type { Agenda } from "@/hooks/use-agenda";
import {
	districtRoster,
	heatOpacity,
	isDistrictConcelho,
	peak,
	tallyConcelhos,
} from "@/utils/concelho";
import { pinCoverage, pinTallies } from "@/utils/pins";

/**
 * Leaflet is ~150 kB and only the map view needs it, so the chunk is fetched
 * with the view rather than with the agenda everybody lands on.
 */
const ConcelhoMap = lazy(() => import("./concelho-map"));

/**
 * How many places the side list names before it starts counting the rest.
 *
 * The map draws every one of them; a list that listed all 90 would be a scroll
 * nobody finishes. The remainder is stated rather than implied, so the list is
 * never mistaken for the full set.
 */
const PLACES_SHOWN = 12;

/**
 * The map reading of the agenda.
 *
 * A choropleth, not a heat map: every event here is already placed in a
 * concelho by its venue, so the honest unit is the concelho — a continuous
 * density field would invent a gradient between two towns, and the venues are
 * far too sparse for that (SLICE_14).
 *
 * Layer 2 adds the places themselves: the 109 venues the pipeline could place
 * inside their own concelho draw as dots, sized by their own event count, and
 * the ones it refused (no coordinates, or a município's own name) simply are
 * not dots. The two layers carry different denominators on purpose, and the
 * coverage line says so out loud.
 *
 * The numbers beside it are the same tallies as real buttons: the map is the
 * fast read, the lists are the accessible one, and neither is a second source
 * of truth.
 */
export function MapView({ agenda }: { agenda: Agenda }) {
	const tallies = useMemo(
		() => tallyConcelhos(agenda.mapRows),
		[agenda.mapRows],
	);
	const busiest = useMemo(() => peak(tallies), [tallies]);
	const counts = useMemo(
		() =>
			new Map(
				tallies.filter((tally) => tally.mappable).map((t) => [t.name, t.count]),
			),
		[tallies],
	);
	const drawable = districtRoster(tallies);
	const outside = tallies.filter((tally) => !tally.mappable);
	const selected = isDistrictConcelho(agenda.filters.city)
		? agenda.filters.city
		: "";
	const placed = agenda.mapRows.length;

	const pins = useMemo(() => pinTallies(agenda.mapRows), [agenda.mapRows]);
	const coverage = useMemo(() => pinCoverage(agenda.mapRows), [agenda.mapRows]);
	const selectedVenue = agenda.filters.venue;
	const listed = pins.slice(0, PLACES_SHOWN);

	/**
	 * One sentence, and it says which denominator it is using. With a concelho
	 * picked the interesting number is "of the district", because the map is
	 * still drawing the district.
	 */
	const status = !selected
		? `${placed} ${placed === 1 ? "evento" : "eventos"} em ${drawable.length} ${
				drawable.length === 1 ? "concelho" : "concelhos"
			}`
		: `${selected}: ${counts.get(selected) ?? 0} de ${placed}`;

	const toggle = (name: string) => {
		agenda.setFilter("city", selected === name ? "" : name);
	};

	const toggleVenue = (slug: string) => {
		agenda.setFilter("venue", selectedVenue === slug ? "" : slug);
	};

	return (
		<section aria-labelledby="mapa-heading">
			<h2 id="mapa-heading" className="sr-only">
				Atividade por concelho e por local
			</h2>

			<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
				<div className="min-w-0">
					<ErrorBoundary title="O mapa não carregou.">
						<Suspense
							fallback={
								<div className="h-[58svh] min-h-[320px] w-full rounded-[20px] border border-border bg-card motion-safe:animate-pulse sm:h-[520px]" />
							}
						>
							<ConcelhoMap
								counts={counts}
								max={busiest}
								selected={selected}
								onSelect={toggle}
								pins={pins}
								selectedVenue={selectedVenue}
								onSelectVenue={toggleVenue}
							/>
						</Suspense>
					</ErrorBoundary>

					<div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
							<p className="flex items-center gap-2">
								<span className={`${CAPTION} text-muted-foreground`}>
									Menos
								</span>
								{[0, 0.25, 0.6, 1].map((step) => (
									<span
										key={step}
										aria-hidden="true"
										className="block size-3.5 rounded-full bg-primary"
										style={{ opacity: heatOpacity(step * busiest, busiest) }}
									/>
								))}
								<span className={`${CAPTION} text-muted-foreground`}>Mais</span>
							</p>
							<p className="flex items-center gap-2">
								<span
									aria-hidden="true"
									className="block size-3.5 rounded-full border-2 border-background bg-primary"
								/>
								<span className={`${CAPTION} text-muted-foreground`}>
									Local
								</span>
								<span
									aria-hidden="true"
									className="block size-3.5 rounded-full border border-primary border-dashed bg-primary/15"
								/>
								<span className={`${CAPTION} text-muted-foreground`}>
									Povoação
								</span>
							</p>
						</div>
						<p className="text-[13px] text-muted-foreground tabular-nums">
							{status}
						</p>
					</div>

					<p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
						Cada evento conta no concelho do seu local. O mapa ignora os seus
						próprios filtros — clicar num concelho ou num ponto muda o filtro, e
						voltar a clicar liberta-o — para os concelhos vizinhos continuarem
						comparáveis.
					</p>
					<p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">
						Só os locais com coordenadas verificadas dentro do seu concelho são
						pontos: {coverage.pinned} eventos desta janela
						{coverage.settlements > 0
							? `, mais ${coverage.settlements} em povoações`
							: ""}{" "}
						de {coverage.total}. Os restantes contam no concelho, onde o número
						não depende de adivinhar um ponto.
					</p>
				</div>

				<div className="min-w-0">
					<h3 className="flex items-baseline justify-between gap-3 border-foreground border-b pb-2.5 font-medium font-serif text-[1.125rem] leading-[1.3]">
						Por concelho
					</h3>
					<ol className="mt-3 flex flex-col gap-1">
						{drawable.map((tally) => {
							const isSelected = selected === tally.name;
							return (
								<li key={tally.name}>
									<button
										type="button"
										onClick={() => toggle(tally.name)}
										aria-pressed={isSelected}
										className={`group focus-ring flex w-full items-baseline justify-between gap-3 rounded-xl border px-3 py-2 text-left motion-safe:transition-colors ${
											isSelected
												? "border-primary bg-primary-surface"
												: "border-transparent hover:border-border hover:bg-card"
										}`}
									>
										<span className="min-w-0">
											<span
												className={`block truncate font-medium font-serif text-[16px] ${
													isSelected ? "text-primary" : "text-foreground"
												}`}
											>
												{tally.name}
											</span>
											<span
												aria-hidden="true"
												className="mt-1.5 block h-1 rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-200"
												style={{
													width: `${busiest > 0 ? Math.max(2, (tally.count / busiest) * 100) : 0}%`,
													opacity: heatOpacity(tally.count, busiest),
												}}
											/>
										</span>
										<span className="text-[13px] text-muted-foreground tabular-nums">
											{tally.count}
										</span>
									</button>
								</li>
							);
						})}
					</ol>

					{pins.length > 0 ? (
						<div className="mt-8">
							<h3 className="flex items-baseline justify-between gap-3 border-foreground border-b pb-2.5 font-medium font-serif text-[1.125rem] leading-[1.3]">
								Locais no mapa
							</h3>
							<ul className="mt-2 flex flex-col gap-1">
								{listed.map((pin) => {
									const isSelected = selectedVenue === pin.slug;
									return (
										<li key={pin.slug}>
											<button
												type="button"
												onClick={() => toggleVenue(pin.slug)}
												aria-pressed={isSelected}
												className={`group focus-ring flex w-full items-baseline justify-between gap-3 rounded-xl border px-3 py-1.5 text-left motion-safe:transition-colors ${
													isSelected
														? "border-primary bg-primary-surface"
														: "border-transparent hover:border-border hover:bg-card"
												}`}
											>
												<span className="min-w-0">
													<span
														className={`block truncate text-[14px] ${
															isSelected ? "text-primary" : "text-foreground"
														}`}
													>
														{pin.name}
													</span>
													<span className="block truncate text-[12px] text-muted-foreground">
														{pin.scope === "lugar"
															? `povoação · ${pin.concelho}`
															: pin.concelho}
													</span>
												</span>
												<span className="text-[13px] text-muted-foreground tabular-nums">
													{pin.count}
												</span>
											</button>
										</li>
									);
								})}
							</ul>
							<p className="mt-2 px-3 text-[13px] text-muted-foreground leading-relaxed">
								{pins.length > listed.length
									? `${listed.length} de ${pins.length} locais com coordenadas — os restantes estão no mapa e não nesta lista. O mapa desenha todos.`
									: `${pins.length} ${pins.length === 1 ? "local" : "locais"} com coordenadas. Cada ponto é um local verificado dentro do seu concelho.`}
							</p>
						</div>
					) : null}

					{outside.length > 0 ? (
						<div className="mt-8">
							<h3 className="flex items-baseline justify-between gap-3 border-foreground border-b pb-2.5 font-medium font-serif text-[1.125rem] leading-[1.3]">
								Fora do mapa
							</h3>
							<ul className="mt-2">
								{outside.map((tally) => (
									<li
										key={tally.name}
										className="flex items-baseline justify-between gap-3 px-3 py-1 text-[14px] text-muted-foreground"
									>
										<span className="min-w-0 truncate">{tally.name}</span>
										<span className="text-[13px] tabular-nums">
											{tally.count}
										</span>
									</li>
								))}
							</ul>
							<p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
								Eventos cujo local não cai em nenhum concelho do distrito. Não
								são escondidos nem atribuídos a um concelho por adivinhação.
							</p>
						</div>
					) : null}
				</div>
			</div>
		</section>
	);
}
