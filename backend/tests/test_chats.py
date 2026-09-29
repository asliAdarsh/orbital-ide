"""Chats: the conversations the sidebar lists, the state behind each one, and what survives a
restart.

The HTTP calls go through the real ASGI app, as everywhere else. A "restart" here is a second
:class:`SessionStore` built over the same state directory, which is exactly what a new process
does — the ASGI transport does not run the lifespan, so the store on disk is the only thing the
two have in common.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import pytest

from orbital_backend.models import (
    AgentId,
    ChatMessage,
    MessageRole,
    Phase,
    RunStatus,
    UsageSnapshot,
)
from orbital_backend.services.sessions import (
    CHATS_DIR,
    INDEX_FILE,
    SessionStore,
    chats_dir,
    sessions,
)

pytestmark = pytest.mark.asyncio


async def _create(client: httpx.AsyncClient, **body: object) -> dict[str, object]:
    """Create a chat through the API and return it as the wire carried it back."""
    response = await client.post("/api/chats", json=body)
    assert response.status_code == 200, response.text
    return response.json()["chat"]


async def _listed(client: httpx.AsyncClient, **params: object) -> list[dict[str, object]]:
    response = await client.get("/api/chats", params=params)
    assert response.status_code == 200, response.text
    return response.json()["chats"]


async def _refreshed(client: httpx.AsyncClient, chat_id: str) -> dict[str, object]:
    """What the composer gets when it opens a chat: the chat and the state behind it."""
    response = await client.get(f"/api/chats/{chat_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _user(chat_id: str, content: str) -> None:
    sessions.add_message(
        chat_id,
        ChatMessage(
            id=uuid.uuid4().hex,
            role=MessageRole.USER,
            agent=AgentId.ORCHESTRATOR,
            content=content,
            phase=Phase.PLAN,
            created_at=int(time.time()),
        ),
    )


def _exchange(chat_id: str, prompt: str, answer: str) -> None:
    """Record one whole exchange the way a run leaves it: a user turn, then a sealed answer."""
    _user(chat_id, prompt)
    message_id = uuid.uuid4().hex
    sessions.add_message(
        chat_id,
        ChatMessage(
            id=message_id,
            role=MessageRole.ASSISTANT,
            agent=AgentId.ORCHESTRATOR,
            content="",
            phase=Phase.PLAN,
            created_at=int(time.time()),
            streaming=True,
        ),
    )
    # Streamed a token at a time, then sealed — the same path the runner takes. Neither the token
    # calls nor the seal may need a write of their own for the answer to survive.
    sessions.append_token(chat_id, message_id, answer)
    sessions.end_message(chat_id, message_id, answer)


# -------------------------------------------------------------------------------------
# The lifecycle
# --------------------------------------------------------------------------------------


async def test_a_chat_is_created_listed_renamed_cleared_and_deleted(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    created = await _create(client, workspace=str(sample_project))
    # Exactly the frozen contract's fields: `renamed` is the backend's own flag and must not leak
    # onto the wire, and no field may go missing from it.
    assert set(created) == {
        "id",
        "title",
        "workspace",
        "phase",
        "providerId",
        "model",
        "createdAt",
        "updatedAt",
        "messageCount",
        "runStatus",
    }
    assert created["title"] == "New chat"
    assert created["workspace"] == str(sample_project)
    assert created["phase"] == "plan"
    assert created["runStatus"] == "idle"
    assert created["messageCount"] == 0

    listed = await _listed(client)
    assert [chat["id"] for chat in listed] == [created["id"]]

    renamed = await client.patch(f"/api/chats/{created['id']}", json={"title": "Parser work"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["chat"]["title"] == "Parser work"
    assert (await _listed(client))[0]["title"] == "Parser work"

    cleared = await client.post(f"/api/chats/{created['id']}/clear")
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["chat"]["id"] == created["id"]

    deleted = await client.delete(f"/api/chats/{created['id']}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["chats"] == []


async def test_a_deleted_chat_takes_its_transcript_with_it(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    """A transcript holds the user's code: deleting a chat has to delete the file, not hide it."""
    chat = await _create(client, workspace=str(sample_project))
    _exchange(str(chat["id"]), "Delete me", "Gone")
    path = chats_dir() / f"{chat['id']}.json"
    assert path.exists()

    await client.delete(f"/api/chats/{chat['id']}")

    assert not path.exists()
    assert json.loads((chats_dir() / INDEX_FILE).read_text(encoding="utf-8"))["chats"] == []


async def test_an_id_nothing_has_seen_becomes_a_chat(client: httpx.AsyncClient) -> None:
    """The socket accepts any id a client picks, so this route must do the same."""
    chat_id = uuid.uuid4().hex

    body = await _refreshed(client, chat_id)

    assert body["chat"]["id"] == chat_id
    assert body["chat"]["title"] == "New chat"
    assert body["state"]["sessionId"] == chat_id
    assert [chat["id"] for chat in await _listed(client)] == [chat_id]


