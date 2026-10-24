import { describe, expect, test } from "bun:test";

import { parseDeployHookResponse } from "./publish-lib";

describe("parseDeployHookResponse", () => {
	test("reads build_uuid from result", () => {
		expect(
			parseDeployHookResponse(
				JSON.stringify({
					success: true,
					errors: [],
					messages: [],
					result: {
						build_uuid: "b-123",
						branch: "master",
						worker: "findleiria",
					},
				}),
			),
		).toEqual({ buildUuid: "b-123", alreadyQueued: false });
	});

	test("flags a build that was already queued", () => {
		expect(
			parseDeployHookResponse(
				JSON.stringify({
					success: true,
					result: {
						build_uuid: "b-9",
						status: "queued",
						already_exists: true,
					},
				}),
			),
		).toEqual({ buildUuid: "b-9", alreadyQueued: true });
	});

	test("tolerates a top-level build_uuid, other shapes and non-JSON", () => {
		expect(parseDeployHookResponse('{"build_uuid":"top"}').buildUuid).toBe(
			"top",
		);
		for (const body of [
			"",
			"ok",
			"null",
			"[]",
			'{"result":null}',
			'{"result":{"build_uuid":7}}',
		]) {
			expect(parseDeployHookResponse(body)).toEqual({
				buildUuid: null,
				alreadyQueued: false,
			});
		}
	});
});
