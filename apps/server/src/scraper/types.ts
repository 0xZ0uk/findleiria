/**
 * Raw event as scraped from an upstream source, before normalization,
 * fingerprinting and ingestion. Field values are the closest literal
 * representation of what the source HTML provides.
 */
export interface RawEvent {
	title: string;
	slug: string;
	description: string | null;
	/**
	 * Start epoch seconds (UTC), or null when the source gives no
	 * machine-readable date. Null ⇒ `dateText` should carry the raw date
	 * string and ingest pins start_at to the ingestion epoch as placeholder.
	 */
	startAt: number | null;
	/** End epoch seconds (UTC), null when the source gives no end. */
	endAt: number | null;
	/** Raw date string from the source (e.g. "1 fevereiro às 14h30") when no machine-readable date was parsed. */
	dateText: string | null;
	venueName: string;
	city: string | null;
	categories: string[];
	imageUrl: string | null;
	url: string;
	/**
	 * Free entry: true = the source says free, false = it gives a price,
	 * null/absent = it says nothing. Never guessed.
	 */
	isFree?: boolean | null;
}
