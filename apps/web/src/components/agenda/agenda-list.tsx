import { SaveButton } from "@/components/saved/save-button";
import type { Agenda, AgendaRow } from "@/hooks/use-agenda";
import { clock, hasClock, plural, shortDay } from "@/utils/format";
import { eventHref } from "@/utils/route";
import { EventRow } from "./event-row";
import { GUTTER } from "./layout";
import {
	AgendaEmpty,
	AgendaError,
	AgendaSkeleton,
	TruncationNote,
} from "./states";

/**
 * Chips for a row: the active category filter first, because a filtered row has
 * to show why it is still on screen, then the other categories, then the range.
 * Only two categories fit at this size.
 */
function chipsFor(event: AgendaRow, activeCategory: string): string[] {
	const ordered = activeCategory
		? [
				...event.categories.filter((category) => category === activeCategory),
				...event.categories.filter((category) => category !== activeCategory),
			]
		: event.categories;
	const chips = ordered.slice(0, 2);
	if (
		event.endAt !== null &&
		event.endDayKey !== null &&
		event.endDayKey !== event.dayKey
	)
		chips.unshift(`até ${shortDay(event.endAt)}`);
	return chips;
}

/** A clock when the source gave one; a dash when it only gave a day. */
function timeOf(event: AgendaRow) {
	if (hasClock(event.startAt)) return clock(event.startAt);
	return (
		<>
			<span aria-hidden="true">—</span>
			<span className="sr-only">hora por confirmar</span>
		</>
	);
}

export function AgendaList({ agenda }: { agenda: Agenda }) {
	if (agenda.status === "loading") return <AgendaSkeleton />;
	if (agenda.status === "error")
		return (
			<AgendaError
				what="a agenda"
				message={
					agenda.error instanceof Error
						? agenda.error.message
						: String(agenda.error)
				}
				onRetry={() => void agenda.refetch()}
			/>
		);
	if (agenda.groups.length === 0) return <AgendaEmpty agenda={agenda} />;

	return (
		<div className="pt-8">
			{agenda.truncated ? (
				<TruncationNote count={agenda.rows.length} days={agenda.window.days} />
			) : null}

			{agenda.groups.map((group) => (
				<section
					key={group.key}
					aria-labelledby={`dia-${group.key}`}
					className="mt-10 first:mt-0"
				>
					<h2
						id={`dia-${group.key}`}
						className={`${GUTTER} sticky top-0 z-10 flex items-baseline justify-between gap-4 border-border border-b bg-background/90 py-3 backdrop-blur-sm`}
					>
						<span className="p443-card-title">
							{group.label}
							<span className="ml-2 font-mono font-normal text-[12px] text-muted-foreground tabular-nums">
								{group.date}
							</span>
						</span>
						<span className="shrink-0 font-mono text-[12px] text-muted-foreground tabular-nums">
							{group.events.length}{" "}
							{plural(group.events.length, "evento", "eventos")}
						</span>
					</h2>

					<ul className="mt-2">
						{group.events.map((event) => (
							<EventRow
								key={event.id}
								title={event.title}
								detailHref={eventHref(event.slug)}
								href={event.url}
								imageUrl={event.imageUrl}
								seed={event.slug}
								time={timeOf(event)}
								dateTime={new Date(event.startAt * 1000).toISOString()}
								venue={event.venueName}
								city={event.venueCity}
								chips={chipsFor(event, agenda.filters.category)}
								extraSessions={[...event.sessionStarts]
									.slice(1)
									.filter(hasClock)
									.sort((a, b) => a - b)
									.map(clock)}
								saveSlot={<SaveButton slug={event.slug} layout="row" />}
							/>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
