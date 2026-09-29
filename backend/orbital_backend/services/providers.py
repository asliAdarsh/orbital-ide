"""The provider profiles a run may talk to, and the credential each one holds.

The single process-wide endpoint that ``ORBITAL_LLM_*`` describes becomes a list the user picks
between: one profile is active, and the active profile is what every agent run talks to. The
dotenv values stay as the fallback for a machine that has no profiles, so a fresh clone and the
existing tests behave exactly as they did.

The store follows the project registry — one JSON file under the state directory, replaced whole
so a crash cannot leave it half-written, read tolerantly so a corrupt file is an empty list rather
than a failure to start — with one difference this module exists to make: **this file holds API
keys**. It is written with permissions for the current account alone, and the key never leaves
this module except as the boolean and the tail :meth:`ProviderProfile.info` returns.
"""

from __future__ import annotations

import ipaddress
import json
import os
import threading
import time
import uuid
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import urlsplit

from orbital_backend import config
from orbital_backend.errors import CommandError, NotFoundError, ToolError, logger
from orbital_backend.models import (
    PROVIDER_PRESETS,
    ModelSource,
    ProviderKind,
    ProviderPreset,
    ProviderProfile,
)
from orbital_backend.services.settings_file import restrict_to_user, write_env_values

_log = logger(__name__)

#: The file beside ``projects.json``. Both are keyed on the state directory rather than a
#: loaded-once flag, so pointing the backend at a different directory serves that directory.
FILE_NAME = "providers.json"

#: Longest label the dashboards render without truncating; the same ceiling a project name has.
LABEL_LIMIT = 80

#: Longest base URL stored. Deep enough for a gateway behind a path prefix, short enough that a
#: pasted blob is refused before it reaches the store.
BASE_URL_LIMIT = 300

#: Names that always mean this machine, whatever the resolver would say.
_LOOPBACK_HOSTS = frozenset({"localhost", "localhost.localdomain"})

#: What a stored key is called in the notice that a profile now points somewhere else.
KEY_MOVED_NOTICE = (
    "the key stored for {label!r} was entered for {before}: it will now be sent to {after}"
)


def _is_local_address(host: str) -> bool:
    """Whether ``host`` names this machine or a network only the local side can reach.

    A key sent to one of these goes to whatever answers there — a local server, a router's admin
    page, a cloud metadata endpoint — which is a credential leak wearing the user's own keystrokes
    as a disguise. The ``local`` kind exists for exactly those endpoints; every other kind means a
    provider on the internet, so the address has to be reachable from it.
    """
    name = host.strip().lower().rstrip(".")
    if name in _LOOPBACK_HOSTS or name.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(name)
    except ValueError:
        return False
    # ``is_private`` already covers loopback and link-local for both families; the explicit calls
    # keep the intent readable and hold if the classification is ever narrowed.
    return address.is_private or address.is_loopback or address.is_link_local


#: The kinds whose endpoint is deliberately allowed to be on this machine or this network.
#:
#: ``local`` is one by definition. ``orbital`` is the other one, and for one reason: the Firebase
#: functions emulator the gateway runs under in development *is* a loopback address by design
#: (``http://127.0.0.1:5001/<project>/us-central1/orbital/v1``), so refusing a private address for
#: this kind would make the local end-to-end path impossible to configure. The backend cannot see
#: the client's emulator flag — it is a build-time value in the app — so the exemption is the kind
#: rather than a condition, and a deployed orbital profile is a ``cloudfunctions.net`` URL anyway.
_LOOPBACK_KINDS = frozenset({ProviderKind.LOCAL, ProviderKind.ORBITAL})


def provider_file() -> Path:
    """The provider store: one JSON file under :func:`orbital_backend.config.state_dir`."""
    return config.state_dir() / FILE_NAME


