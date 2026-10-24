import { useEffect } from "react";

/** The site's own title and description, as `index.html` ships them. */
export const DEFAULT_TITLE = "FindLeiria — o que se passa em Leiria";
export const SHELL_DESCRIPTION =
	"Agenda de Leiria: concertos, teatro, exposições, festas e mercados do distrito, recolhidos todos os dias das fontes originais.";

/**
 * Keeps `<title>` and the meta description in step with the route.
 *
 * The prerendered HTML already carries both for event pages, but a client-side
 * navigation never reloads the document, so without this the tab would still
 * read the previous event's title. Every routed page sets its own for that
 * reason, including the ones that just want the site default back.
 *
 * A `null` title leaves the document alone: a page that is still waiting for
 * its data would otherwise overwrite the prerendered head with a generic one.
 */
export function useDocumentMeta(
	title: string | null,
	description?: string | null,
	noindex = false,
) {
	useEffect(() => {
		if (title === null) return;
		document.title = title;
		if (!description) return;
		const tag = document.querySelector('meta[name="description"]');
		if (tag) tag.setAttribute("content", description);
	}, [title, description]);

	// A dead slug serves the SPA shell with a 200, so `noindex` is the only
	// thing keeping thin, dataless URLs out of the index.
	useEffect(() => {
		if (!noindex) return;
		const tag = document.createElement("meta");
		tag.setAttribute("name", "robots");
		tag.setAttribute("content", "noindex");
		document.head.append(tag);
		return () => tag.remove();
	}, [noindex]);
}
