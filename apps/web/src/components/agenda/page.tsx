import { MapView } from "@/components/map/map-view";
import type { Agenda } from "@/hooks/use-agenda";
import { AgendaAside } from "./agenda-aside";
import { AgendaList } from "./agenda-list";
import { FilterBar } from "./filter-bar";
import { AGENDA_ANCHOR, Fold } from "./fold";
import { SHELL } from "./layout";

/**
 * The whole product: one page. The fold (greeting, day strip, the week's
 * blocks), then the filter band, then the agenda. Filters only appear once
 * there is something to filter.
 *
 * The agenda has two readings — the list and the map — and they share the
 * filter band, so switching never loses the window you are looking at. Loading
 * and error states stay in the list: they are the same data, and one place to
 * get them right. The side column only rides with the list; the map brings
 * its own.
 */
export function AgendaPage({ agenda }: { agenda: Agenda }) {
	const ready = agenda.status === "ready";
	const showMap = ready && agenda.vista === "mapa";

	return (
		<>
			<div className={SHELL}>
				<Fold agenda={agenda} />
			</div>
			<section
				id={AGENDA_ANCHOR}
				aria-label="Agenda"
				className="mt-12 scroll-mt-2 sm:mt-16"
			>
				{ready ? <FilterBar agenda={agenda} /> : null}
				<div className={`${SHELL} pt-8 sm:pt-10`}>
					{showMap ? (
						<MapView agenda={agenda} />
					) : (
						<div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_17.5rem]">
							<AgendaList agenda={agenda} />
							{ready ? <AgendaAside agenda={agenda} /> : null}
						</div>
					)}
				</div>
			</section>
		</>
	);
}
