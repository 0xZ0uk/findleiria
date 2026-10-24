/**
 * The smallest D1 REST client the publish needs: one `/query` call, plain
 * fetch, no dependency. Tests inject a fake `D1Query` instead (see
 * d1-mirror.test.ts), so nothing here is needed to exercise the mirror.
 *
 * API: POST https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{id}/query
 * with `{ "sql": "…" }`. "Supports multiple statements, joined by semicolons,
 * which will be executed as a batch": the response has one result per
 * statement.
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
	result?: Partial<D1StatementResult>[];
};

/**
 * Turn a `/query` HTTP response into results, or a D1Error that says why:
 * non-JSON bodies (a proxy error page), `success: false` with Cloudflare's
 * `errors[]` (an SQL error is HTTP 400, code 7500), and any statement whose
 * own `success` is false. The token never appears in it: only the body is
 * quoted.
 */
export function parseD1Response(
	status: number,
	body: string,
): D1StatementResult[] {
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
	return envelope.result.map((r, i) => {
		if (r.success === false) {
			throw new D1Error(`D1 statement #${i + 1} did not succeed`, status);
		}
		return {
			results: Array.isArray(r.results) ? r.results : [],
			success: true,
			meta: r.meta ?? {},
		};
	});
}

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** A `D1Query` over the D1 REST API. */
export function createD1Query(options: {
	accountId: string;
	databaseId: string;
	token: string;
	/** For tests: a fake server. Defaults to the Cloudflare API. */
	baseUrl?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}): D1Query {
	const url = `${options.baseUrl ?? CLOUDFLARE_API}/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`;
	const doFetch = options.fetch ?? fetch;
	return async (sql) => {
		let response: Response;
		try {
			response = await doFetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${options.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ sql }),
				// D1 caps a request at 30 s; past that it is not coming back.
				signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
			});
		} catch (err) {
			throw new D1Error(`could not reach D1: ${String(err)}`, 0);
		}
		return parseD1Response(response.status, await response.text());
	};
}
