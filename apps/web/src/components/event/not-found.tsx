import { BUTTON, MICRO, SHELL } from "@/components/agenda/layout";
import { SHELL_DESCRIPTION, useDocumentMeta } from "@/hooks/use-document-meta";

/**
 * Shown for a slug we do not have.
 *
 * The Worker's static assets answer an unknown `/evento/...` with the SPA shell
 * (`not_found_handling: "single-page-application"`), so the status is a 200; the `noindex` tag is what stops a dead slug from being indexed as a
 * thin page.
 */
export function EventNotFound() {
	useDocumentMeta(
		"Evento não encontrado — FindLeiria",
		SHELL_DESCRIPTION,
		true,
	);

	return (
		<main className={`${SHELL} py-20 sm:py-28`}>
			<p className={MICRO}>Erro 404</p>
			<h1 className="mt-3 text-balance font-semibold text-3xl sm:text-4xl">
				Não temos este evento
			</h1>
			<p className="mt-3 max-w-prose text-muted-foreground">
				O endereço pode estar incompleto, ou o evento saiu da agenda. A lista
				completa está sempre na página principal.
			</p>
			<a href="/" className={`${BUTTON} mt-8`}>
				Voltar à agenda
			</a>
		</main>
	);
}
