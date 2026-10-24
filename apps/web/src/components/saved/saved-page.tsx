import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { EventRow } from "@/components/agenda/event-row";
import { PageFooter } from "@/components/agenda/footer";
import { MICRO, SHELL } from "@/components/agenda/layout";
import { AgendaError } from "@/components/agenda/states";
import { SaveButton } from "@/components/saved/save-button";
import { useSavedStore } from "@/components/saved/saved-context";
import { SHELL_DESCRIPTION, useDocumentMeta } from "@/hooks/use-document-meta";
import type { SavedListEvent } from "@/utils/api";
import { api } from "@/utils/api";
import { clock, hasClock, plural } from "@/utils/format";
import { eventHref, savedHref, signInHref } from "@/utils/route";

/** Three placeholder lines, so the list does not jump when the read lands. */
function SavedSkeleton() {
	return (
		<ul className="mt-8" aria-hidden="true">
			{["a", "b", "c"].map((key) => (
				<li key={key} className="border-border border-b py-6 last:border-b-0">
					<div className="h-4 w-2/3 rounded-[2px] bg-card" />
					<div className="mt-3 h-3 w-1/3 rounded-[2px] bg-card" />
				</li>
			))}
		</ul>
	);
}

/** A section heading in the same voice as the agenda's day headings. */
function SectionHeading({ label, count }: { label: string; count: number }) {
	return (
		<h2 className="mt-10 flex items-baseline justify-between gap-4 border-border border-b py-3 first:mt-0">
			<span className="p443-card-title">{label}</span>
			<span className="shrink-0 font-mono text-[12px] text-muted-foreground tabular-nums">
				{count} {plural(count, "evento", "eventos")}
			</span>
		</h2>
	);
}

/** The day of a saved event, in the agenda's own vocabulary. */
function whenOf(event: SavedListEvent) {
	if (hasClock(event.startAt)) return clock(event.startAt);
	return (
		<>
			<span aria-hidden="true">—</span>
			<span className="sr-only">hora por confirmar</span>
		</>
	);
}

/**
 * One saved event, in the agenda's row shape — deliberately the same row as the
 * agenda, so saving reads as "kept this line" rather than as a second list with
 * its own conventions. The save control rides in the row, which is what makes
 * unsaving possible straight from the list.
 */
function SavedRow({ event }: { event: SavedListEvent }) {
	return (
		<EventRow
			title={event.title}
			detailHref={eventHref(event.slug)}
			href={event.url}
			imageUrl={event.imageUrl}
			seed={event.slug}
			time={whenOf(event)}
			dateTime={new Date(event.startAt * 1000).toISOString()}
			venue={event.venueName}
			city={event.venueCity}
			chips={event.categories.slice(0, 2)}
			extraSessions={[]}
			saveSlot={<SaveButton slug={event.slug} layout="row" />}
		/>
	);
}

/**
 * A slug the reader saved that no longer resolves to an event.
 *
 * The mirror keeps past events, so this is the rare case: a row whose source
 * disappeared between collections. Rather than hide it — which would look like
 * the save silently failed — the row stays and says so, with the one action
 * that makes sense.
 */
function MissingRow({
	slug,
	onRemove,
	pending,
}: {
	slug: string;
	onRemove: () => void;
	pending: boolean;
}) {
	return (
		<li className="flex min-h-[60px] items-center justify-between gap-4 border-border border-b py-3 last:border-b-0">
			<div className="min-w-0">
				<p className="text-[15px] text-muted-foreground">
					Evento já não disponível
				</p>
				<p className={`${MICRO} mt-1 truncate text-muted-foreground/85`}>
					{slug}
				</p>
			</div>
			<button
				type="button"
				onClick={onRemove}
				disabled={pending}
				className="focus-ring inline-flex h-11 shrink-0 items-center rounded-[4px] border border-control px-3 text-[13px] hover:border-primary/60 hover:text-primary disabled:opacity-50 motion-safe:transition-colors"
			>
				Remover
			</button>
		</li>
	);
}

/** Signed out: say what the page is for and offer the way in, back to here. */
function SignedOut() {
	return (
		<div className="mt-8 rounded-[4px] border border-border bg-card p-6">
			<p className="text-[15px] leading-relaxed">
				Guarde os eventos que quer acompanhar e eles ficam nesta página, no
				telemóvel e no computador.
			</p>
			<a
				href={signInHref(savedHref())}
				className="focus-ring mt-5 inline-flex h-11 items-center rounded-[4px] bg-primary px-4 font-medium text-[14px] text-primary-foreground hover:bg-primary/90 motion-safe:transition-colors"
			>
				Entrar para guardar
			</a>
		</div>
	);
}

