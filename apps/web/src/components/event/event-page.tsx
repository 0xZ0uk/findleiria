import { ArrowLeft, CalendarDays, ExternalLink, MapPin } from "lucide-react";
import { useState } from "react";
import { BUTTON, MICRO, SHELL } from "@/components/agenda/layout";
import { AgendaError } from "@/components/agenda/states";
import { track } from "@/components/analytics";
import { EventNotFound } from "@/components/event/not-found";
import { SaveButton } from "@/components/saved/save-button";
import {
	DEFAULT_TITLE,
	SHELL_DESCRIPTION,
	useDocumentMeta,
} from "@/hooks/use-document-meta";
import { useEvent } from "@/hooks/use-event";
import { clock, dayMonth, hasClock, weekday } from "@/utils/format";

/** Same blocks as the article, so the swap to real content does not move the page. */
function EventSkeleton() {
	return (
		<main className={`${SHELL} py-8`}>
			<div className="h-4 w-32 rounded-[2px] bg-card" />
			<div className="mt-6 h-9 w-4/5 rounded-[2px] bg-card" />
			<div className="mt-4 h-4 w-56 rounded-[2px] bg-card" />
			<div className="mt-8 aspect-16/9 w-full rounded-[4px] bg-card" />
			<div className="mt-6 h-4 w-full rounded-[2px] bg-card" />
			<div className="mt-2 h-4 w-2/3 rounded-[2px] bg-card" />
		</main>
	);
}

/** The day, as the sources gave it: a clock only when one was actually published. */
function When({ startAt, endAt }: { startAt: number; endAt: number | null }) {
	const sameDay = endAt !== null && dayMonth(endAt) === dayMonth(startAt);
	return (
		<span className="font-mono text-[13px] text-muted-foreground tabular-nums">
			{weekday(startAt)}, {dayMonth(startAt)}
			{hasClock(startAt) ? ` · ${clock(startAt)}` : " · hora por confirmar"}
			{sameDay && endAt !== null
				? `–${hasClock(endAt) ? clock(endAt) : "?"}`
				: ""}
		</span>
	);
}

export function EventPage({ slug }: { slug: string }) {
	const event = useEvent(slug);
	const data = event.data ?? null;
	const [broken, setBroken] = useState(false);
	// Set when we arrived by clicking through from the agenda, so the way back
	// keeps the filters the reader had applied.
	const [backHref] = useState(
		() => (window.history.state as { from?: string } | null)?.from ?? "/",
	);

	// While pending, leave the head alone: a prerendered page already carries
	// this event's title, and a generic one in between would only flicker it.
	useDocumentMeta(
		event.isPending
			? null
			: data
				? `${data.title} — FindLeiria`
				: DEFAULT_TITLE,
		data?.description ?? SHELL_DESCRIPTION,
	);

	if (event.isPending) return <EventSkeleton />;

	if (event.isError) {
		return (
			<main className={`${SHELL} py-8`}>
				<AgendaError
					what="o evento"
					message={
						event.error instanceof Error
							? event.error.message
							: String(event.error)
					}
					onRetry={() => void event.refetch()}
				/>
			</main>
		);
	}

	if (!data) return <EventNotFound />;

	const image = data.imageUrl && !broken ? data.imageUrl : null;
	const place =
		data.venueName && data.venueCity
			? `${data.venueName} · ${data.venueCity}`
			: (data.venueName ?? data.venueCity ?? null);

	return (
		<main className={`${SHELL} py-8`}>
			<a
				href={backHref}
				className="focus-ring inline-flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground uppercase tracking-[0.14em] hover:text-foreground motion-safe:transition-colors"
			>
				<ArrowLeft aria-hidden="true" strokeWidth={1.5} className="size-3.5" />
				Agenda
			</a>

			<article className="mt-6">
				<h1 className="text-balance font-semibold text-3xl leading-tight sm:text-4xl">
					{data.title}
				</h1>

				<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
					<span className="inline-flex items-center gap-1.5">
						<CalendarDays
							aria-hidden="true"
							strokeWidth={1.5}
							className="size-4 text-muted-foreground"
						/>
						<When startAt={data.startAt} endAt={data.endAt} />
					</span>
					{place ? (
						<span className="inline-flex min-w-0 items-center gap-1.5">
							<MapPin
								aria-hidden="true"
								strokeWidth={1.5}
								className="size-4 shrink-0 text-muted-foreground"
							/>
							<span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground">
								{place}
							</span>
						</span>
					) : null}
					{/* The one action this page offers: `sm:ml-auto` parks it at
					    the end of the row on a wide screen, and on a phone it
					    wraps under the date and place, where a thumb reaches it. */}
					<span className="sm:ml-auto">
						<SaveButton slug={slug} layout="detail" />
					</span>
				</div>

				{data.categories.length > 0 ? (
					<ul className="mt-4 flex flex-wrap gap-1.5">
						{data.categories.map((category) => (
							<li
								key={category}
								className={`${MICRO} rounded-[2px] border border-border px-1.5 py-0.5 text-muted-foreground`}
							>
								{category}
							</li>
						))}
					</ul>
				) : null}

				{image ? (
					<img
						src={image}
						alt=""
						decoding="async"
						onError={() => setBroken(true)}
						className="mt-8 aspect-16/9 w-full rounded-[4px] bg-card object-cover outline-1 outline-border -outline-offset-1"
					/>
				) : null}

				{data.description ? (
					<p className="mt-8 max-w-prose whitespace-pre-line text-[17px] text-foreground/90 leading-relaxed">
						{data.description}
					</p>
				) : (
					<p className="mt-8 max-w-prose text-muted-foreground">
						A fonte não publicou descrição deste evento.
					</p>
				)}

				{data.url ? (
					<a
						href={data.url}
						target="_blank"
						rel="noopener noreferrer"
						onClick={() => track("fonte", { slug: data.slug })}
						className={`${BUTTON} mt-8`}
					>
						Ver no site original
						<ExternalLink
							aria-hidden="true"
							strokeWidth={1.5}
							className="size-3.5"
						/>
						<span className="sr-only">(abre num novo separador)</span>
					</a>
				) : null}
			</article>
		</main>
	);
}