def _validated_label(raw: str) -> str:
    label = str(raw).strip()
    if not label:
        raise ToolError("a provider profile needs a label")
    if len(label) > LABEL_LIMIT:
        raise ToolError(f"a provider label is longer than {LABEL_LIMIT} characters")
    return label


def _validated_kind(raw: str) -> ProviderKind:
    kind = str(raw).strip()
    for candidate in ProviderKind:
        if kind == candidate.value:
            return candidate
    accepted = ", ".join(candidate.value for candidate in ProviderKind)
    raise ToolError(f"unknown provider kind {kind!r}: choose one of {accepted}")


def _validated_base_url(raw: str, kind: ProviderKind) -> str:
    url = str(raw).strip()
    if not url:
        raise ToolError("a provider profile needs a base URL")
    if len(url) > BASE_URL_LIMIT:
        raise ToolError(f"a provider base URL is longer than {BASE_URL_LIMIT} characters")
    parts = urlsplit(url)
    # A scheme and a host, not just a colon somewhere: the client builds a request from this, and
    # a bare `127.0.0.1:11434/v1` would otherwise parse as a URL with the scheme `127.0.0.1`.
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ToolError("a provider base URL must be an http:// or https:// URL")
    host = parts.hostname or ""
    if kind not in _LOOPBACK_KINDS and _is_local_address(host):
        raise ToolError(
            f"{host} is a loopback, private or link-local address, and a {kind.value!r} profile "
            "does not send its key there. Choose the 'local' kind for an endpoint on this machine "
            "or this network."
        )
    return url.rstrip("/")


def _validated_model(raw: str) -> str:
    model = str(raw).strip()
    if not model:
        raise ToolError("a provider profile needs a model")
    return model


def _validated_api_key(raw: str | None) -> str | None:
    """The key to store, or ``None`` for "no key" — which is what every blank spelling means."""
    key = ("" if raw is None else str(raw)).strip()
    return key or None


