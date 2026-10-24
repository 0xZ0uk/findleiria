import type { MailMessage } from "./mailer.js";

/**
 * Development and tests (the `bun` condition of `#mailer-transport`): nothing
 * is sent, the message is printed so a sign-up still works on a laptop and the
 * verification link can be copied from the terminal. The Worker never loads
 * this file.
 */
export async function deliver(message: MailMessage): Promise<void> {
	console.info(
		`[mail] Local transport; not sending.\n  to: ${message.to}\n  subject: ${message.subject}\n  ${message.text}`,
	);
}
