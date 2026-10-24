import { MapView } from "@/components/map/map-view";
import type { Agenda } from "@/hooks/use-agenda";
import { AgendaList } from "./agenda-list";
import { FilterBar } from "./filter-bar";
import { Masthead } from "./masthead";

/**
 * The whole product: one page, no navigation. Masthead, filters, agenda.
 * Filters only appear once there is something to filter.
 *
 * The agenda has two readings — the list and the map — and they share the
 * filter bar, so switching never loses the window you are looking at. Loading
 * and error states stay in the list: they are the same data, and one place to
 * get them right.
 */
export function AgendaPage({ agenda }: { agenda: Agenda }) {
	const showMap = agenda.status === "ready" && agenda.vista === "mapa";

	return (
		<>
			<Masthead agenda={agenda} />
			<section className="mt-14 sm:mt-20" aria-label="Agenda">
				{agenda.status === "ready" ? <FilterBar agenda={agenda} /> : null}
				{showMap ? <MapView agenda={agenda} /> : <AgendaList agenda={agenda} />}
			</section>
		</>
	);
}
