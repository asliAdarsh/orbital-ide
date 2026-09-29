"""Chat endpoints: the conversations the sidebar lists, and the state behind each one.

The chat id *is* the runtime session id, so these routes and the socket address the same
conversation. ``GET /api/chats/{id}`` is what the composer refreshes a chat with — the chat as the
sidebar lists it, and the session state a run is updating — and an id nothing has seen before
becomes a new chat rather than a 404, because the socket accepts any id a client picks.
"""

from __future__ import annotations

from fastapi import APIRouter

from orbital_backend.models import (
    ChatResponse,
    ChatsResponse,
    ChatStateResponse,
    CreateChatRequest,
    UpdateChatRequest,
)
from orbital_backend.services.sessions import sessions, wire_state

router = APIRouter(prefix="/api", tags=["chats"])


@router.get("/chats")
async def list_chats(workspace: str | None = None, all: bool = False) -> ChatsResponse:
    """Every chat, newest activity first. ``workspace`` filters; ``all=true`` answers for all."""
    return ChatsResponse(chats=sessions.chats(workspace, all_workspaces=all))


@router.post("/chats")
async def create_chat(body: CreateChatRequest) -> ChatResponse:
    """Start a chat. A title sent here is a name the user chose, and no message will replace it."""
    chat = sessions.create_chat(
        title=body.title,
        workspace_path=body.workspace,
        phase=body.phase,
    )
    return ChatResponse(chat=chat)


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str) -> ChatStateResponse:
    """One chat and the live state behind it, creating the chat when the id is new."""
    chat = sessions.ensure_chat(chat_id)
    return ChatStateResponse(chat=chat, state=wire_state(chat_id))


@router.patch("/chats/{chat_id}")
async def update_chat(chat_id: str, body: UpdateChatRequest) -> ChatResponse:
    """Rename a chat, move its phase, or pin it to a provider and model."""
    return ChatResponse(
        chat=sessions.update_chat(
            chat_id,
            title=body.title,
            phase=body.phase,
            provider_id=body.provider_id,
            model=body.model,
        )
    )


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str) -> ChatsResponse:
    """Forget a chat and its transcript, and answer with what remains."""
    return ChatsResponse(chats=sessions.delete_chat(chat_id))


@router.post("/chats/{chat_id}/clear")
async def clear_chat(chat_id: str) -> ChatStateResponse:
    """Empty a chat's transcript and usage, keeping the chat, its title and its pin."""
    chat, _state = sessions.clear_chat(chat_id)
    return ChatStateResponse(chat=chat, state=wire_state(chat_id))
