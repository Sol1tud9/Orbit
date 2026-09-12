from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from orbita.api import create_app
from orbita.engine import CalculationCancelled, simulate
from orbita.jobs import perform_run
from orbita.optimization import (
    SearchOptions,
    dominates,
    objectives,
    optimize,
    search_plan,
)
from orbita.scenario import canonical_hash, validate_scenario
from orbita.storage import Store


def test_seeded_search_is_unique_reproducible_and_preserves_contract(tiny):
    tiny["design"]["launch_stage"] = 1
    tiny["design"]["satellites"][1].update(plane_id="P2", launch_batch=2)
    tiny["failures"] = [
        {
            "satellite_id": tiny["design"]["satellites"][0]["id"],
            "start_s": 61,
            "end_s": 181,
        }
    ]
    tiny["extension"] = {"keep": True}
    original = deepcopy(tiny)
    settings = {"budget": 4, "seed": 17}
    plan = search_plan(tiny, settings)
    assert plan == search_plan(tiny, settings)
    assert (
        plan["candidates"] != search_plan(tiny, {**settings, "seed": 91})["candidates"]
    )
    assert tiny == original
    assert len(plan["candidates"]) == 4
    assert not plan["exhaustive"]
    hashes = []
    for case in plan["candidates"]:
        s = case["scenario"]
        validate_scenario(s)
        assert s["extension"] == tiny["extension"]
        assert s["failures"] == tiny["failures"]
        assert s["ground_sites"] == tiny["ground_sites"]
        assert s["design"]["satellites"] == tiny["design"]["satellites"]
        assert s["environment"]["step_s"] == tiny["environment"]["step_s"]
        assert s["design"]["planes"][0] == tiny["design"]["planes"][0]
        s = deepcopy(s)
        s["meta"] = tiny["meta"]
        hashes.append(canonical_hash(s))
    assert len(set(hashes)) == len(hashes)
    assert canonical_hash(tiny) not in hashes


def test_space_exhaustion_and_empty_search(tiny):
    plan = search_plan(tiny, {"budget": 24, "phase_shift_deg": 0})
    assert plan["exhaustive"]
    assert plan["space_size"] == "3"
    assert len(plan["candidates"]) == 2
    tiny["environment"]["isl_range_km"] = 10000
    plan = search_plan(tiny, {"phase_shift_deg": 0})
    assert plan["candidates"] == []
    assert plan["space_size"] == "1"
    with pytest.raises(ValueError):
        search_plan(tiny, {"max_isl_range_km": 9999})


@pytest.mark.parametrize(
    "invalid",
    [
        {"seed": True},
        {"budget": 25},
        {"budget": 0},
        {"seed": -1},
        {"phase_shift_deg": float("nan")},
        {"phase_shift_deg": 46},
        {"max_isl_range_km": 10001},
        {"include_next_stages": "yes"},
        {"unknown": 1},
    ],
)
def test_search_options_are_strict(invalid):
    with pytest.raises(ValidationError):
        SearchOptions.model_validate(invalid)


def test_pareto_requires_a_strict_gain_and_preserves_tradeoffs():
    base = {
        "worst_reachable_samples": 8,
        "worst_outage_s": 240,
        "deployed_satellites": 2,
        "isl_range_km": 2000,
    }
    assert not dominates(base, base)
    assert dominates({**base, "worst_reachable_samples": 9}, base)
    assert not dominates(
        {**base, "worst_reachable_samples": 9, "deployed_satellites": 3}, base
    )
    assert not dominates({**base, "worst_outage_s": 360}, base)
    assert dominates({**base, "isl_range_km": 1500}, base)


