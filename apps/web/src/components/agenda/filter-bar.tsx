import { PERIOD_PRESETS } from "@events-tracker/api/period";
import {
	Check,
	ChevronDown,
	Copy,
	List,
	Map as MapIcon,
	Search,
	X,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { Agenda, Facet } from "@/hooks/use-agenda";
import { BUTTON, FIELD, LABEL, MICRO } from "./layout";
import { EventCount } from "./states";

/**
 * `value`, but only once it has held still for `delay` ms. The live region
 * reads this, so a screen reader hears where typing settled rather than every
 * keystroke's intermediate count.
 */
function useSettled<T>(value: T, delay: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return settled;
}

const CHEVRON =
	"pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground";

/**
 * Period chips are a toggle, not a radio: clicking the lit one clears the range,
 * so the fastest way out of "Hoje" is the same control that got you in.
 */
const CHIP_OFF =
	"inline-flex h-9 shrink-0 items-center rounded-[4px] border border-control bg-card px-3 text-[14px] font-medium text-foreground focus-ring motion-safe:transition-colors hover:border-primary/60 hover:text-primary";
const CHIP_ON =
	"inline-flex h-9 shrink-0 items-center rounded-[4px] border border-primary bg-primary px-3 text-[14px] font-medium text-primary-foreground focus-ring motion-safe:transition-colors";

function FacetSelect({
	id,
	label,
	value,
	all,
	options,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	all: string;
	options: Facet[];
	onChange: (value: string) => void;
}) {
	return (
		<div className="min-w-0">
			<label htmlFor={id} className={LABEL}>
				{label}
			</label>
			<div className="relative">
				<select
					id={id}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					className={`${FIELD} appearance-none pr-9`}
				>
					<option value="">{all}</option>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label} ({option.count})
						</option>
					))}
				</select>
				<ChevronDown aria-hidden="true" strokeWidth={1.5} className={CHEVRON} />
			</div>
		</div>
	);
}

function DateRange({
	id,
	label,
	value,
	min,
	max,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	min: string;
	max: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="min-w-0">
			<label htmlFor={id} className={LABEL}>
				{label}
			</label>
			<input
				id={id}
				type="date"
				value={value}
				min={min}
				max={max}
				onChange={(event) => onChange(event.target.value)}
				className={FIELD}
			/>
		</div>
	);
}

/**
 * One row of common ranges. The five facets below need two clicks and a date
 * picker each; "what's on tonight" is one click and that is most of the traffic.
 * The date inputs stay the precise path — a chip just fills them in.
 */
