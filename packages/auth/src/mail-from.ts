/** A sender, in the `{ email, name }` form the Email Sending binding takes. */
export type MailAddress = { email: string; name?: string };

// Deliberately plain: one `@`, no whitespace, no angle brackets or quotes. The
// binding validates properly (E_VALIDATION_ERROR); this only has to tell the
// address apart from the display name and refuse anything that smells like
// header injection.
const ADDRESS = /^[^\s<>"@,;]+@[^\s<>"@,;]+\.[^\s<>"@,;]+$/;

/**
 * Parses `MAIL_FROM`. Accepted forms:
 *
 *   no-reply@findleiria.pt
 *   FindLeiria <no-reply@findleiria.pt>
 *   "FindLeiria" <no-reply@findleiria.pt>
 *
 * Throws on anything else, so a typo fails the first send loudly instead of
 * producing a mail with a mangled sender.
 */
export function parseMailFrom(value: string): MailAddress {
	const text = value.trim();

	if (ADDRESS.test(text)) return { email: text };

	const match = /^(.*?)\s*<([^<>]*)>$/.exec(text);
	if (match) {
		const email = (match[2] ?? "").trim();
		let name = (match[1] ?? "").trim();
		if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
			name = name.slice(1, -1).trim();
		}
		// A quote or line break left inside the name is not something to guess at.
		if (ADDRESS.test(email) && !/["<>\r\n]/.test(name)) {
			return name ? { email, name } : { email };
		}
	}

	throw new Error(
		'MAIL_FROM must be an address ("no-reply@example.com") or "Name <address>".',
	);
}
