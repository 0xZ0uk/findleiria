/**
 * The smallest D1 REST client the publish and the build need: plain fetch, no
 * dependency. Tests inject a fake `D1Query` instead (see d1-mirror.test.ts), or
 * point these at a fake server (see fake-d1.ts).
 *
 * API: POST https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{id}/query
 * with `{ "sql": "…" }`. "Supports multiple statements, joined by semicolons,
 * which will be executed as a batch": the response has one result per
 * statement.
 *
 * The build's read-only snapshot uses the sibling `/raw` endpoint (same body,
 * rows as arrays plus a `columns` list) through `createD1Raw`; see
 * d1-read.ts. Both endpoints type `params` as an array of STRINGS only, so the
 * read path inlines numbers into the SQL instead of binding them.
 */

/** `meta` of one statement result (the fields the publish reads). */
export type D1Meta = {
	changes?: number;
	duration?: number;
	rows_read?: number;
	rows_written?: number;
	size_after?: number;
	changed_db?: boolean;
};

export type D1StatementResult = {
	results: Record<string, unknown>[];
	success: boolean;
	meta: D1Meta;
};

/**
 * Run `sql` (one statement, or several joined by `;` that D1 runs as one
 * batch) and return one result per statement. Throws `D1Error` on any
 * failure, so a resolved promise means every statement succeeded.
 */
export type D1Query = (sql: string) => Promise<D1StatementResult[]>;

export class D1Error extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "D1Error";
	}
}

type Envelope = {
	success?: boolean;
	errors?: { code?: number; message?: string }[];
	result?: Record<string, unknown>[];
};

/**
 * Check a D1 REST HTTP response and return its raw `result[]`, or throw a
 * D1Error that says why: non-JSON bodies (a proxy error page), `success:
 * false` with Cloudflare's `errors[]` (an SQL error is HTTP 400, code 7500),
 * and a missing result. The token never appears in it: only the body is
 * quoted.
 */
function parseEnvelope(
	status: number,
	body: string,
): Record<string, unknown>[] {
	let envelope: Envelope;
	try {
		envelope = JSON.parse(body) as Envelope;
	} catch {
		throw new D1Error(
			`D1 answered HTTP ${status} with a non-JSON body: ${body.slice(0, 200)}`,
			status,
		);
	}
	if (status < 200 || status >= 300 || envelope.success !== true) {
		const errors = (envelope.errors ?? [])
			.map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown error"}`)
			.join("; ");
		throw new D1Error(
			`D1 query failed (HTTP ${status}): ${errors || body.slice(0, 200)}`,
			status,
		);
	}
	if (!Array.isArray(envelope.result)) {
		throw new D1Error(`D1 answered HTTP ${status} without a result`, status);
	}
	return envelope.result;
}

/** Turn a `/query` HTTP response into one result per statement, or a D1Error. */
export function parseD1Response(
	status: number,
	body: string,
): D1StatementResult[] {
	return parseEnvelope(status, body).map((r, i) => {
		if (r.success === false) {
			throw new D1Error(`D1 statement #${i + 1} did not succeed`, status);
		}
		return {
			results: Array.isArray(r.results)
				? (r.results as Record<string, unknown>[])
				: [],
			success: true,
			meta: (r.meta as D1Meta | undefined) ?? {},
		};
	});
}

/** One statement of a `/raw` response: rows as arrays, in `columns` order. */
export type D1RawResult = {
	columns: string[];
	rows: unknown[][];
	meta: D1Meta;
};

/** Turn a `/raw` HTTP response into one `D1RawResult` per statement, or a D1Error. */
export function parseD1RawResponse(
	status: number,
	body: string,
): D1RawResult[] {
	return parseEnvelope(status, body).map((r, i) => {
		if (r.success === false) {
			throw new D1Error(`D1 statement #${i + 1} did not succeed`, status);
		}
		const results = (r.results ?? {}) as { columns?: unknown; rows?: unknown };
		if (r.results !== undefined && !Array.isArray(results.rows)) {
			throw new D1Error(
				`D1 statement #${i + 1} answered without rows (is this the /raw endpoint?)`,
				status,
			);
		}
		return {
			columns: Array.isArray(results.columns)
				? results.columns.map(String)
				: [],
			rows: Array.isArray(results.rows) ? (results.rows as unknown[][]) : [],
			meta: (r.meta as D1Meta | undefined) ?? {},
		};
	});
}

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

type D1ClientOptions = {
	accountId: string;
	databaseId: string;
	token: string;
	/** For tests: a fake server. Defaults to the Cloudflare API. */
	baseUrl?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

/** POST `{ sql, params? }` to a database endpoint; hand back status + body. */
function createPoster(
	options: D1ClientOptions,
	endpoint: "query" | "raw",
): (
	sql: string,
	params?: string[],
) => Promise<{ status: number; body: string }> {
	const url = `${options.baseUrl ?? CLOUDFLARE_API}/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/${endpoint}`;
	const doFetch = options.fetch ?? fetch;
	return async (sql, params) => {
		let response: Response;
		try {
			response = await doFetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${options.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(
					params && params.length > 0 ? { sql, params } : { sql },
				),
				// D1 caps a request at 30 s; past that it is not coming back.
				signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
			});
		} catch (err) {
			throw new D1Error(`could not reach D1: ${String(err)}`, 0);
		}
		return { status: response.status, body: await response.text() };
	};
}

/** A `D1Query` over the D1 REST API. */
export function createD1Query(options: D1ClientOptions): D1Query {
	const post = createPoster(options, "query");
	return async (sql) => {
		const { status, body } = await post(sql);
		return parseD1Response(status, body);
	};
}

/**
 * Run `sql` over `/raw` with string-only bound params (the API's contract).
 * Throws `D1Error` on any failure.
 */
export type D1RawQuery = (
	sql: string,
	params?: string[],
) => Promise<D1RawResult[]>;

/** A `D1RawQuery` over the D1 REST API. */
export function createD1Raw(options: D1ClientOptions): D1RawQuery {
	const post = createPoster(options, "raw");
	return async (sql, params) => {
		const { status, body } = await post(sql, params);
		return parseD1RawResponse(status, body);
	};
}
