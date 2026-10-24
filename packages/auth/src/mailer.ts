import { createTransport, type Transporter } from "nodemailer";

import { authEnv } from "./env.js";

export type MailMessage = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

/** Anything that can deliver a message. Tests pass one that just records. */
export type Mailer = (message: MailMessage) => Promise<void>;

let transport: Transporter | undefined;

/** Built on first use, so importing auth never opens a socket. */
function getTransport(): Transporter {
	transport ??= createTransport({
		host: authEnv.SMTP_HOST,
		port: authEnv.SMTP_PORT,
		secure: authEnv.SMTP_SECURE,
		auth: { user: authEnv.SMTP_USER, pass: authEnv.SMTP_PASS },
	});
	return transport;
}

/**
 * Sends through the configured SMTP server.
 *
 * With no `SMTP_HOST` (development and tests; production refuses to boot
 * without one) the message is printed instead, so a sign-up still works on a
 * laptop and the verification link can be copied from the terminal.
 */
export const sendMail: Mailer = async (message) => {
	if (!authEnv.SMTP_HOST) {
		console.info(
			`[mail] SMTP not configured; not sending.\n  to: ${message.to}\n  subject: ${message.subject}\n  ${message.text}`,
		);
		return;
	}

	await getTransport().sendMail({ from: authEnv.SMTP_FROM, ...message });
};
