import { describe, expect, mock, test } from "bun:test";

import {
	type BindingMessage,
	type MailBinding,
	sendViaBinding,
	toBindingMessage,
} from "./mail-binding";
import { parseMailFrom } from "./mail-from";
import type { MailMessage } from "./mailer";

const MESSAGE: MailMessage = {
	to: "leitor@example.com",
	subject: "Confirme o seu email",
	text: "Abra https://findleiria.pt/verify",
	html: "<p>Abra <a href='https://findleiria.pt/verify'>aqui</a></p>",
};

describe("parseMailFrom", () => {
	test.each([
		["no-reply@findleiria.pt", { email: "no-reply@findleiria.pt" }],
		["  no-reply@findleiria.pt  ", { email: "no-reply@findleiria.pt" }],
		[
			"FindLeiria <no-reply@findleiria.pt>",
			{ email: "no-reply@findleiria.pt", name: "FindLeiria" },
		],
		[
			'"FindLeiria" <no-reply@findleiria.pt>',
			{ email: "no-reply@findleiria.pt", name: "FindLeiria" },
		],
		[
			"Find Leiria, Eventos <no-reply@findleiria.pt>",
			{ email: "no-reply@findleiria.pt", name: "Find Leiria, Eventos" },
		],
		["<no-reply@findleiria.pt>", { email: "no-reply@findleiria.pt" }],
	])("accepts %j", (input, expected) => {
		expect(parseMailFrom(input)).toEqual(expected);
	});

	test.each([
		"",
		"findleiria",
		"FindLeiria no-reply@findleiria.pt",
		"FindLeiria <no-reply>",
		"FindLeiria <a@b.pt> <c@d.pt>",
		"a@b.pt, c@d.pt",
		'Bad "Name <no-reply@findleiria.pt>',
		"Name\r\nBcc: x@y.pt <no-reply@findleiria.pt>",
	])("rejects %j", (input) => {
		expect(() => parseMailFrom(input)).toThrow(/MAIL_FROM/);
	});
});

describe("toBindingMessage", () => {
	test("maps the message to the binding's structured form", () => {
		expect(
			toBindingMessage(MESSAGE, "FindLeiria <no-reply@findleiria.pt>"),
		).toEqual({
			from: { email: "no-reply@findleiria.pt", name: "FindLeiria" },
			to: MESSAGE.to,
			subject: MESSAGE.subject,
			html: MESSAGE.html,
			text: MESSAGE.text,
		});
	});
});

describe("sendViaBinding", () => {
	test("sends one message with both html and text parts", async () => {
		const sent: BindingMessage[] = [];
		const binding: MailBinding = {
			send: async (message) => {
				sent.push(message);
				return { messageId: "id-1" };
			},
		};

		await sendViaBinding(binding, MESSAGE, "no-reply@findleiria.pt");

		expect(sent).toEqual([
			{
				from: "no-reply@findleiria.pt",
				to: MESSAGE.to,
				subject: MESSAGE.subject,
				html: MESSAGE.html,
				text: MESSAGE.text,
			},
		]);
	});

	test("a delivery failure throws and logs the code, not the recipient", async () => {
		const failure = Object.assign(
			new Error(`cannot deliver to ${MESSAGE.to}`),
			{
				code: "E_DELIVERY_FAILED",
			},
		);
		const binding: MailBinding = {
			send: async () => {
				throw failure;
			},
		};
		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};

		try {
			await expect(
				sendViaBinding(binding, MESSAGE, "no-reply@findleiria.pt"),
			).rejects.toBe(failure);
		} finally {
			console.error = original;
		}

		expect(logged).toHaveLength(1);
		const line = String(logged[0]?.[0]);
		expect(line).toContain("E_DELIVERY_FAILED");
		expect(line).not.toContain(MESSAGE.to);
	});

	test("a bad sender throws before the binding is called", async () => {
		const send = mock(async () => ({ messageId: "x" }));

		await expect(
			sendViaBinding({ send }, MESSAGE, "not a sender"),
		).rejects.toThrow(/MAIL_FROM/);
		expect(send).not.toHaveBeenCalled();
	});
});