async def test_an_unknown_chat_is_a_404_for_every_verb(client: httpx.AsyncClient) -> None:
    unknown = uuid.uuid4().hex

    responses = [
        await client.patch(f"/api/chats/{unknown}", json={"title": "nope"}),
        await client.delete(f"/api/chats/{unknown}"),
        await client.post(f"/api/chats/{unknown}/clear"),
    ]

    assert [response.status_code for response in responses] == [404, 404, 404]
    assert all("unknown chat" in response.json()["detail"] for response in responses)


# -------------------------------------------------------------------------------------
# What the chat follows, and what the state follows
# --------------------------------------------------------------------------------------


async def test_a_patch_moves_the_phase_and_pins_a_provider(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    chat = await _create(client, workspace=str(sample_project))

    patched = await client.patch(
        f"/api/chats/{chat['id']}",
        json={"phase": "build", "providerId": "profile-1", "model": "some-model"},
    )

    pinned = patched.json()["chat"]
    assert (pinned["phase"], pinned["providerId"], pinned["model"]) == (
        "build",
        "profile-1",
        "some-model",
    )
    # The phase is the session's as well as the chat's: a run started from this chat works on the
    # phase the sidebar is showing.
    assert (await _refreshed(client, str(chat["id"])))["state"]["activePhase"] == "build"


async def test_the_chats_run_status_follows_the_session(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    """Pause is reported through the state; the sidebar reads it off the chat."""
    chat = await _create(client, workspace=str(sample_project))

    sessions.set_status(str(chat["id"]), RunStatus.PAUSED)

    assert (await _refreshed(client, str(chat["id"])))["chat"]["runStatus"] == "paused"
    assert (await _listed(client))[0]["runStatus"] == "paused"


# -------------------------------------------------------------------------------------
# The title
# --------------------------------------------------------------------------------------


async def test_the_first_user_message_names_the_chat(client: httpx.AsyncClient) -> None:
    chat = await _create(client)

    _user(str(chat["id"]), "  Fix the parser  \nand the lexer after it")

    body = await _refreshed(client, str(chat["id"]))
    assert body["chat"]["title"] == "Fix the parser"
    assert body["chat"]["messageCount"] == 1


async def test_only_the_first_message_names_the_chat(client: httpx.AsyncClient) -> None:
    """Otherwise the sidebar would show whichever message happened to arrive last."""
    chat = await _create(client)

    _user(str(chat["id"]), "First subject")
    _user(str(chat["id"]), "Second subject")

    assert (await _refreshed(client, str(chat["id"])))["chat"]["title"] == "First subject"


async def test_a_long_first_message_is_bounded_to_one_line(client: httpx.AsyncClient) -> None:
    chat = await _create(client)

    _user(str(chat["id"]), "x" * 200)

    title = (await _refreshed(client, str(chat["id"])))["chat"]["title"]
    assert title == "x" * 60
    assert "\n" not in title


async def test_a_rename_is_never_overwritten(client: httpx.AsyncClient) -> None:
    chat = await _create(client)
    chat_id = str(chat["id"])

    await client.patch(f"/api/chats/{chat_id}", json={"title": "My own name"})
    _user(chat_id, "Something else entirely")

    assert (await _refreshed(client, chat_id))["chat"]["title"] == "My own name"


async def test_a_chat_created_with_a_title_keeps_it(client: httpx.AsyncClient) -> None:
    """A title on the create call is a name the user chose, not a placeholder to replace."""
    chat = await _create(client, title="Chosen up front")
    chat_id = str(chat["id"])

    _user(chat_id, "A message that must not name it")

    assert (await _refreshed(client, chat_id))["chat"]["title"] == "Chosen up front"


async def test_a_blank_rename_is_refused(client: httpx.AsyncClient) -> None:
    chat = await _create(client)

    response = await client.patch(f"/api/chats/{chat['id']}", json={"title": "   "})

    assert response.status_code == 400
    assert "title" in response.json()["detail"]


# -------------------------------------------------------------------------------------
# The workspace filter
# --------------------------------------------------------------------------------------


async def test_the_workspace_filter_selects_one_workspace_and_all_ignores_it(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    one = await _create(client, workspace=str(first))
    two = await _create(client, workspace=str(second))

    filtered = await _listed(client, workspace=str(first))
    everything = await _listed(client, workspace=str(first), all="true")

    assert [chat["id"] for chat in filtered] == [one["id"]]
    assert {chat["id"] for chat in everything} == {one["id"], two["id"]}


async def test_the_newest_activity_comes_first(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A clock the test owns, because two chats created in the same second are otherwise a tie."""
    ticks = {"now": 1000}
    # By module object: ``orbital_backend.services`` re-exports the store under the name
    # ``sessions``, so that dotted path is the instance, not the module the function lives in.
    store_module = importlib.import_module("orbital_backend.services.sessions")
    monkeypatch.setattr(store_module, "_now", lambda: ticks["now"])
    quiet = await _create(client)
    busy = await _create(client)
    ticks["now"] = 2000

    _user(str(busy["id"]), "Something just happened")

    assert [chat["id"] for chat in await _listed(client)] == [busy["id"], quiet["id"]]


# -------------------------------------------------------------------------------------
# Clearing
# --------------------------------------------------------------------------------------


async def test_clear_empties_the_transcript_and_keeps_the_chat(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    chat = await _create(client, workspace=str(sample_project))
    chat_id = str(chat["id"])
    await client.patch(
        f"/api/chats/{chat_id}",
        json={"title": "Kept", "providerId": "profile-1", "model": "some-model"},
    )
    _exchange(chat_id, "hi", "hello")
    sessions.accumulate_usage(chat_id, UsageSnapshot(model_calls=3, prompt_chars=120))

    cleared = await client.post(f"/api/chats/{chat_id}/clear")

    assert cleared.status_code == 200, cleared.text
    body = cleared.json()
    assert body["state"]["messages"] == []
    assert body["state"]["usage"]["modelCalls"] == 0
    assert body["state"]["usage"]["promptChars"] == 0
    assert body["chat"]["title"] == "Kept"
    assert body["chat"]["providerId"] == "profile-1"
    assert body["chat"]["messageCount"] == 0
    # The file agrees, so a restart cannot resurrect the exchange the user just cleared.
    stored = json.loads((chats_dir() / f"{chat_id}.json").read_text(encoding="utf-8"))
    assert stored["state"]["messages"] == []
    assert (await _listed(client))[0]["title"] == "Kept"


# -------------------------------------------------------------------------------------
# The store on disk
# --------------------------------------------------------------------------------------


async def test_a_completed_exchange_survives_a_restart(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    """The point of the whole store: a restart keeps the conversation the user was having."""
    chat = await _create(client, workspace=str(sample_project))
    chat_id = str(chat["id"])
    _exchange(chat_id, "What does the parser do?", "It turns text into a tree.")

    restarted = SessionStore()

    state = restarted.get(chat_id)
    assert [message.content for message in state.messages] == [
        "What does the parser do?",
        "It turns text into a tree.",
    ]
    assert state.messages[1].streaming is False
    assert state.project_path == str(sample_project)
    stored = restarted.chat(chat_id)
    assert stored is not None
    assert (stored.title, stored.message_count, stored.workspace) == (
        "What does the parser do?",
        2,
        str(sample_project),
    )
    # And it is listed, so the sidebar of the new process offers it.
    assert [item.id for item in restarted.chats()] == [chat_id]


async def test_shutdown_writes_the_session_that_was_only_in_memory(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    """A run can be mid-flight when the process stops; the store is what catches it.

    Usage is counted per model call and written at the *next* boundary rather than on every
    counter, so it is exactly the state a shutdown has to rescue.
    """
    chat = await _create(client, workspace=str(sample_project))
    chat_id = str(chat["id"])
    _user(chat_id, "Recorded before the process stops")
    sessions.accumulate_usage(chat_id, UsageSnapshot(tool_calls=2, model_calls=1))

    assert SessionStore().get(chat_id).usage.tool_calls == 0, "no boundary has been crossed yet"

    sessions.persist_all()

    restarted = SessionStore()
    assert [message.content for message in restarted.get(chat_id).messages] == [
        "Recorded before the process stops"
    ]
    assert restarted.get(chat_id).usage.tool_calls == 2
    assert restarted.get(chat_id).usage.model_calls == 1


async def test_the_store_is_readable_by_the_owner_alone(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    """A transcript holds the user's code, so it sets its own permissions like the key store."""
    chat = await _create(client, workspace=str(sample_project))
    _exchange(str(chat["id"]), "Write something private", "ok")
    index = chats_dir() / INDEX_FILE
    transcript = chats_dir() / f"{chat['id']}.json"

    assert index.exists() and transcript.exists()
    if sys.platform == "win32":
        for path in (index, transcript):
            listing = subprocess.run(
                ["icacls", str(path)], capture_output=True, text=True, check=True
            ).stdout
            assert os.environ["USERNAME"] in listing
            assert "(I)" not in listing, "an inherited entry is a permission this file did not set"
            for other in ("BUILTIN\\Users", "Everyone", "Authenticated Users"):
                assert other not in listing
    else:
        for path in (index, transcript):
            assert path.stat().st_mode & 0o777 == 0o600


async def test_the_store_keeps_one_index_and_one_transcript_per_chat(
    client: httpx.AsyncClient, sample_project: Path
) -> None:
    """The layout is the store's own shape, not the wire's: it is files the user can read."""
    chat = await _create(client, workspace=str(sample_project))
    _exchange(str(chat["id"]), "Layout check", "ok")

    assert chats_dir().name == CHATS_DIR
    index = json.loads((chats_dir() / INDEX_FILE).read_text(encoding="utf-8"))
    entry = index["chats"][0]
    assert entry["id"] == chat["id"]
    assert entry["title"] == "Layout check"
    assert "created_at" in entry and "createdAt" not in entry
    transcript = json.loads((chats_dir() / f"{chat['id']}.json").read_text(encoding="utf-8"))
    assert transcript["state"]["session_id"] == chat["id"]
    assert len(transcript["state"]["messages"]) == 2
