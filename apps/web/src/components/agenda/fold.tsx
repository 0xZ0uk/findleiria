import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Agenda, AgendaRow } from "@/hooks/use-agenda";
import { concelhoOf } from "@/utils/concelho";
import {
	clock,
	dayMonth,
	hasClock,
	plural,
	shiftDayKey,
	weekday,
} from "@/utils/format";
import { meshGradient } from "@/utils/mesh-gradient";
import { eventHref } from "@/utils/route";
import {
	eventTheme,
	THEME_INK,
	THEME_SURFACE,
	type ThemeGroup,
} from "@/utils/themes";
import { CAPTION, PRIMARY_BUTTON } from "./layout";

/** The id of the agenda section the fold's shortcuts land on. */
export const AGENDA_ANCHOR = "agenda";

const fullDate = new Intl.DateTimeFormat("pt-PT", {
	timeZone: "Europe/Lisbon",
	weekday: "long",
	day: "numeric",
	month: "long",
});
const shortWeekday = new Intl.DateTimeFormat("pt-PT", {
	timeZone: "Europe/Lisbon",
	weekday: "short",
});
const dayNumber = new Intl.DateTimeFormat("pt-PT", {
	timeZone: "Europe/Lisbon",
	day: "numeric",
});

const capitalize = (text: string) =>
	text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Bom sábado", "Boa segunda-feira": Saturday and Sunday are masculine, the
 * "-feira" days feminine, and the greeting agrees with them.
 */
function greeting(epochSeconds: number): string {
	const name = weekday(epochSeconds).toLowerCase();
	return `${name.endsWith("feira") ? "Boa" : "Bom"} ${name}.`;
}

/** Bring the agenda into view after a shortcut changed what it shows. */
function revealAgenda() {
	const target = document.getElementById(AGENDA_ANCHOR);
	if (!target) return;
	const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	target.scrollIntoView({
		behavior: still ? "auto" : "smooth",
		block: "start",
	});
}