/** Signed in, nothing saved yet. */
function NothingSaved() {
	return (
		<div className="mt-8 rounded-[4px] border border-border bg-card p-6">
			<p className="text-[15px] leading-relaxed">
				Ainda não guardou nada. Na agenda, toque em{" "}
				<span className="font-medium">Guardar</span> no evento que lhe interessa
				— fica aqui à espera.
			</p>
			<a
				href="/"
				className="focus-ring mt-5 inline-flex h-11 items-center rounded-[4px] border border-control px-4 text-[14px] hover:border-primary/60 hover:text-primary motion-safe:transition-colors"
			>
				Ver a agenda
			</a>
		</div>
	);
}

/**
 * The reader's saved events.
 *
 * Two reads, and only one of them is ours: the slug list comes from
 * `/api/saved` (same-origin, cookie-authenticated, the only place the auth DB
 * token exists), and the events themselves come from the static snapshot's
 * per-event files. Nothing about events is duplicated into the auth DB.
 *
 * Split into what is still coming and what has already happened, against this
 * reader's clock, because a saved event does not stop being interesting the
 * day after, and the snapshot keeps a file for every past event. Slugs that
 * no longer resolve get their own honest section instead of vanishing.
 */
export function SavedPage() {
	const saved = useSavedStore();
	useDocumentMeta("Guardados — FindLeiria", SHELL_DESCRIPTION);
	const now = Math.floor(Date.now() / 1000);

	// Stable array so the query key does not change on every render.
	const slugList = useMemo(() => [...saved.slugs], [saved.slugs]);
	const events = useQuery(api.saved.queryOptions(slugList));

	// `keepPreviousData` leaves the last fetch on screen while the next slug
	// list loads, so an event just unsaved is dropped here rather than waiting.
	const rows = (events.data ?? []).filter((row) => saved.slugs.has(row.slug));
	const upcoming = rows
		.filter((row) => (row.endAt ?? row.startAt) >= now)
		.sort((a, b) => a.startAt - b.startAt);
	const past = rows
		.filter((row) => (row.endAt ?? row.startAt) < now)
		.sort((a, b) => b.startAt - a.startAt);
	const known = new Set(rows.map((row) => row.slug));
	const missing = slugList.filter((slug) => !known.has(slug));

	const count = saved.slugs.size;

	return (
		<div className="min-h-svh">
			<main className={SHELL}>
				<header className="mt-14 sm:mt-20">
					<h1 className="p443-display max-w-[24ch] text-balance">Guardados.</h1>
					<p className="p443-dek mt-6 max-w-[46ch] text-pretty text-muted-foreground">
						{saved.signedIn && count > 0
							? `${count} ${plural(count, "evento guardado", "eventos guardados")}.`
							: "Os eventos que guardar ficam aqui, prontos para voltar a ver."}
					</p>
				</header>

				{!saved.ready ? (
					<SavedSkeleton />
				) : !saved.signedIn ? (
					<SignedOut />
				) : count === 0 ? (
					<NothingSaved />
				) : events.isPending ? (
					<SavedSkeleton />
				) : events.isError ? (
					<AgendaError
						what="os eventos guardados"
						message={
							events.error instanceof Error
								? events.error.message
								: String(events.error)
						}
						onRetry={() => void events.refetch()}
					/>
				) : (
					<div>
						{upcoming.length > 0 ? (
							<section aria-labelledby="guardados-a-seguir" className="pt-8">
								<div id="guardados-a-seguir">
									<SectionHeading label="A seguir" count={upcoming.length} />
								</div>
								<ul className="mt-2">
									{upcoming.map((event) => (
										<SavedRow key={event.slug} event={event} />
									))}
								</ul>
							</section>
						) : null}

						{past.length > 0 ? (
							<section aria-labelledby="guardados-passados" className="pt-8">
								<div id="guardados-passados">
									<SectionHeading label="Já passaram" count={past.length} />
								</div>
								<ul className="mt-2">
									{past.map((event) => (
										<SavedRow key={event.slug} event={event} />
									))}
								</ul>
							</section>
						) : null}

						{missing.length > 0 ? (
							<section aria-labelledby="guardados-perdidos" className="pt-8">
								<div id="guardados-perdidos">
									<SectionHeading
										label="Já não disponíveis"
										count={missing.length}
									/>
								</div>
								<ul className="mt-2">
									{missing.map((slug) => (
										<MissingRow
											key={slug}
											slug={slug}
											pending={saved.pending}
											onRemove={() => saved.toggle(slug)}
										/>
									))}
								</ul>
							</section>
						) : null}
					</div>
				)}
			</main>
			<div className={SHELL}>
				<PageFooter />
			</div>
		</div>
	);
}