function PeriodChips({ agenda }: { agenda: Agenda }) {
	return (
		<fieldset className="m-0 mt-3 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
			{/* The visible caption is decorative; the legend names the group for
			    assistive tech without adding a line to the layout. */}
			<legend className="sr-only">Período</legend>
			<span
				aria-hidden="true"
				className={`${MICRO} mr-1 text-muted-foreground`}
			>
				Período
			</span>
			{PERIOD_PRESETS.map((preset) => {
				const lit = agenda.preset === preset.id;
				return (
					<button
						key={preset.id}
						type="button"
						aria-pressed={lit}
						onClick={() => agenda.setPeriod(lit ? null : preset.id)}
						className={lit ? CHIP_ON : CHIP_OFF}
					>
						{preset.label}
						{lit ? (
							<span className="sr-only"> (clique para limpar)</span>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
}

/**
 * Copy the current view's URL. Every filter change already writes the query
 * string, so this only has to hand it over — and it is the affordance that makes
 * the URL state discoverable instead of a hidden implementation detail.
 */
function CopyLinkButton({ className }: { className?: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(window.location.href);
			setState("copied");
		} catch {
			setState("failed");
		}
		window.setTimeout(() => setState("idle"), 1600);
	}, []);

	return (
		<button
			type="button"
			onClick={() => void copy()}
			className={className ?? BUTTON}
		>
			{state === "copied" ? (
				<Check
					aria-hidden="true"
					strokeWidth={1.5}
					className="size-4 text-primary"
				/>
			) : (
				<Copy aria-hidden="true" strokeWidth={1.5} className="size-4" />
			)}
			<span aria-live="polite">
				{state === "copied"
					? "Link copiado"
					: state === "failed"
						? "Não foi possível copiar"
						: "Copiar link"}
			</span>
		</button>
	);
}

/**
 * List or map: the same window, read two ways.
 *
 * A real segmented control rather than a link, because it is a view of the data
 * already on screen — and its state is in the URL with the filters, so the map
 * is as shareable as a filtered list.
 */
function ViewToggle({ agenda }: { agenda: Agenda }) {
	const views = [
		{ id: "lista", label: "Lista", Icon: List },
		{ id: "mapa", label: "Mapa", Icon: MapIcon },
	] as const;

	return (
		// biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and legend; this is a styled segmented control already labelled via aria-label
		<div
			role="group"
			aria-label="Vista"
			className="inline-flex h-11 shrink-0 items-center gap-0.5 rounded-[4px] border border-control p-0.5 sm:h-10"
		>
			{views.map(({ id, label, Icon }) => {
				const active = agenda.vista === id;
				return (
					<button
						key={id}
						type="button"
						onClick={() => agenda.setView(id)}
						aria-pressed={active}
						className={`focus-ring inline-flex h-full items-center gap-1.5 rounded-[3px] px-2.5 font-medium text-[14px] motion-safe:transition-colors ${
							active
								? "bg-primary text-primary-foreground"
								: "text-foreground hover:text-primary"
						}`}
					>
						<Icon aria-hidden="true" strokeWidth={1.5} className="size-4" />
						{label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * Filters, always visible from `sm` up and folded behind one labelled button on
 * a phone. Facet options come from the loaded window and carry their counts, so
 * no option is a dead end and the pickers are the same list as the agenda.
 *
 * One grid holds the search and all five facets, so every control shares a
 * column edge at `lg` instead of the search floating over an unrelated row.
 * The period chips sit outside that fold on purpose: on a phone they are the
 * one control worth reaching without opening anything.
 */
export function FilterBar({ agenda }: { agenda: Agenda }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const { filters, facets, rangeBounds } = agenda;

	const announcedShown = useSettled(agenda.visible.length, 600);

	const searchId = `${id}-q`;
	const facetsId = `${id}-facets`;

	return (
		<section aria-labelledby={`${id}-heading`}>
			<h2 id={`${id}-heading`} className="sr-only">
				Filtros
			</h2>

			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-0 flex-none basis-full sm:basis-[calc((200%_-_12px)/3)] lg:basis-[calc((200%_-_60px)/7)]">
					<label htmlFor={searchId} className={LABEL}>
						Procurar
					</label>
					<div className="group relative">
						<Search
							aria-hidden="true"
							strokeWidth={1.5}
							className={`pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground motion-safe:transition-[opacity,transform,filter] motion-safe:duration-150 ${
								filters.q
									? "opacity-100"
									: "scale-75 opacity-0 blur-[2px] group-focus-within:scale-100 group-focus-within:opacity-100 group-focus-within:blur-0"
							}`}
						/>
						<input
							id={searchId}
							type="search"
							value={filters.q}
							onChange={(event) => agenda.setFilter("q", event.target.value)}
							placeholder="Nome, local ou tema"
							autoComplete="off"
							spellCheck={false}
							enterKeyHint="search"
							className={`${FIELD} pl-9`}
						/>
					</div>
				</div>

				<button
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					aria-controls={facetsId}
					className={`${BUTTON} sm:hidden`}
				>
					Filtros
					{agenda.activeCount > 0 ? (
						<span className={`${MICRO} text-primary`}>
							{agenda.activeCount}
						</span>
					) : null}
					<ChevronDown
						aria-hidden="true"
						strokeWidth={1.5}
						className={`size-4 motion-safe:transition-transform motion-safe:duration-150 ${open ? "rotate-180" : ""}`}
					/>
				</button>

				{/* Top-right, and outside the fold on a phone: the list/map switch is
				    the one control that changes what the page is, not what is in it. */}
				<div className="ml-auto">
					<ViewToggle agenda={agenda} />
				</div>
			</div>

			<PeriodChips agenda={agenda} />

			<div
				id={facetsId}
				className={`mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7 ${open ? "" : "hidden sm:grid"}`}
			>
				<FacetSelect
					id={`${id}-city`}
					label="Concelho"
					all="Todos"
					value={filters.city}
					options={facets.cities}
					onChange={(value) => agenda.setFilter("city", value)}
				/>
				<FacetSelect
					id={`${id}-category`}
					label="Tipo"
					all="Todos"
					value={filters.category}
					options={facets.categories}
					onChange={(value) => agenda.setFilter("category", value)}
				/>
				<FacetSelect
					id={`${id}-venue`}
					label="Local"
					all="Todos"
					value={filters.venue}
					options={facets.venues}
					onChange={(value) => agenda.setFilter("venue", value)}
				/>
				<DateRange
					id={`${id}-from`}
					label="De"
					value={filters.from}
					min={rangeBounds.min}
					max={filters.to || rangeBounds.max}
					onChange={(value) => agenda.setFilter("from", value)}
				/>
				<DateRange
					id={`${id}-to`}
					label="Até"
					value={filters.to}
					min={filters.from || rangeBounds.min}
					max={rangeBounds.max}
					onChange={(value) => agenda.setFilter("to", value)}
				/>
			</div>

			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				{/* The visible count updates live; screen readers get the settled one
				    through the status region below, so typing does not spam them. */}
				<p
					aria-hidden="true"
					className="font-mono text-[12px] text-muted-foreground tabular-nums"
				>
					<EventCount
						total={agenda.rows.length}
						shown={agenda.visible.length}
						days={agenda.window.days}
					/>
				</p>
				<p role="status" className="sr-only">
					<EventCount
						total={agenda.rows.length}
						shown={announcedShown}
						days={agenda.window.days}
					/>
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<CopyLinkButton />
					{agenda.isFiltered ? (
						<button
							type="button"
							onClick={agenda.clearFilters}
							className={BUTTON}
						>
							<X aria-hidden="true" strokeWidth={1.5} className="size-4" />
							Limpar filtros
						</button>
					) : null}
				</div>
			</div>
		</section>
	);
}
