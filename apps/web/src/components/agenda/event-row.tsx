import { ExternalLink } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { meshGradient } from "@/utils/mesh-gradient";
import { MICRO } from "./layout";

export type RowProps = {
	title: string;
	href: string | null;
	/**
	 * This event's own page. When present the row's main target becomes the
	 * internal page and the source keeps the small link on the right; without
	 * it (announcements) the row falls back to the source URL.
	 */
	detailHref: string | null;
	imageUrl: string | null;
	/** Identity for the poster-less tile. Falls back to the title. */
	seed?: string;
	/** `19:30`, a dash, or the source's own date text — decided by the caller. */
	time: ReactNode;
	/** ISO instant, so the clock is a real `<time>`; omitted for announcements. */
	dateTime?: string;
	/** Extra context that belongs with the venue, e.g. a source's raw date text. */
	note?: string | null;
	venue: string | null;
	city: string | null;
	chips: string[];
	/** Other session clocks on the same day, already formatted. */
	extraSessions: string[];
	/**
	 * The save control, owned by the caller: the agenda and the saved list
	 * both ride the same row, and only they know the slug the control needs.
	 * It sits above the stretched link (z-20) or it would never receive a tap.
	 */
	saveSlot?: ReactNode;
};

/**
 * One agenda line.
 *
 * Mobile leads with the clock and no thumbnail: at 320px a 44px picture plus a
 * 44px clock leaves too little for a title the sources write at up to 97
 * characters. From `sm` up the row opens into thumb + clock + text, where the
 * posters earn their space.
 *
 * That slot is never empty: every row carries a seeded mesh gradient, so a
 * source that published no poster — or a poster that has since stopped serving
 * — shows its own tile instead of a hole in the list.
 *
 * The row is no longer wrapped in a single anchor — an event has two
 * destinations (its page, and the source) and anchors cannot nest. Instead the
 * primary target is a stretched link behind the content, and the source link
 * sits above it on the right (mobile: in the meta line, where the fourth grid
 * column does not exist).
 */
export function EventRow({
	title,
	href,
	detailHref,
	imageUrl,
	seed,
	time,
	dateTime,
	note,
	venue,
	city,
	chips,
	extraSessions,
	saveSlot,
}: RowProps) {
	const [broken, setBroken] = useState(false);
	const tile = meshGradient(seed ?? title);

	const timeClass =
		"col-start-1 row-start-1 pt-0.5 font-mono text-[13px] leading-tight tabular-nums text-muted-foreground sm:col-start-2 sm:text-[14px]";
	const place = venue && city ? `${venue} · ${city}` : (venue ?? city ?? null);
	const meta = [note, place].filter((part): part is string => Boolean(part));

	const destination = detailHref ?? href;
	const external = !detailHref && Boolean(href);
	const sourceLink = (className: string) => (
		<a
			href={href ?? undefined}
			target="_blank"
			rel="noopener noreferrer"
			className={className}
		>
			<ExternalLink aria-hidden="true" strokeWidth={1.5} className="size-3.5" />
			<span className="sr-only">Abrir no site original (novo separador)</span>
		</a>
	);

	const body = (
		<>
			<span
				style={tile}
				className="col-start-1 row-start-1 hidden size-16 overflow-hidden rounded-[4px] bg-card outline-1 outline-border -outline-offset-1 sm:block"
			>
				{imageUrl && !broken ? (
					<img
						src={imageUrl}
						alt=""
						loading="lazy"
						decoding="async"
						onError={() => setBroken(true)}
						className="size-full object-cover"
					/>
				) : null}
			</span>

			{dateTime ? (
				<time dateTime={dateTime} className={timeClass}>
					{time}
				</time>
			) : (
				<span className={timeClass}>{time}</span>
			)}

			<div className="col-start-2 row-start-1 min-w-0 sm:col-start-3">
				<h3 className="line-clamp-3 font-semibold text-[17px] leading-snug sm:line-clamp-2">
					{title}
				</h3>
				<p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
					{meta.map((part, index) => (
						<Fragment key={part}>
							{index > 0 ? <span aria-hidden="true">·</span> : null}
							<span className="min-w-0 max-w-full truncate">{part}</span>
						</Fragment>
					))}
					{chips.map((chip) => (
						<span
							key={chip}
							className={`${MICRO} shrink-0 rounded-[2px] border border-border px-1.5 py-0.5`}
						>
							{chip}
						</span>
					))}
					{extraSessions.length > 0 ? (
						<span className="shrink-0 font-mono text-[12px] tabular-nums">
							também às {extraSessions.join(", ")}
						</span>
					) : null}
					{href
						? sourceLink(
								"relative z-20 inline-flex shrink-0 items-center sm:hidden",
							)
						: null}
				</p>
			</div>

			{href
				? sourceLink(
						"relative z-20 col-start-4 row-start-1 mt-1 hidden items-center justify-center text-control group-hover:text-foreground motion-safe:transition-colors sm:flex",
					)
				: null}

			{saveSlot ? (
				<div className="relative z-20 col-start-3 row-start-1 flex justify-end sm:col-start-5">
					{saveSlot}
				</div>
			) : null}
		</>
	);

	const shape =
		"group relative -mx-2 grid scroll-mt-16 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-[4px] px-2 py-3 sm:grid-cols-[4rem_3.5rem_minmax(0,1fr)_1rem_auto] sm:gap-x-4";
	// Joined, not concatenated: a missing space silently merged two classes and
	// dropped `relative`, which sent every stretched link to the viewport corner.
	const rowClass = [
		shape,
		destination ? "hover:bg-card" : "",
		"motion-safe:transition-colors",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<li>
			<div className={rowClass}>
				{destination ? (
					<a
						href={destination}
						aria-label={
							external
								? `${title} (abre num novo separador)`
								: `${title} — ver a página do evento`
						}
						{...(external
							? { target: "_blank", rel: "noopener noreferrer" }
							: {})}
						className="focus-ring absolute inset-0 z-10 rounded-[4px]"
					/>
				) : null}
				{body}
			</div>
		</li>
	);
}
