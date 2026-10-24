import { useMemo } from "react";
import { useSavedStore } from "@/components/saved/saved-context";
import type { Agenda } from "@/hooks/use-agenda";
import { clock, dayMonth, hasClock, weekday } from "@/utils/format";
import { meshGradient } from "@/utils/mesh-gradient";
import { eventHref, savedHref } from "@/utils/route";
import { eventTheme, THEME_DOT, themeOf } from "@/utils/themes";

const HEADING =
	"flex items-baseline justify-between gap-3 border-foreground border-b pb-2.5 font-medium font-serif text-[1.125rem] leading-[1.3]";
const LINK =
	"focus-ring rounded-sm font-medium font-sans text-[13px] text-primary hover:underline hover:decoration-from-font hover:underline-offset-3";

/**
 * The reader's next saved events, read from the agenda already loaded, so the
 * column costs no request. Signed out, it explains what the bookmark is for.
 */
function SavedSoon({ agenda }: { agenda: Agenda }) {
	const saved = useSavedStore();
	const soon = useMemo(
		() => agenda.rows.filter((row) => saved.isSaved(row.slug)).slice(0, 4),
		[agenda.rows, saved],
	);

	return (
		<section aria-labelledby="aside-saved">
			<h2 id="aside-saved" className={HEADING}>
				Guardados
				{soon.length > 0 ? (
					<a href={savedHref()} className={LINK}>
						Ver todos
					</a>
				) : null}
			</h2>
			{soon.length > 0 ? (
				<ul>
					{soon.map((row) => (
						<li key={row.id} className="border-border border-b">
							<a
								href={eventHref(row.slug)}
								className="focus-ring group grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-3 rounded-lg py-3"
							>
								<span
									aria-hidden="true"
									style={meshGradient(row.slug, eventTheme(row.categories))}
									className="size-11 overflow-hidden rounded-lg"
								>
									{row.imageUrl ? (
										<img
											src={row.imageUrl}
											alt=""
											loading="lazy"
											decoding="async"
											className="size-full object-cover"
										/>
									) : null}
								</span>
								<span className="min-w-0">
									<span className="line-clamp-2 font-medium font-serif text-[15px] leading-snug group-hover:underline group-hover:decoration-from-font group-hover:underline-offset-3">
										{row.title}
									</span>
									<span className="block text-[13px] text-muted-foreground tabular-nums">
										{weekday(row.startAt)}, {dayMonth(row.startAt)}
										{hasClock(row.startAt) ? ` · ${clock(row.startAt)}` : ""}
									</span>
								</span>
							</a>
						</li>
					))}
				</ul>
			) : (
				<p className="pt-3 text-[14px] text-muted-foreground leading-relaxed">
					{saved.signedIn
						? "Os eventos que guardares aparecem aqui, por ordem de data."
						: "Entra na tua conta para guardar eventos e vê-los aqui."}
				</p>
			)}
		</section>
	);
}

/**
 * The types on the agenda right now, as shortcuts into the type filter. Each
 * carries its theme dot and its name, so the colour is never the only cue.
 */
function Types({ agenda }: { agenda: Agenda }) {
	const top = agenda.facets.categories.slice(0, 8);
	const active = agenda.filters.category;

	return (
		<section aria-labelledby="aside-types">
			<h2 id="aside-types" className={HEADING}>
				Por tipo
			</h2>
			<ul>
				{top.map((facet) => {
					const theme = themeOf(facet.value);
					const pressed = active === facet.value;
					return (
						<li key={facet.value} className="border-border border-b">
							<button
								type="button"
								aria-pressed={pressed}
								onClick={() =>
									agenda.setFilter("category", pressed ? "" : facet.value)
								}
								className={`focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg text-left text-[15px] hover:text-primary motion-safe:transition-colors ${pressed ? "font-medium text-primary" : ""}`}
							>
								<span
									aria-hidden="true"
									className={`size-2.5 shrink-0 rounded-full ${theme ? THEME_DOT[theme] : "bg-control"}`}
								/>
								{facet.label}
								<span className="ml-auto text-[14px] text-muted-foreground tabular-nums">
									{facet.count}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** The list's side column, from `lg` up: saved events, then types. */
export function AgendaAside({ agenda }: { agenda: Agenda }) {
	return (
		<aside
			aria-label="Atalhos"
			className="hidden flex-col gap-10 lg:sticky lg:top-6 lg:flex lg:self-start"
		>
			<SavedSoon agenda={agenda} />
			<Types agenda={agenda} />
		</aside>
	);
}
