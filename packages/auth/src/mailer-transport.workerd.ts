import { env } from "cloudflare:workers";

import { authEnv } from "./env.js";
import { sendViaBinding } from "./mail-binding.js";
import type { MailMessage } from "./mailer.js";

/**
 * Mail through Cloudflare Email Sending, over the `EMAIL` `send_email` binding
 * (`wrangler.jsonc`). Selected by the `#mailer-transport` import map for the
 * `workerd` condition, and it is also the map's `default`, for the same reason
 * as `#auth-db`: outside Bun, `cloudflare:workers` fails to resolve loudly
 * instead of silently dropping mail. The mapping and error handling live in
 * mail-binding.ts so Bun can test them without the Workers runtime.
 */
export async function deliver(message: MailMessage): Promise<void> {
	const from = authEnv.MAIL_FROM;
	if (!from) {
		throw new Error(
			"MAIL_FROM is not set; the verification mail cannot be sent.",
		);
	}

	// Wrapped, not passed as `env.EMAIL`: SendEmail also has a legacy raw-MIME
	// overload, which TypeScript would otherwise try to match against.
	await sendViaBinding(
		{ send: (builder) => env.EMAIL.send(builder) },
		message,
		from,
	);
}
