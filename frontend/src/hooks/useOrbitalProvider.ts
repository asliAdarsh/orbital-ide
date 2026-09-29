/**
 * The account's ID token, kept current in the `orbital` profile that presents it.
 *
 * An Orbital profile's key is not a key: it is a Firebase ID token, which the SDK mints for the
 * signed-in account and refreshes on its own schedule — an hour from now, the stored copy is no
 * longer a credential. So the app subscribes to `onIdTokenChanged`, which fires on sign-in, on
 * sign-out and on every refresh, and writes what it hears into the profile. Nothing is pasted, and
 * the gateway still verifies the caller itself; the Orbital key stays on the server.
 *
 * Two things this deliberately does not do. It does not write when the value it has is already the
 * value it wrote — the effect runs on every redraw of the provider list, which is often. And it
 * does not *refuse* anything: signing out clears the stored token rather than deleting the profile,
 * so the next run reaches the gateway and gets its own 401, which is a true statement about the
 * credential where a local "this profile has no key" would send the user hunting for a field this
 * kind does not have.
 *
 * It is mounted by `useProviders`, the one hook every signed-in screen already calls, so the token
 * is reconciled for the whole session rather than only while a settings dialog happens to be open.
 */

import { useEffect, useState } from "react";
import { onIdTokenChanged } from "firebase/auth";

import { auth } from "@/lib/firebase";
import { ORBITAL_KIND, providers, type ProviderProfile } from "@/lib/providers";

/**
 * What this module last wrote, per profile.
 *
 * Module-level rather than per-hook because several screens mount `useProviders` at once — the
 * gate in `App`, the workspace, the settings dialog — and each of them watching the same profile
 * must not mean four identical writes on every token refresh. The API never hands a stored key
 * back, so this record is the only way to know a write would be redundant.
 */
const written = new Map<string, string>();

/**
 * Keep every `orbital` profile's stored key equal to the account's current ID token.
 *
 * `profiles` is whatever the caller last read, and is expected to be a fresh array on every list;
 * the effect below keys on it, so a profile created moments ago — during onboarding — is picked up
 * as soon as it appears.
 */
export function useOrbitalProvider(profiles: ProviderProfile[]): void {
  // Null until the SDK has said something; the empty string is a signed-out user, which is a
  // different thing from not knowing yet.
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (auth === null) return;
    return onIdTokenChanged(auth, (user) => {
      if (user === null) {
        setToken("");
        return;
      }
      // The listener fires *after* the SDK has refreshed, so this resolves from cache.
      void user.getIdToken().then(
        (fresh) => setToken(fresh),
        // A token that could not be read is not a token to store; the next event tries again.
        () => setToken(null),
      );
    });
  }, []);

  useEffect(() => {
    if (token === null) return;
    for (const profile of profiles) {
      if (profile.kind !== ORBITAL_KIND) continue;
      // Signing out with nothing stored is already the state being asked for.
      if (token === "" && !profile.apiKeySet) continue;
      if (written.get(profile.id) === token) continue;
      // Recorded before the write, so a second caller with the same list skips it rather than
      // racing it; forgotten again on failure so the next event or redraw retries.
      written.set(profile.id, token);
      void providers.update(profile.id, { apiKey: token }).catch(() => {
        written.delete(profile.id);
      });
    }
  }, [profiles, token]);
}
