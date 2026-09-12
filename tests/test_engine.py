from copy import deepcopy
import json
from pathlib import Path

import pytest

from orbita.engine import (
    CalculationCancelled,
    analyze_snapshot,
    export_result,
    simulate,
)
from orbita.geometry_adapter import geometry_hash, snapshot
from orbita.scenario import load_scenario
from test_routing import floyd_hops

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "01_full_constellation": [(704, 696, 480), (719, 711, 120), (720, 712, 120)],
    "02_first_launch": [(275, 196, 34320), (351, 114, 39480), (421, 91, 47760)],
    "03_satellite_outages": [(609, 571, 1440), (650, 582, 1440), (670, 594, 1200)],
    "04_link_range": [(704, 558, 5640), (719, 448, 10680), (720, 469, 240)],
}


@pytest.mark.parametrize("name", EXPECTED)
def test_entire_official_scenario(name):
    scenario = load_scenario(ROOT / "Данные" / f"{name}.json")
    result = simulate(scenario)
    assert result["summary"]["sample_count"] == 720
    gateways = [g["id"] for g in scenario["ground_sites"] if g["role"] == "gateway"]
    for client, expected in zip(["C65", "C70", "C72"], EXPECTED[name]):
        m = result["summary"]["clients"][client]
        assert (
            m["visible_samples"],
            m["reachable_samples"],
            m["max_outage_s"],
        ) == expected
        assert m["availability"] <= m["coverage"]
        assert sum(x["duration_s"] for x in m["outages"]) == m["total_outage_s"]
    for i, t in enumerate(range(0, 86400, 120)):
        snap = snapshot(scenario, t)
        idx, distance = floyd_hops(scenario, snap)
        edges = {frozenset([a, b]) for a, b, _ in snap["edges"]}
        active = {x["id"] for x in snap["satellites"] if x["active"]}
        for client, series in result["series"].items():
            row = series[i]
            expected = min(int(distance[idx[client], idx[g]]) for g in gateways)
            assert (row["hop_count"] if row["path"] else 100000) == expected
            if row["path"]:
                assert row["path"][0] == client and row["path"][-1] in gateways
                assert set(row["path"][1:-1]) <= active
                assert len(row["path"]) == len(set(row["path"]))
                assert all(
                    frozenset([a, b]) in edges
                    for a, b in zip(row["path"], row["path"][1:])
                )
    exported = export_result(result)
    assert exported["schema_version"] == "cosmo-A-result-1.0"
    assert len(exported["routes"]) == 2160
    assert len({(r["t_s"], r["client_id"]) for r in exported["routes"]}) == 2160
    assert max(r["t_s"] for r in exported["routes"]) == 86280
    assert exported["effective_scenario"] == scenario
    json.dumps(exported, allow_nan=False)


def test_organizer_is_unchanged():
    assert (
        geometry_hash()
        == "2f7dc14f7e826c2815bbbb2ecbd67ef26e81f092b15c06e197b31dd3ff66daf6"
    )


def test_multiple_gateways_and_overlap(tiny):
    tiny["gateway_outages"] = [{"gateway_id": "exit-a", "start_s": 0, "end_s": 360}]
    assert all(r["path"][-1] == "exit-b" for r in simulate(tiny)["series"]["customer"])
    tiny["gateway_outages"].append({"gateway_id": "exit-b", "start_s": 0, "end_s": 360})
    r = simulate(tiny)
    assert r["summary"]["clients"]["customer"]["max_outage_s"] == 360
    assert r["summary"]["clients"]["customer"]["coverage"] == 1
    assert all(
        row["reason"] == "all_gateways_offline" for row in r["series"]["customer"]
    )


def test_off_grid_failure_and_union(tiny):
    tiny["failures"] = [
        {"satellite_id": s["id"], "start_s": 61, "end_s": 181}
        for s in tiny["design"]["satellites"]
    ]
    result = simulate(tiny)
    assert [bool(r["path"]) for r in result["series"]["customer"]] == [
        True,
        False,
        True,
    ]
    tiny["failures"] += deepcopy(tiny["failures"])
    assert simulate(tiny)["summary"] == result["summary"]


def test_cancellation_and_input_immutability(tiny):
    original = deepcopy(tiny)
    progress = []
    with pytest.raises(CalculationCancelled):
        simulate(
            tiny,
            progress=lambda done, total: progress.append(done),
            cancelled=lambda: bool(progress),
        )
    assert tiny == original


def test_snapshot_facts_do_not_confuse_elevation_with_gateway_online(tiny):
    tiny["gateway_outages"] = [{"gateway_id": "exit-a", "start_s": 0, "end_s": 360}]
    snap = snapshot(tiny, 0)
    assert snap["elevation_deg"]["exit-a"]["S01"] == pytest.approx(90)
    rows, network = analyze_snapshot(tiny, snap)
    assert "exit-a" not in network["online_gateways"]
    assert rows["customer"]["gateway_id"] == "exit-b"
