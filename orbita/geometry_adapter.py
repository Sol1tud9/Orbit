"""Load the organizer's original file without copying or modifying its model."""

from functools import lru_cache
import hashlib
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEOMETRY_PATH = ROOT / "Расчетный модуль" / "geometry.py"


@lru_cache(maxsize=1)
def reference():
    spec = importlib.util.spec_from_file_location(
        "cosmo_organizer_geometry", GEOMETRY_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def geometry_hash() -> str:
    return hashlib.sha256(GEOMETRY_PATH.read_bytes()).hexdigest()


def snapshot(scenario: dict, t_s: int) -> dict:
    return reference().snapshot(scenario, t_s)