/** `Sexta, 30 out. · 22:00 · Leiria`, leaving out what the source never gave. */
function whenWhere(row: AgendaRow): string {
	return [
		`${weekday(row.startAt)}, ${dayMonth(row.startAt)}`,
		hasClock(row.startAt) ? clock(row.startAt) : null,
		concelhoOf(row.venueCity) || row.venueCity,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The block's lead event.
 *
 * An editor's pick wins (`featuredAt`, set with the server's `feature` CLI):
 * the most recently picked one that has not finished. Without one, the page
 * picks honestly and says so in the caption: the next event this week that
 * has a poster, music or stage first, because a pick without a picture is a
 * weak lead.
 */
function leadOf(
	rows: AgendaRow[],
	week: AgendaRow[],
	now: number,
): { row: AgendaRow; curated: boolean } | null {
	const curated = rows
		.filter(
			(row) => row.featuredAt !== null && (row.endAt ?? row.startAt) >= now,
		)
		.sort((a, b) => (b.featuredAt ?? 0) - (a.featuredAt ?? 0))[0];
	if (curated) return { row: curated, curated: true };

	const upcoming = week.filter((row) => row.startAt >= now && row.imageUrl);
	const lead =
		upcoming.find((row) => {
			const theme = eventTheme(row.categories);
			return theme === "music" || theme === "stage";
		}) ?? upcoming[0];
	return lead ? { row: lead, curated: false } : null;
}

function Poster({ row, theme }: { row: AgendaRow; theme: ThemeGroup | null }) {
	const [broken, setBroken] = useState(false);
	return (
		<div
			style={meshGradient(row.slug, theme)}
			className="mt-5 aspect-[16/9] w-full overflow-hidden rounded-xl lg:aspect-auto lg:min-h-48 lg:flex-1"
		>
			{row.imageUrl && !broken ? (
				<img
					src={row.imageUrl}
					alt=""
					decoding="async"
					onError={() => setBroken(true)}
					className="size-full object-cover"
				/>
			) : null}
		</div>
	);
}

function LeadCard({ lead }: { lead: { row: AgendaRow; curated: boolean } }) {
	const { row, curated } = lead;
	const theme = eventTheme(row.categories);
	const category = row.categories[0];
	return (
		<article
			className={`flex flex-col rounded-[20px] p-5 sm:p-6 md:col-span-2 lg:col-span-1 lg:row-span-2 ${
				theme ? THEME_SURFACE[theme] : "border border-border bg-card"
			}`}
		>
			<p className={`${CAPTION} ${theme ? THEME_INK[theme] : "text-primary"}`}>
				{curated ? "Escolha da semana" : "Em destaque esta semana"}
				{category ? ` · ${category}` : ""}
			</p>
			<h2 className="mt-2 text-balance font-medium font-serif text-[1.5rem] leading-[1.15] tracking-[-0.015em] sm:text-[2rem]">
				{row.title}
			</h2>
			<Poster row={row} theme={theme} />
			<div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-[15px] text-foreground/80">{whenWhere(row)}</p>
				<a href={eventHref(row.slug)} className={PRIMARY_BUTTON}>
					Ver evento
					<ArrowRight
						aria-hidden="true"
						strokeWidth={1.75}
						className="size-4"
					/>
				</a>
			</div>
		</article>
	);
}

/** Tonight from 18:00; tomorrow's first three when tonight has nothing left. */
function TonightCard({
	rows,
	todayKey,
	dayStart,
	now,
}: {
	rows: AgendaRow[];
	todayKey: string;
	dayStart: number;
	now: number;
}) {
	const evening = dayStart + 18 * 3600;
	const tonight = rows.filter(
		(row) =>
			row.dayKey === todayKey &&
			hasClock(row.startAt) &&
			row.startAt >= evening &&
			row.startAt >= now - 1800,
	);
	const tomorrowKey = shiftDayKey(todayKey, 1);
	const shown = (
		tonight.length > 0
			? tonight
			: rows.filter(
					(row) => row.dayKey === tomorrowKey && hasClock(row.startAt),
				)
	).slice(0, 3);

	return (
		<article className="flex flex-col rounded-[20px] bg-primary-surface p-5 sm:p-6">
			<p className={`${CAPTION} text-primary`}>
				{tonight.length > 0 ? "Hoje à noite" : "Amanhã"}
			</p>
			<h2 className="type-section mt-1.5 text-[1.375rem]">
				{tonight.length > 0 ? "Para depois do jantar" : "Para amanhã"}
			</h2>
			{shown.length > 0 ? (
				<ul className="mt-3">
					{shown.map((row) => (
						<li key={row.id} className="border-primary/15 border-t">
							<a
								href={eventHref(row.slug)}
								className="focus-ring group grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 rounded-lg py-2.5 font-medium text-[15px]"
							>
								<time
									dateTime={new Date(row.startAt * 1000).toISOString()}
									className="tabular-nums"
								>
									{clock(row.startAt)}
								</time>
								<span className="min-w-0">
									<span className="line-clamp-1 group-hover:underline group-hover:decoration-from-font group-hover:underline-offset-3">
										{row.title}
									</span>
									<span className="block truncate font-normal text-[13px] text-muted-foreground">
										{row.venueName ?? row.venueCity}
									</span>
								</span>
							</a>
						</li>
					))}
				</ul>
			) : (
				<p className="mt-3 text-[15px] text-muted-foreground">
					Nada marcado com hora para hoje à noite nem para amanhã.
				</p>
			)}
		</article>
	);
}

function PlacesCard({ agenda, week }: { agenda: Agenda; week: AgendaRow[] }) {
	const top = useMemo(() => {
		const counts = new Map<string, number>();
		for (const row of week) {
			const name = concelhoOf(row.venueCity);
			if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return [...counts]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt"))
			.slice(0, 4);
	}, [week]);

	return (
		<article className="hidden flex-col rounded-[20px] border border-border bg-background p-5 sm:p-6 md:flex">
			<p className={`${CAPTION} text-primary`}>Por concelho</p>
			<h2 className="type-section mt-1.5 text-[1.375rem]">Onde há mais</h2>
			<ul className="mt-3">
				{top.map(([name, count]) => (
					<li key={name} className="border-border border-t">
						<button
							type="button"
							onClick={() => {
								agenda.setFilter("city", name);
								revealAgenda();
							}}
							className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left text-[15px] hover:text-primary"
						>
							{name}
							<span className="text-[14px] text-muted-foreground tabular-nums">
								{count}
							</span>
						</button>
					</li>
				))}
			</ul>
			<button
				type="button"
				onClick={() => {
					agenda.setView("mapa");
					revealAgenda();
				}}
				className="focus-ring mt-auto inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg pt-2 font-medium text-[14px] text-primary hover:underline hover:decoration-from-font hover:underline-offset-3"
			>
				Ver no mapa
				<ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-4" />
			</button>
		</article>
	);
}

function OutdoorsCard({ week, now }: { week: AgendaRow[]; now: number }) {
	const outdoors = week.filter(
		(row) => eventTheme(row.categories) === "outdoors" && row.startAt >= now,
	);
	const first = outdoors[0];
	return (
		<article className="flex flex-col rounded-[20px] bg-theme-outdoors p-5 sm:p-6">
			<p className={`${CAPTION} text-theme-outdoors-foreground`}>
				Festas e ar livre
			</p>
			{first ? (
				<>
					<h2 className="type-section mt-1.5 text-[1.25rem] sm:text-[1.375rem]">
						<a
							href={eventHref(first.slug)}
							className="focus-ring rounded-sm hover:underline hover:decoration-from-font hover:underline-offset-3"
						>
							{first.title}
						</a>
					</h2>
					<p className="mt-2 text-[14px] text-theme-outdoors-foreground sm:text-[15px]">
						{whenWhere(first)}
					</p>
					{outdoors.length > 1 ? (
						<p className="mt-auto pt-3 text-[14px] text-theme-outdoors-foreground">
							e mais {outdoors.length - 1} esta semana
						</p>
					) : null}
				</>
			) : (
				<p className="mt-2 text-[15px] text-theme-outdoors-foreground">
					Nada ao ar livre marcado esta semana.
				</p>
			)}
		</article>
	);
}

function FreeCard({ agenda, week }: { agenda: Agenda; week: AgendaRow[] }) {
	const free = week.filter((row) => row.isFree === true).length;
	return (
		<article className="flex flex-col rounded-[20px] border border-border bg-card p-5 sm:p-6">
			<p className={`${CAPTION} text-primary`}>Entrada livre</p>
			{free > 0 ? (
				<>
					<p className="mt-2 font-serif text-[2.75rem] tabular-nums leading-none sm:text-[3.5rem]">
						{free}
					</p>
					<p className="mt-1.5 text-[14px] text-muted-foreground">
						{plural(free, "evento gratuito", "eventos gratuitos")} esta semana
					</p>
					<button
						type="button"
						onClick={() => {
							agenda.setFilter("free", "1");
							agenda.setPeriod("7-dias");
							revealAgenda();
						}}
						className="focus-ring mt-auto inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg pt-2 font-medium text-[14px] text-primary hover:underline hover:decoration-from-font hover:underline-offset-3"
					>
						Ver todos
						<ArrowRight
							aria-hidden="true"
							strokeWidth={1.75}
							className="size-4"
						/>
					</button>
				</>
			) : (
				<p className="mt-2 text-[15px] text-muted-foreground">
					Nenhuma fonte confirmou entrada livre esta semana.
				</p>
			)}
		</article>
	);
}

/** The day strip: today and the six days after it, each with its count. */
function DayStrip({ agenda }: { agenda: Agenda }) {
	const { todayKey, from } = agenda.window;
	const days = useMemo(
		() =>
			Array.from({ length: 7 }, (_, index) => {
				const key = shiftDayKey(todayKey, index);
				// Noon, so a DST day can never tip the label into a neighbour.
				const noon = from + index * 86_400 + 12 * 3600;
				return {
					key,
					label: capitalize(
						shortWeekday.format(new Date(noon * 1000)).replace(".", ""),
					),
					number: dayNumber.format(new Date(noon * 1000)),
					count: agenda.rows.filter((row) => row.dayKey === key).length,
				};
			}),
		[todayKey, from, agenda.rows],
	);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and legend; this is a styled button row already labelled via aria-label
		<div
			role="group"
			aria-label="Escolher dia"
			className="scrollbar-none -mx-5 mt-6 flex snap-x snap-mandatory scroll-px-5 gap-2 overflow-x-auto px-5 sm:mx-0 sm:mt-8 sm:grid sm:grid-cols-7 sm:gap-2.5 sm:overflow-visible sm:px-0"
		>
			{days.map((day, index) => {
				const pressed =
					agenda.filters.from === day.key && agenda.filters.to === day.key;
				return (
					<button
						key={day.key}
						type="button"
						aria-pressed={pressed}
						onClick={() => {
							agenda.setDay(day.key);
							if (!pressed) revealAgenda();
						}}
						className={`focus-ring flex min-w-[5.25rem] shrink-0 snap-start flex-col items-start gap-0.5 rounded-2xl border px-3.5 py-3 text-left motion-safe:transition-colors sm:min-w-0 ${
							pressed
								? "border-primary bg-primary text-primary-foreground"
								: "border-border bg-background hover:border-control"
						}`}
					>
						<span
							className={`whitespace-nowrap font-medium text-[12px] ${pressed ? "text-primary-foreground-muted" : "text-muted-foreground"}`}
						>
							{day.label}
							{index === 0 ? " · hoje" : ""}
						</span>
						<span className="font-medium font-serif text-[1.5rem] tabular-nums leading-[1.1] sm:text-[1.75rem]">
							{day.number}
						</span>
						<span
							className={`whitespace-nowrap text-[13px] ${pressed ? "text-primary-foreground-muted" : "text-muted-foreground"}`}
						>
							{day.count} {plural(day.count, "evento", "eventos")}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function FoldSkeleton() {
	const block = "rounded-[20px] bg-card motion-safe:animate-pulse";
	return (
		<div aria-hidden="true">
			<div className="mt-6 flex gap-2 overflow-hidden sm:mt-8 sm:grid sm:grid-cols-7 sm:gap-2.5">
				{Array.from({ length: 7 }, (_, index) => (
					<div
						key={index}
						className="h-[92px] min-w-[5.25rem] rounded-2xl bg-card motion-safe:animate-pulse"
					/>
				))}
			</div>
			<div className="mt-4 grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr]">
				<div
					className={`${block} h-72 md:col-span-2 lg:col-span-1 lg:row-span-2 lg:h-auto`}
				/>
				<div className={`${block} h-56`} />
				<div className={`${block} hidden h-56 md:block`} />
				<div className={`${block} h-44`} />
				<div className={`${block} h-44`} />
			</div>
		</div>
	);
}

/**
 * The top of the agenda: a greeting with the week's count, the day strip, and
 * five blocks that each answer one question — what's the pick, what's on
 * tonight, where, what's outdoors, what's free. Every block is a shortcut into
 * the same filtered agenda below, never a separate list.
 *
 * The week is today and the six days after it, read from the unfiltered rows,
 * so the fold does not shift while the reader filters the list.
 */
export function Fold({ agenda }: { agenda: Agenda }) {
	const { todayKey, from } = agenda.window;
	// Minute resolution, so the memos below hold across re-renders.
	const now = Math.floor(Date.now() / 60_000) * 60;
	const weekEnd = shiftDayKey(todayKey, 6);
	const week = useMemo(
		() =>
			agenda.rows.filter(
				(row) => row.dayKey >= todayKey && row.dayKey <= weekEnd,
			),
		[agenda.rows, todayKey, weekEnd],
	);
	const lead = useMemo(
		() => leadOf(agenda.rows, week, now),
		[agenda.rows, week, now],
	);

	const ready = agenda.status === "ready";
	const count = week.length;
	const today = capitalize(fullDate.format(new Date((from + 43_200) * 1000)));

	return (
		<section aria-labelledby="fold-title" className="pt-8 sm:pt-12">
			<p className={`${CAPTION} text-primary`}>
				{today}
				{agenda.lastRunLabel ? (
					<span className="text-muted-foreground">
						{" "}
						· Última recolha {agenda.lastRunLabel}
					</span>
				) : null}
			</p>
			<h1
				id="fold-title"
				className="type-display mt-3 max-w-[20ch] text-balance"
			>
				{greeting(from + 43_200)}{" "}
				{ready ? (
					<>
						Há{" "}
						<em className="text-primary italic">
							{count} {plural(count, "coisa", "coisas")}
						</em>{" "}
						a acontecer esta semana.
					</>
				) : agenda.status === "loading" ? (
					"A ver o que se passa esta semana…"
				) : (
					"O que se passa em Leiria."
				)}
			</h1>

			{agenda.status === "loading" ? <FoldSkeleton /> : null}

			{ready ? (
				<>
					<DayStrip agenda={agenda} />
					<div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4 md:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr]">
						{lead ? <LeadCard lead={lead} /> : null}
						<TonightCard
							rows={agenda.rows}
							todayKey={todayKey}
							dayStart={from}
							now={now}
						/>
						<PlacesCard agenda={agenda} week={week} />
						<div className="grid gap-3 sm:gap-4 md:contents min-[400px]:grid-cols-2">
							<OutdoorsCard week={week} now={now} />
							<FreeCard agenda={agenda} week={week} />
						</div>
					</div>
				</>
			) : null}
		</section>
	);
}
