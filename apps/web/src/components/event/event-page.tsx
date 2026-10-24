import { ArrowLeft, CalendarDays, ExternalLink, MapPin } from "lucide-react";
import { useState } from "react";
import {
	CAPTION,
	PRIMARY_BUTTON,
	SHELL,
	TAG,
} from "@/components/agenda/layout";
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
import { meshGradient } from "@/utils/mesh-gradient";
import {
	eventTheme,
	NEUTRAL_TAG,
	THEME_INK,
	THEME_TAG,
	themeOf,
} from "@/utils/themes";

/** Same blocks as the article, so the swap to real content does not move the page. */
function EventSkeleton() {
	return (
		<main className={`${SHELL} py-8 sm:py-12`}>
			<div className="h-4 w-24 rounded-full bg-card" />
			<div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem]">
				<div>
					<div className="h-4 w-32 rounded-full bg-card" />
					<div className="mt-4 h-10 w-4/5 rounded-full bg-card" />
					<div className="mt-3 h-10 w-3/5 rounded-full bg-card" />
					<div className="mt-8 h-4 w-full rounded-full bg-card" />
					<div className="mt-2 h-4 w-2/3 rounded-full bg-card" />
				</div>
				<div className="aspect-4/3 w-full rounded-2xl bg-card" />
			</div>
		</main>
	);
}

/** The day, as the sources gave it: a clock only when one was actually published. */
function When({ startAt, endAt }: { startAt: number; endAt: number | null }) {
	const sameDay = endAt !== null && dayMonth(endAt) === dayMonth(startAt);
	return (
		<span>
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

	const theme = eventTheme(data.categories);

	return (
		<main className={`${SHELL} py-8 sm:py-12`}>
			<a
				href={backHref}
				className="focus-ring -my-3 inline-flex min-h-11 items-center gap-1.5 rounded-full font-medium text-[14px] text-muted-foreground hover:text-foreground motion-safe:transition-colors"
			>
				<ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
				Agenda
			</a>

			<article className="mt-6 grid gap-10 sm:mt-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-14">
				<div className="min-w-0">
					{data.categories[0] ? (
						<p
							className={`${CAPTION} ${theme ? THEME_INK[theme] : "text-primary"}`}
						>
							{data.categories[0]}
						</p>
					) : null}
					<h1 className="type-headline mt-2 text-balance">{data.title}</h1>

					{data.categories.length > 1 || data.isFree === true ? (
						<ul className="mt-5 flex flex-wrap gap-1.5">
							{data.isFree === true ? (
								<li className={`${TAG} bg-primary-surface text-primary`}>
									Entrada livre
								</li>
							) : null}
							{data.categories.map((category) => {
								const group = themeOf(category);
								return (
									<li
										key={category}
										className={`${TAG} ${group ? THEME_TAG[group] : NEUTRAL_TAG}`}
									>
										{category}
									</li>
								);
							})}
						</ul>
					) : null}

					{data.description ? (
						<p className="type-dek mt-8 max-w-[65ch] whitespace-pre-line text-pretty text-foreground/90">
							{data.description}
						</p>
					) : (
						<p className="mt-8 max-w-[65ch] text-muted-foreground">
							A fonte não publicou descrição deste evento.
						</p>
					)}
				</div>

				<aside
					aria-label="Detalhes"
					className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start"
				>
					<div
						style={meshGradient(data.slug, theme)}
						className="aspect-4/3 w-full overflow-hidden rounded-2xl"
					>
						{image ? (
							<img
								src={image}
								alt=""
								decoding="async"
								onError={() => setBroken(true)}
								className="size-full object-cover"
							/>
						) : null}
					</div>

					<div className="rounded-2xl border border-border bg-card p-5">
						<dl className="grid gap-4 text-[15px]">
							<div className="flex gap-3">
								<dt>
									<CalendarDays
										aria-hidden="true"
										strokeWidth={1.75}
										className="mt-0.5 size-5 text-primary"
									/>
									<span className="sr-only">Quando</span>
								</dt>
								<dd>
									<When startAt={data.startAt} endAt={data.endAt} />
								</dd>
							</div>
							{place ? (
								<div className="flex gap-3">
									<dt>
										<MapPin
											aria-hidden="true"
											strokeWidth={1.75}
											className="mt-0.5 size-5 text-primary"
										/>
										<span className="sr-only">Onde</span>
									</dt>
									<dd className="min-w-0 break-words">{place}</dd>
								</div>
							) : null}
						</dl>

						<div className="mt-5 flex flex-wrap gap-2">
							{data.url ? (
								<a
									href={data.url}
									target="_blank"
									rel="noopener noreferrer"
									onClick={() => track("fonte", { slug: data.slug })}
									className={`${PRIMARY_BUTTON} flex-1`}
								>
									Ver no site original
									<ExternalLink
										aria-hidden="true"
										strokeWidth={1.75}
										className="size-4"
									/>
									<span className="sr-only">(abre num novo separador)</span>
								</a>
							) : null}
							<SaveButton slug={slug} layout="detail" />
						</div>
					</div>
				</aside>
			</article>
		</main>
	);
}
