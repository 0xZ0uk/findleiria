import type { MailMessage } from "./mailer.js";

/**
 * The contract of the `#mailer-transport` import map, and the module its
 * `types` condition resolves to. Type-only on purpose: the real
 * implementations are mailer-transport.workerd.ts (needs `cloudflare:workers`)
 * and mailer-transport.node.ts; both annotate `deliver` with this signature, so
 * tsc checks each against it while packages that merely import
 * `@events-tracker/auth` never load either.
 */
export declare function deliver(message: MailMessage): Promise<void>;
