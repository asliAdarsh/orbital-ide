# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller one-file spec for the Orbital backend sidecar.

Build it through ``backend/build_sidecar.py``: that script generates the frozen entry script,
runs PyInstaller from the repository virtualenv and installs the artefact where
``bundle.externalBin`` in ``tauri.conf.json`` expects it
(``src-tauri/binaries/orbital-backend-<target-triple>[.exe]``).

``console=True`` is deliberate. The Rust host reads the readiness line
``ORBITAL_BACKEND_READY port=<n>`` from the sidecar's stdout, so the process must own a console
handle and unbuffered stdout. Tauri's shell plugin spawns every child with CREATE_NO_WINDOW on
Windows, so a release build does not flash a console; if the binary is ever launched outside
Tauri, use CREATE_NO_WINDOW (or a detached console) rather than switching this flag off.
"""

import importlib.util
import os

from PyInstaller.utils.hooks import collect_all

BACKEND_DIR = os.path.abspath(SPECPATH)
ENTRY = os.path.join(BACKEND_DIR, "build", "orbital_sidecar_entry.py")

if not os.path.isfile(ENTRY):
    raise SystemExit(
        f"missing entry script {ENTRY}\n"
        "run `python backend/build_sidecar.py`, which generates it, instead of invoking "
        "PyInstaller against this spec directly"
    )

datas = []
binaries = []
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.lifespan.on",
    "uvicorn.protocols.websockets.auto",
    "langgraph",
    "langchain_core",
    "langchain_openai",
    "watchfiles",
    "anyio",
]

# PyInstaller's bundled hooks miss parts of the LangChain/LangGraph namespace packages: the
# dynamically registered providers and the data files they ship. Pull those in wholesale.
for package in ("langchain", "langchain_core", "langchain_openai", "langgraph"):
    if importlib.util.find_spec(package) is None:
        print(f"[orbital] WARNING: {package} is not importable here; bundling without it")
        continue
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

a = Analysis(
    [ENTRY],
    pathex=[BACKEND_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

# One-file layout: EXE receives the binaries and data directly, with no COLLECT step.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="orbital-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
)
