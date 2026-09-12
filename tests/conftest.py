from copy import deepcopy
from pathlib import Path

import pytest

from orbita.scenario import load_scenario

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def scenario():
    return load_scenario(ROOT / "Данные" / "01_full_constellation.json")


@pytest.fixture
def tiny(scenario):
    s = deepcopy(scenario)
    s["environment"].update(
        horizon_s=360, step_s=120, earth_angle0_deg=0, min_elevation_deg=0
    )
    s["design"]["satellites"] = s["design"]["satellites"][:2]
    s["design"]["satellites"][1]["slot_deg"] = 0
    s["ground_sites"] = [
        {
            "id": "customer",
            "name": "Customer",
            "role": "client",
            "lat_deg": 0,
            "lon_deg": 0,
        },
        {"id": "exit-a", "name": "A", "role": "gateway", "lat_deg": 0, "lon_deg": 0},
        {"id": "exit-b", "name": "B", "role": "gateway", "lat_deg": 0, "lon_deg": 0},
    ]
    return s
