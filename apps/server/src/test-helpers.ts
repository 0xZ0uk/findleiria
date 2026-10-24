/**
 * Test-only helpers. Not a `.test` file, so `bun test` does not pick it up as
 * a suite.
 */

/**
 * Narrow `T | null | undefined` to `T`, failing the test with a readable
 * message instead of a later `Cannot read properties of undefined`. Replaces
 * the `!` non-null assertion in tests.
 */
export function must<T>(value: T | null | undefined, message?: string): T {
	if (value === null || value === undefined) {
		throw new Error(message ?? "expected a value, got null or undefined");
	}
	return value;
}
