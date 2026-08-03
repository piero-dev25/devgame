"""
Makes `unreal/tests` a package so `python3 -m unittest discover` (run from
`unreal/`) imports this `__init__.py` first, which is what lets every test
module below do a plain `from epp import ...` without needing `epp` to be
pip-installed or the plugin to be inside an Unreal project.

The `epp` package lives at `EditorPresence/Content/Python/epp` — deep
inside the plugin's own drop-in folder structure — so it is not importable
by its ordinary location; this inserts that directory onto `sys.path` once,
before any test module runs.
"""

import os
import sys

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_CONTENT_PYTHON_DIR = os.path.join(_TESTS_DIR, "..", "EditorPresence", "Content", "Python")
_CONTENT_PYTHON_DIR = os.path.normpath(_CONTENT_PYTHON_DIR)

if _CONTENT_PYTHON_DIR not in sys.path:
    sys.path.insert(0, _CONTENT_PYTHON_DIR)
