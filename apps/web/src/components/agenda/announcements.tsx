import type { Agenda } from "@/hooks/use-agenda";
import { EventRow } from "./event-row";
import { CAPTION } from "./layout";

/**
 * The source's own undated listings. Real, rare, and kept out of the days: an
 * event with no date cannot sit under a date heading without lying.
 */
export function Announcements({ agenda }: { agenda: Agenda }) {
	if (agenda.announcements.length === 0) return null;

	return (
		<section
			aria-labelledby="anuncios"
			className="mt-24 border-foreground border-t pt-8"
		>
			<h2 id="anuncios" className="type-section">
				Datas por confirmar
			</h2>
			<p className="mt-3 max-w-[54ch] text-[15px] text-muted-foreground leading-relaxed">
				Anunciados pelas fontes, ainda sem dia marcado. Passam para a agenda
				assim que a data aparecer.
			</p>

			<ul className="mt-6">
				{agenda.announcements.map((event) => (
					<EventRow
						key={event.id}
						title={event.title}
						detailHref={null}
						href={event.url}
						imageUrl={event.imageUrl}
						seed={String(event.id)}
						time="sem data"
						note={event.dateText}
						venue={event.venueName}
						city={event.venueCity}
						chips={event.categories.slice(0, 2)}
						extraSessions={[]}
					/>
				))}
			</ul>

			<p className={`${CAPTION} mt-6 text-muted-foreground`}>
				{agenda.announcements.length} por confirmar
			</p>
		</section>
	);
}
