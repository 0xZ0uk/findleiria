import { describe, expect, test } from "bun:test";

import { missingAuthEnv, REQUIRED_AUTH_ENV } from "./env-check";

const COMPLETE = {
	BETTER_AUTH_SECRET: "x".repeat(32),
	BETTER_AUTH_URL: "https://findleiria.example",
	GOOGLE_CLIENT_ID: "id",
	GOOGLE_CLIENT_SECRET: "secret",
	MAIL_FROM: "FindLeiria <no-reply@findleiria.example>",
};

describe("missingAuthEnv", () => {
	test("is empty when everything is set", () => {
		expect(missingAuthEnv(COMPLETE)).toEqual([]);
	});

	test("names every unset or empty value, in schema order", () => {
		expect(missingAuthEnv({})).toEqual([...REQUIRED_AUTH_ENV]);
		expect(
			missingAuthEnv({ ...COMPLETE, GOOGLE_CLIENT_ID: "", MAIL_FROM: "  " }),
		).toEqual(["GOOGLE_CLIENT_ID", "MAIL_FROM"]);
	});

	test("flags a short secret and a malformed URL", () => {
		expect(
			missingAuthEnv({
				...COMPLETE,
				BETTER_AUTH_SECRET: "too-short",
				BETTER_AUTH_URL: "findleiria.example",
			}),
		).toEqual(["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]);
	});

	test("never puts a value in its result", () => {
		const out = missingAuthEnv({ ...COMPLETE, BETTER_AUTH_SECRET: "short" });
		expect(JSON.stringify(out)).not.toContain("short");
	});

	test("optional values are not required", () => {
		expect(
			missingAuthEnv({ ...COMPLETE, AUTH_TRUSTED_ORIGINS: undefined }),
		).toEqual([]);
	});
});
