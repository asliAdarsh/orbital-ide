"""HTTP and WebSocket routers composing the Orbital backend surface."""

from fastapi import APIRouter

from orbital_backend.routes import (
    agents,
    chats,
    git,
    project,
    projects,
    providers,
    skills,
    system,
    terminal,
)

all_routers: list[APIRouter] = [
    system.router,
    project.router,
    projects.router,
    providers.router,
    git.router,
    terminal.router,
    chats.router,
    skills.router,
    agents.router,
]

__all__ = ["all_routers"]
