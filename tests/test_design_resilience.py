from copy import deepcopy
import time

import pytest
from fastapi.testclient import TestClient

from orbita.api import create_app
from orbita import __version__
from orbita.comparison import compare_results, scenario_diff
from orbita.engine import CalculationCancelled, simulate
from orbita.resilience import n_minus_one, recommendations, snapshot_diagnostics


def test_diff_matches_entities_not_array_order(tiny):
    b = deepcopy(tiny)
    b["design"]["satellites"].reverse()
    assert scenario_diff(tiny, b) == []
    b["design"]["satellites"][0]["slot_deg"] += 10
    diff = scenario_diff(tiny, b)
    assert len(diff) == 1
    assert diff[0]["path"].endswith(".slot_deg")


def test_comparison_counts_recovered_samples(tiny):
    baseline = simulate(tiny)
    b = deepcopy(tiny)
    b["gateway_outages"] = [
        {"gateway_id": g["id"], "start_s": 61, "end_s": 181}
        for g in b["ground_sites"]
        if g["role"] == "gateway"
    ]
    outage = simulate(b)
    comparison = compare_results(baseline, outage)
    assert comparison["compatible"]
    row = comparison["clients"][0]
    assert row["lost_samples"] == 1
    assert row["gained_samples"] == 0
    assert row["transitions"] == ["unchanged", "lost", "unchanged"]
    reverse = compare_results(outage, baseline)["clients"][0]
    assert reverse["availability_delta"] == pytest.approx(1 / 3)


@pytest.mark.parametrize("change", ["step", "client_position", "client_id"])
def test_incompatible_results_are_not_interpolated(tiny, change):
    a = simulate(tiny)
    b = deepcopy(tiny)
    if change == "step":
        b["environment"]["step_s"] = 60
    else:
        client = next(g for g in b["ground_sites"] if g["role"] == "client")
        client["lat_deg" if change == "client_position" else "id"] = (
            1 if change == "client_position" else "different"
        )
    comparison = compare_results(a, simulate(b))
    assert not comparison["compatible"]
    assert comparison["clients"] == []


def test_n_minus_one_matches_full_geometry_recalculation(tiny):
    tiny["design"]["satellites"][1]["slot_deg"] = 8
    tiny["failures"] = [
        {
            "satellite_id": tiny["design"]["satellites"][0]["id"],
            "start_s": 61,
            "end_s": 181,
        }
    ]
    baseline = simulate(tiny)
    report = n_minus_one(tiny, baseline)
    assert report["provenance"]["engine_version"] == __version__
    assert report["summary"]["case_count"] == 2
    for case in report["cases"]:
        variant = deepcopy(tiny)
        variant["failures"].append(
            {"satellite_id": case["satellite_id"], "start_s": 0, "end_s": 360}
        )
        expected = simulate(variant)
        for client, metric in case["clients"].items():
            for key in (
                "availability",
                "coverage",
                "max_outage_s",
                "outages",
                "hop_mean",
                "distance_mean_km",
            ):
                assert metric[key] == expected["summary"]["clients"][client][key]
            assert case["lost_samples"][client] >= 0


def test_n_minus_one_excludes_unlaunched_and_cancels(tiny):
    tiny["design"]["launch_stage"] = 1
    tiny["design"]["satellites"][1]["launch_batch"] = 2
    baseline = simulate(tiny)
    assert n_minus_one(tiny, baseline)["summary"]["case_count"] == 1
    with pytest.raises(CalculationCancelled):
        n_minus_one(tiny, baseline, cancelled=lambda: True)


def test_alternative_and_counterfactual(tiny):
    result = snapshot_diagnostics(tiny, 0, "customer")
    assert result["alternative"]["path"] != result["primary"]["path"]
    assert result["alternative"]["hop_count"] == 2
    assert not any(row["disconnected"] for row in result["route_satellites"])
    tiny["failures"] = [
        {"satellite_id": s["id"], "start_s": 0, "end_s": 360}
        for s in tiny["design"]["satellites"]
    ]
    repaired = snapshot_diagnostics(tiny, 120, "customer")
    assert repaired["outage_removal_restores_path"]
    assert repaired["primary"]["path"] == []


def test_recommendation_claims_have_full_run_evidence(tiny):
    tiny["failures"] = [
        {"satellite_id": s["id"], "start_s": 0, "end_s": 360}
        for s in tiny["design"]["satellites"]
    ]
    original = deepcopy(tiny)
    result = recommendations(tiny, simulate(tiny))
    assert tiny == original
    assert result["summary"]["improvement_count"] >= 1
    for candidate in result["cases"]:
        expected = simulate(candidate["scenario"])
        assert candidate["summary"] == expected["summary"]
        if candidate["supported_improvement"]:
            assert candidate["gained_samples"] > 0
            assert all(
                c["lost_samples"] == 0 for c in candidate["comparison"]["clients"]
            )
    with pytest.raises(CalculationCancelled):
        recommendations(tiny, simulate(tiny), cancelled=lambda: True)


def wait_run(client, run_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] == "completed":
            return run
        assert run["status"] in ("queued", "running")
        time.sleep(0.04)
    pytest.fail("Job did not complete")


def test_revisions_experiments_and_ownership(tmp_path, tiny):
    unusual_id = "Клиент/север?A"
    next(g for g in tiny["ground_sites"] if g["role"] == "client")["id"] = unusual_id
    with TestClient(create_app(tmp_path, workers=1)) as client:
        first = client.post("/api/revisions", json=tiny)
        assert first.status_code == 201
        revision_id = first.json()["id"]
        tiny["environment"]["isl_range_km"] = 2000
        second = client.post(
            "/api/revisions",
            json=tiny,
            headers={"X-Orbita-Parent-Revision": revision_id},
        ).json()
        assert second["parent_id"] == revision_id
        run = client.post(
            "/api/runs", json=tiny, headers={"X-Orbita-Parent-Revision": second["id"]}
        ).json()
        wait_run(client, run["id"])
        assert (
            client.get(
                f"/api/runs/{run['id']}/diagnostics/0", params={"client": unusual_id}
            ).status_code
            == 200
        )
        exp = client.post(
            "/api/experiments", json={"run_id": run["id"], "kind": "n_minus_one"}
        ).json()
        wait_run(client, exp["id"])
        report = client.get(f"/api/experiments/{exp['id']}/report")
        assert report.status_code == 200
        assert report.json()["baseline_run_id"] == run["id"]
        assert client.get(f"/api/runs/{exp['id']}/export").status_code == 409
        assert len(client.get("/api/runs").json()) == 1
        assert len(client.get("/api/experiments").json()) == 1
        assert client.get(f"/api/compare?a={run['id']}&b={run['id']}").json()[
            "compatible"
        ]
        cookie = dict(client.cookies)
        client.cookies.clear()
        assert client.get(f"/api/revisions/{revision_id}").status_code == 404
        assert client.get(f"/api/experiments/{exp['id']}/report").status_code == 404
        assert (
            client.post(
                "/api/revisions",
                json=tiny,
                headers={"X-Orbita-Parent-Revision": revision_id},
            ).status_code
            == 404
        )
        client.cookies.update(cookie)
    with TestClient(create_app(tmp_path, workers=1)) as client:
        client.cookies.update(cookie)
        assert client.get(f"/api/experiments/{exp['id']}/report").status_code == 200
