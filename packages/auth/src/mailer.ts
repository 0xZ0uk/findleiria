import { deliver } from "#mailer-transport";

export type MailMessage = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

/** Anything that can deliver a message. Tests pass one that just records. */
export type Mailer = (message: MailMessage) => Promise<void>;

/**
 * The default mailer. Where the message goes is chosen by the
 * `#mailer-transport` import map (package.json): Cloudflare Email Sending in
 * the Worker, the console under Bun (development and tests).
 */
export const sendMail: Mailer = (message) => deliver(message);
