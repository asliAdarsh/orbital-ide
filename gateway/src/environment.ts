/**
 * The names the deployment and the process environment agree on.
 *
 * They live in their own module so that `config.ts` (which the proxy uses) does not have to import
 * `firebase-functions` — nothing on the request path needs the functions runtime, which is what
 * lets the tests drive the whole gateway with plain Express.
 */

export const DEFAULT_UPSTREAM_BASE_URL = "https://opencode.ai/zen/go/v1";
export const UPSTREAM_BASE_URL_ENV = "ORBITAL_UPSTREAM_BASE_URL";
export const UPSTREAM_KEY_ENV = "ORBITAL_UPSTREAM_API_KEY";