def test_full_evidence_frontier_and_cancellation(tiny):
    tiny["design"]["satellites"][1]["plane_id"] = "P2"
    baseline = simulate(tiny)
    progress = []
    report = optimize(
        tiny,
        baseline,
        {"budget": 4},
        progress=lambda done, total: progress.append((done, total)),
    )
    assert progress[-1] == (12, 12)
    assert report["summary"]["case_count"] == 4
    for candidate in report["cases"]:
        actual = simulate(candidate["scenario"])
        assert candidate["summary"] == actual["summary"]
        assert candidate["objectives"] == objectives(
            candidate["scenario"], actual["summary"]
        )
        vectors = []
        for other in report["cases"]:
            o = other["objectives"]
            vectors.append(
                (
                    o["worst_reachable_samples"],
                    -o["worst_outage_s"],
                    -o["deployed_satellites"],
                    -o["isl_range_km"],
                )
            )
        own = vectors[report["cases"].index(candidate)]
        expected = not any(
            all(a >= b for a, b in zip(v, own)) and v != own for v in vectors
        )
        assert candidate["pareto"] == expected
        rows = candidate["comparison"]["clients"]
        assert candidate["supported_improvement"] == (
            all(c["lost_samples"] == 0 for c in rows)
            and any(c["gained_samples"] > 0 for c in rows)
        )
    with pytest.raises(CalculationCancelled):
        optimize(tiny, baseline, cancelled=lambda: True)
    altered = deepcopy(tiny)
    altered["environment"]["isl_range_km"] += 1
    with pytest.raises(ValueError, match="Базовый"):
        optimize(altered, baseline)


class ImmediateJobs:
    def __init__(self, store, workers):
        self.store = store

    def submit(self, run_id, scenario, *args):
        perform_run(str(self.store.directory), run_id, scenario, *args)

    def close(self):
        pass


def test_search_api_persistence_export_and_isolation(tmp_path, tiny):
    with TestClient(create_app(tmp_path, job_manager_factory=ImmediateJobs)) as client:
        baseline = client.post("/api/runs", json=tiny).json()
        payload = {
            "run_id": baseline["id"],
            "kind": "optimization",
            "options": {"budget": 2, "seed": 77},
        }
        response = client.post("/api/experiments", json=payload)
        assert response.status_code == 202
        search_id = response.json()["id"]
        job = client.get(f"/api/runs/{search_id}").json()
        assert job["status"] == "completed"
        assert job["options"]["seed"] == 77
        report = client.get(f"/api/experiments/{search_id}/report").json()
        assert report["search"]["options"] == job["options"]
        assert len(report["cases"]) == 3
        assert client.get(f"/api/runs/{search_id}/export").status_code == 409
        assert len(client.get("/api/runs").json()) == 1
        assert client.get("/api/experiments").json()[0]["kind"] == "optimization"
        cookies = dict(client.cookies)
        client.cookies.clear()
        assert client.get(f"/api/experiments/{search_id}/report").status_code == 404
        assert client.post("/api/experiments", json=payload).status_code == 404
    with TestClient(create_app(tmp_path, job_manager_factory=ImmediateJobs)) as client:
        client.cookies.update(cookies)
        assert client.get(f"/api/experiments/{search_id}/report").json() == report


def test_search_budget_rejected_before_enqueuing(tmp_path, tiny, monkeypatch):
    with TestClient(create_app(tmp_path, job_manager_factory=ImmediateJobs)) as client:
        baseline = client.post("/api/runs", json=tiny).json()
        payload = {"run_id": baseline["id"], "kind": "optimization"}
        assert (
            client.post(
                "/api/experiments", json={**payload, "options": {"budget": 25}}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/experiments", json={**payload, "options": {"max_isl_range_km": 1}}
            ).status_code
            == 422
        )
        monkeypatch.setenv("ORBITA_MAX_EXPERIMENT_WORK", "1")
        assert client.post("/api/experiments", json=payload).status_code == 422
        assert client.get("/api/experiments").json() == []


def test_existing_database_migrates_without_data_loss(tmp_path, tiny):
    store = Store(tmp_path)
    old = store.create("owner", tiny)
    with store.connect() as db:
        db.execute("ALTER TABLE runs DROP COLUMN options")
        db.execute("PRAGMA user_version=2")
    migrated = Store(tmp_path)
    assert migrated.get(old["id"], "owner")["options"] is None
    assert migrated.get(old["id"], "owner")["effective_scenario"] == tiny
    with migrated.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