def _read(path: Path) -> list[ProviderProfile]:
    """Read the store; anything unreadable is an empty list, with a warning."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as exc:
        _log.warning("could not read the provider profiles at %s: %s", path, exc)
        return []
    try:
        payload = json.loads(text)
        profiles = [ProviderProfile.model_validate(item) for item in payload["profiles"]]
    except (ValueError, KeyError, TypeError) as exc:
        _log.warning("ignoring a corrupt provider store at %s: %s", path, exc)
        return []
    return _normalised(profiles)


def _normalised(profiles: Sequence[ProviderProfile]) -> list[ProviderProfile]:
    """At most one profile is active: the first one that says so, and no other."""
    active = next((profile for profile in profiles if profile.active), None)
    for profile in profiles:
        profile.active = profile is active
    return list(profiles)


def _write(path: Path, profiles: Sequence[ProviderProfile]) -> None:
    """Replace the store in one step, with the file readable only by this account.

    Written without the camelCase alias rule: that rule exists for the wire, and this file is
    the store. The permissions are applied to the temporary file *before* it is moved into place,
    because ``os.replace`` keeps the permissions the file already has and tightening the final
    path afterwards would leave a window in which the key is readable.
    """
    payload = {"profiles": [profile.model_dump(mode="json") for profile in profiles]}
    temporary = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        restrict_to_user(temporary)
        os.replace(temporary, path)
    except OSError as exc:
        raise CommandError(f"could not write the provider profiles: {exc}") from exc
    finally:
        # Gone after a successful move; the leftover of a refused one, otherwise.
        temporary.unlink(missing_ok=True)


def _blank_dotenv_key() -> None:
    """Drop the credential from ``.env`` now that the profile store holds it.

    The credential gets one home. Leaving a second copy behind would keep exactly the leak this
    store was written to close, and it would be the copy with the weaker permissions — ``.env`` is
    the file a checkout, a backup or a sync tool is most likely to carry off the machine.

    Called only from a migration that did copy the key, and a failure is logged and swallowed:
    the profile is written and usable either way, and refusing to start over the fallback file
    would trade a working installation for a housekeeping detail.
    """
    if not config.settings.llm_api_key.strip():
        return
    try:
        write_env_values(config.env_file_path(), {"ORBITAL_LLM_API_KEY": ""})
    except (OSError, CommandError) as exc:
        _log.warning("could not blank ORBITAL_LLM_API_KEY in the backend's .env: %s", exc)
        return
    # The running process must not keep a copy either: the file it came from no longer has one, so
    # a fallback read would now be reading state that does not exist on disk.
    config.settings.llm_api_key = ""


def _find(profiles: Sequence[ProviderProfile], profile_id: str) -> ProviderProfile:
    found = next((profile for profile in profiles if profile.id == profile_id), None)
    if found is None:
        raise NotFoundError(f"unknown provider profile: {profile_id}")
    return found


def _base_url_key(url: str | None) -> str:
    """Two spellings of the same endpoint — a trailing slash apart — are the same endpoint."""
    return (url or "").strip().rstrip("/")


def preset_for(profile: ProviderProfile) -> ProviderPreset | None:
    """The preset this profile started from, or ``None`` when it names an endpoint of its own.

    Matched on the base URL, because a stored profile does not remember a preset id: the id is the
    *form's* vocabulary and the profile is what the user then edited, so the URL is the only thing
    that still links them. That a company gateway or a different port answers ``None`` is the point
    — the preset's curated model list describes the *preset's* endpoint, and offering it for an
    endpoint that is not that would be inventing models for someone else's server.
    """
    wanted = _base_url_key(profile.base_url)
    return next(
        (preset for preset in PROVIDER_PRESETS if _base_url_key(preset.base_url) == wanted), None
    )


def _copies(profiles: Sequence[ProviderProfile]) -> list[ProviderProfile]:
    """Hand callers their own copies, so no handler can edit the live store by accident."""
    return [profile.model_copy(deep=True) for profile in profiles]


class ProviderRegistry:
    """Load, list, create, edit and forget provider profiles, writing every change to the store."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._path: Path | None = None
        self._profiles: list[ProviderProfile] = []

    def list(self) -> list[ProviderProfile]:
        """Every profile, in the order the user created them."""
        with self._lock:
            _path, profiles = self._current()
            return _copies(profiles)

    def find(self, profile_id: str) -> ProviderProfile:
        """One profile by id, or :class:`NotFoundError`."""
        with self._lock:
            _path, profiles = self._current()
            return _find(profiles, profile_id).model_copy(deep=True)

    def active(self) -> ProviderProfile | None:
        """The profile a run talks to, or ``None`` when the user has configured none."""
        with self._lock:
            _path, profiles = self._current()
            found = next((profile for profile in profiles if profile.active), None)
            return None if found is None else found.model_copy(deep=True)

    def create(
        self,
        *,
        label: str,
        kind: str,
        base_url: str,
        model: str,
        api_key: str | None = None,
    ) -> list[ProviderProfile]:
        """Add a profile and return the new list.

        The first profile the user creates becomes active: they created it to use it, and an
        empty settings page that leaves a fresh profile inactive would look broken. Afterwards the
        active profile only moves when the user says so.

        A key is not required here even for a provider that needs one. The user may be pasting the
        URL first and the key second, and the connection test is what tells them it is missing —
        refusing the profile would only hide the endpoint they are trying to check.
        """
        # The kind decides whether the address is allowed, so it is read before the address is.
        wanted_kind = _validated_kind(kind)
        profile = ProviderProfile(
            id=uuid.uuid4().hex,
            label=_validated_label(label),
            kind=wanted_kind,
            base_url=_validated_base_url(base_url, wanted_kind),
            model=_validated_model(model),
            api_key=_validated_api_key(api_key),
            created_at=int(time.time()),
        )
        with self._lock:
            path, profiles = self._current()
            profile.active = not any(item.active for item in profiles)
            profiles.append(profile)
            _write(path, profiles)
            _log.info("added provider profile %s (%s, %s)", profile.id, profile.kind, profile.label)
            return _copies(profiles)

    def update(
        self,
        profile_id: str,
        *,
        label: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
    ) -> list[ProviderProfile]:
        """Edit one profile; ``None`` leaves a field as it was, an empty key clears it.

        Every field is validated before any of them is assigned, so a refused edit leaves the
        profile exactly as it was — in memory as well as on disk. The base URL is validated
        against the kind the profile already has: the kind decides whether an address may hold a
        credential, and an edit cannot change the kind.

        A base URL that actually moves clears the stored model list, because that list described
        the endpoint it was fetched from: keeping it would offer the old server's models as this
        one's, and the models endpoint is what replaces it.
        """
        with self._lock:
            path, profiles = self._current()
            target = _find(profiles, profile_id)
            wanted_label = None if label is None else _validated_label(label)
            wanted_url = None if base_url is None else _validated_base_url(base_url, target.kind)
            wanted_model = None if model is None else _validated_model(model)
            wanted_key = None if api_key is None else _validated_api_key(api_key)
            if wanted_label is not None:
                target.label = wanted_label
            if wanted_url is not None:
                if wanted_url != target.base_url:
                    target.models = []
                    target.models_fetched_at = None
                    target.models_source = None
                target.base_url = wanted_url
            if wanted_model is not None:
                target.model = wanted_model
            if api_key is not None:
                target.api_key = wanted_key
            _write(path, profiles)
            _log.info("updated provider profile %s", profile_id)
            return _copies(profiles)

    def store_models(
        self,
        profile_id: str,
        models: Sequence[str],
        source: ModelSource,
    ) -> ProviderProfile:
        """Record what a profile's endpoint serves, and where that list came from.

        Written straight through to the store rather than kept in a process-memory cache: the
        dropdown is answered from this, so a restart must not empty a list the user already
        fetched. ``models_fetched_at`` is stamped here, at the one moment a list becomes stored, so
        the two cannot disagree about when it was fetched.
        """
        with self._lock:
            path, profiles = self._current()
            target = _find(profiles, profile_id)
            target.models = list(models)
            target.models_fetched_at = int(time.time())
            target.models_source = source
            _write(path, profiles)
            _log.info(
                "stored %d model ids for provider profile %s (%s)",
                len(target.models),
                profile_id,
                source,
            )
            return target.model_copy(deep=True)

    def delete(self, profile_id: str) -> list[ProviderProfile]:
        """Forget a profile and return what remains.

        An active profile hands the badge to the next one in the list, or to nobody when it was
        the last: what remains is either a profile the user can still run on, or an empty list
        that reads as "configure a provider" — never a list whose active id points at nothing.
        """
        with self._lock:
            path, profiles = self._current()
            target = _find(profiles, profile_id)
            remaining = [profile for profile in profiles if profile.id != profile_id]
            if target.active and not any(profile.active for profile in remaining) and remaining:
                remaining[0].active = True
            self._profiles = remaining
            _write(path, remaining)
            _log.info("removed provider profile %s", profile_id)
            return _copies(remaining)

    def activate(self, profile_id: str) -> list[ProviderProfile]:
        """Make one profile the one every run talks to, and return the new list."""
        with self._lock:
            path, profiles = self._current()
            _find(profiles, profile_id)
            for profile in profiles:
                profile.active = profile.id == profile_id
            _write(path, profiles)
            _log.info("activated provider profile %s", profile_id)
            return _copies(profiles)

    def migrate_from_env(self) -> ProviderProfile | None:
        """Turn the dotenv credential into a profile, once, on the first start after the upgrade.

        An installation that predates profiles already has a working key in ``.env``, and asking
        its owner to type it again would be a regression: the first start that finds no store
        creates one profile from those values and makes it active, and blanks the key in ``.env``
        so the credential ends up with one home instead of two — the one with permissions this
        module sets. The URL and model stay where they are: they are not secret, and they are what
        a machine with no profiles at all falls back to.

        Only when the store does not exist. A store the user owns — including one they have
        emptied — is their state, not ours to seed, so deleting every profile does not resurrect
        one on the next start. That also makes the call safe to repeat, which is what lets startup
        make it unconditionally.
        """
        with self._lock:
            path = provider_file()
            if path.exists():
                return None
            key = _validated_api_key(config.settings.llm_api_key)
            if key is None:
                return None
            try:
                # The address decides the kind here rather than the other way round: a dotenv
                # value that points at this machine or this network is a `local` endpoint, and
                # importing it as anything else would be refused as a credential leak.
                kind = (
                    ProviderKind.LOCAL
                    if _is_local_address(urlsplit(config.settings.llm_base_url).hostname or "")
                    else ProviderKind.OPENAI_COMPATIBLE
                )
                base_url = _validated_base_url(config.settings.llm_base_url, kind)
                model = _validated_model(config.settings.llm_model)
            except ToolError as exc:
                # A hand-edited .env that no longer parses must not stop the backend from
                # starting; the settings page can still write a good one.
                _log.warning("not importing the .env credential into a profile: %s", exc)
                return None
            profile = ProviderProfile(
                id=uuid.uuid4().hex,
                # The host, because that is what the user recognises in a list: "opencode.ai".
                label=urlsplit(base_url).hostname or base_url,
                kind=kind,
                base_url=base_url,
                model=model,
                api_key=key,
                active=True,
                created_at=int(time.time()),
            )
            self._path, self._profiles = path, [profile]
            _write(path, self._profiles)
            _blank_dotenv_key()
            _log.info("imported the .env credential as the provider profile %r", profile.label)
            return profile.model_copy(deep=True)

    def _current(self) -> tuple[Path, list[ProviderProfile]]:
        """The store file and its live profile list, reading the file when the path is new.

        Keyed on the resolved path rather than a loaded-once flag so configuring a different state
        directory is honoured instead of serving another file's profiles. Caller holds the lock.
        """
        path = provider_file()
        if path != self._path:
            self._path = path
            self._profiles = _read(path)
        return path, self._profiles


