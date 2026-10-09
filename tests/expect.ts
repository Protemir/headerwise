// Tiny expect() on top of node:assert, so tests run with plain `node --test`
// and need nothing from npm.
import assert from 'node:assert/strict';

export function expect<T>(actual: T) {
  return {
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toHaveLength: (n: number) => assert.strictEqual((actual as { length: number }).length, n),
    toMatch: (re: RegExp) => assert.match(String(actual), re),
    toContain: (item: unknown) => assert.ok((actual as unknown[]).includes(item), `expected to contain ${String(item)}`),
  };
}
