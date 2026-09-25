"""Orbital agent backend — FastAPI + LangGraph pipeline behind the Orbital IDE.

Import ``orbital_backend.main.create_app`` to build the ASGI application, or run
``python -m orbital_backend`` to serve it. Kept deliberately free of side effects so
tools, tests and the sidecar launcher can import the package cheaply.
"""

from orbital_backend.models import BACKEND_VERSION as __version__

__all__ = ["__version__"]