providers = ProviderRegistry()


def profile_is_usable(profile: ProviderProfile) -> bool:
    """Whether a run could start against this profile.

    A ``local`` endpoint needs no key — that is what the kind means — and an ``orbital`` profile
    carries the signed-in account's ID token as its key, which the app refreshes itself rather
    than the user pasting one. An orbital profile whose token has been *cleared* — the user signed
    out — is still usable: the run reaches the gateway and the gateway's own 401 is what says the
    sign-in has lapsed, which is a true statement about the credential, where "this profile has no
    API key, add one in Settings" would send the user looking for a field that does not exist.
    Every other provider needs its own key. One function, so the credential check and the endpoint
    a run is built from cannot disagree about whether a profile is finished.
    """
    return profile.kind in _LOOPBACK_KINDS or bool((profile.api_key or "").strip())


def credential_configured() -> bool:
    """Whether a run has a credential to start with.

    The active profile decides when there is one, because the active profile is what the run will
    talk to: a ``local`` profile needs no key, an ``orbital`` one is answered for by the token the
    app keeps current, and any other profile needs its own. A key in ``.env`` is deliberately *not*
    substituted for a profile that has none — that key belongs to the endpoint ``.env`` describes,
    and sending it to the user's new endpoint would be a credential leak dressed up as a
    convenience.

    With no profile configured the answer is the dotenv key, which is what a fresh clone has and
    what every installation had before profiles existed.
    """
    profile = providers.active()
    if profile is not None:
        return profile_is_usable(profile)
    return bool(config.settings.llm_api_key.strip())
