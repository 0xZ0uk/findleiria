import { parseMailFrom } from "./mail-from.js";
import type { MailMessage } from "./mailer.js";

/** What `env.EMAIL.send()` is given (the structured form of the binding). */
export type BindingMessage = {
	from: string | { email: string; name: string };
	to: string;
	subject: string;
	html: string;
	text: string;
};

/** The slice of the `send_email` binding this package uses. */
export type MailBinding = {
	send(message: BindingMessage): Promise<{ messageId: string }>;
};

/**
 * Maps our message plus the `MAIL_FROM` setting to the binding's shape. The
 * sender is `{ email, name }` when there is a display name and the bare address
 * otherwise (the runtime accepts both; the generated types make `name` required
 * on the object form).
 */
export function toBindingMessage(
	message: MailMessage,
	from: string,
): BindingMessage {
	const { email, name } = parseMailFrom(from);
	return {
		from: name ? { email, name } : email,
		to: message.to,
		subject: message.subject,
		html: message.html,
		text: message.text,
	};
}

/**
 * Sends through the binding. A failure throws (the binding rejects with an
 * `Error` carrying a `code` such as `E_SENDER_NOT_VERIFIED`), so better-auth
 * reports it instead of the user waiting for a mail that never comes.
 *
 * The log line carries the error code only: a recipient address is personal
 * data and the binding's message may echo it.
 */
export async function sendViaBinding(
	binding: MailBinding,
	message: MailMessage,
	from: string,
): Promise<void> {
	const payload = toBindingMessage(message, from);
	try {
		await binding.send(payload);
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		console.error(
			`[mail] delivery failed${typeof code === "string" ? ` (${code})` : ""}.`,
		);
		throw error;
	}
}
