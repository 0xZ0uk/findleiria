import { normalizeTitle } from "./normalize";

/**
 * Canonical event taxonomy (SLICE_6).
 *
 * Sources send their own labels (and some used to inject platform names as
 * categories). Everything flows through `canonicalizeCategories` at ingest so
 * the filter dropdown stays small: singular/plural and variant labels collapse
 * into one canonical form; platform names are dropped; unknown labels pass
 * through untouched (never lose data) and are reported by `unknownCategory`.
 *
 * "Untouched" is why a label can still reach the dropdown: nothing failed when
 * a source label was missing from both tables, the dropdown just grew. The
 * drift guard in categories.test.ts pins the labels the live DB actually
 * carried, so a synonym that only exists in production data fails a test
 * instead of shipping a 34th filter option.
 */

/** The canonical labels, in display order (filters + badges follow this). */
export const CANONICAL_CATEGORIES = [
	"Cultura",
	"Música",
	"Concertos",
	"Festivais",
	"Festas",
	"Clubbing",
	"Teatro",
	"Dança",
	"Cinema",
	"Literatura",
	"Encontros",
	"Conferências",
	"Workshop",
	"Museus & Exposições",
	"Mercados e Feiras",
	"Tradição",
	"Infantil",
	"Comedy",
	"Desporto",
	"Gastronomia",
	"Natureza",
	"Atividades ao Ar Livre",
	"Outros",
] as const;

/**
 * Raw label (any case/diacritics/plural variant) → canonical label(s).
 * Keys are normalized with `normalizeTitle` at module init, so write them in
 * natural form. Array values expand a compound source label into two themes.
 */
const ALIASES_RAW: Record<string, string | string[]> = {
	// Música
	Concerto: "Concertos",
	// Teatro / Dança
	"Teatro e Dança": ["Teatro", "Dança"],
	Performance: "Teatro",
	Danças: "Dança",
	// Cinema
	"Cinema e Vídeo": "Cinema",
	Exibição: "Cinema",
	// Museus & Exposições
	Museus: "Museus & Exposições",
	Exposições: "Museus & Exposições",
	Exposição: "Museus & Exposições",
	// Literatura
	Biblioteca: "Literatura",
	"Lançamento de livro": "Literatura",
	// Encontros
	Conversa: "Encontros",
	// Conferências
	Conferência: "Conferências",
	Palestra: "Conferências",
	Fórum: "Conferências",
	"Apresentações, conferências e encontros": ["Conferências", "Encontros"],
	// Workshop
	Oficina: "Workshop",
	"Oficina pedagógica": "Workshop",
	Formação: "Workshop",
	// Mercados e Feiras
	Feira: "Mercados e Feiras",
	// Cultura (generic source buckets)
	Eventos: "Cultura",
	"Jornadas Europeias do Património": "Cultura",
	// Infantil
	"Animação Infantil": "Infantil",
	// Comedy
	"Stand Up Comedy": "Comedy",
	"Stand-up Comedy": "Comedy",
	// Desporto
	"Bem Estar": "Desporto",
	// Outros (honest bucket for rare one-off labels)
	"Passeios e Visitas": "Outros",
	"Visita guiada": "Outros",
	"Percurso / Roteiro": "Outros",
	Lazer: "Outros",
	"Outros eventos": "Outros",
	Evento: "Outros",
	Outras: "Outros",
	Jogos: "Outros",
	Fotografia: "Outros",
	// Drift found in the live database (SLICE_10). Every key below is a label
	// the production DB actually carried into the filter dropdown, because the
	// canonical set and the alias table were both missing it.
	// Plural forms are the recurring miss: `Feira` was aliased but `Feiras` was
	// not, `Oficina` but not `Oficinas` — each became its own filter option.
	Festival: "Festivais",
	Feiras: "Mercados e Feiras",
	Oficinas: "Workshop",
	"Oficina / workshop": "Workshop",
	"Mais Novos": "Infantil",
	Corrida: "Desporto",
	Caminhada: "Desporto",
	Ambiente: "Natureza",
	"Evento ao ar livre": "Atividades ao Ar Livre",
	"Eventos ao ar livre": "Atividades ao Ar Livre",
	// Our own mappers' fallback buckets and source feed titles: the source gave
	// no usable category, so the honest bucket is Outros.
	Agenda: "Outros",
	"CM Leiria": "Outros",
	Espetáculo: "Outros",
	Saúde: "Outros",
	Educação: "Outros",
};

/** Platform/scraper names that must never surface as event categories. */
const DROPPED_RAW = ["Shotgun", "Eventbrite", "Ticketline", "Viral Agenda"];

const canonicalByNorm = new Map<string, string>(
	CANONICAL_CATEGORIES.map((c) => [normalizeTitle(c), c]),
);

const aliases = new Map<string, string | string[]>(
	Object.entries(ALIASES_RAW).map(([k, v]) => [normalizeTitle(k), v]),
);

const dropped = new Set(DROPPED_RAW.map((d) => normalizeTitle(d)));

/** Rank used for stable output order: canonical order first, unknowns after. */
function rank(label: string): number {
	const idx = CANONICAL_CATEGORIES.indexOf(
		label as (typeof CANONICAL_CATEGORIES)[number],
	);
	return idx >= 0 ? idx : CANONICAL_CATEGORIES.length;
}

/**
 * Map raw source categories onto the canonical taxonomy.
 * Pure: no DB, no I/O. Deterministic order (taxonomy order, then alphabetical
 * within unknowns) so change detection in ingest never flip-flops.
 */
export function canonicalizeCategories(raw: string[]): string[] {
	const out = new Set<string>();
	for (const label of raw) {
		const norm = normalizeTitle(label);
		if (!norm) continue;
		if (dropped.has(norm)) continue;
		const mapped = aliases.get(norm) ?? canonicalByNorm.get(norm);
		if (mapped != null) {
			for (const c of Array.isArray(mapped) ? mapped : [mapped]) {
				out.add(c);
			}
		} else {
			// Unknown label: pass through untouched.
			out.add(label);
		}
	}
	return sortCategories(out);
}

/**
 * The single display ordering for category lists: taxonomy order, then
 * alphabetical within unknowns. Dedupes. Used by insert, update-merge and
 * reconcile so the stored order never depends on the write path.
 */
export function sortCategories(labels: Iterable<string>): string[] {
	return [...new Set(labels)].sort(
		(a, b) => rank(a) - rank(b) || a.localeCompare(b, "pt"),
	);
}

/** Order-insensitive equality of two category lists (as sets). */
export function sameCategories(
	a: readonly string[],
	b: readonly string[],
): boolean {
	const sa = new Set(a);
	const sb = new Set(b);
	if (sa.size !== sb.size) return false;
	for (const x of sa) if (!sb.has(x)) return false;
	return true;
}

/**
 * Report helper for backfill/ingest logs: returns the label only when it is
 * UNMAPPED — i.e. it passes through untouched because no alias or canonical
 * form covers it. Canonical, alias-resolved, and dropped labels return null
 * (they resolve deterministically; nothing to surface).
 */
export function unknownCategory(label: string): string | null {
	const norm = normalizeTitle(label);
	if (!norm || dropped.has(norm)) return null;
	if (aliases.has(norm) || canonicalByNorm.has(norm)) return null;
	return label;
}
