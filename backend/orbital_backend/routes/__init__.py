"""HTTP and WebSocket routers composing the Orbital backend surface."""

from fastapi import APIRouter

from orbital_backend.routes import agents, git, project, projects, system, terminal

all_routers: list[APIRouter] = [
    system.router,
    project.router,
    projects.router,
    git.router,
    terminal.router,
    agents.router,
]

__all__ = ["all_routers"]
