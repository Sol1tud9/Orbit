"""Explicit deployment smoke check; run manually, not collected by pytest."""

import argparse
import json
from pathlib import Path
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:18000")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    state_path = ROOT / "var" / "deployment-check.json"
    golden = json.loads(
        (ROOT / "tests/fixtures/control-results.json").read_text("utf-8")
    )
    with httpx.Client(base_url=args.url, timeout=30) as client:
        if args.resume:
            state = json.loads(state_path.read_text("utf-8"))
            client.cookies.update(state["cookies"])
            for run_id in state["run_ids"]:
                response = client.get(f"/api/runs/{run_id}/export")
                response.raise_for_status()
                assert response.json()["schema_version"] == "cosmo-A-result-1.0"
            print(
                f"Persistence verified: {len(state['run_ids'])} completed runs after restart"
            )
            return
        health = client.get("/api/health")
        health.raise_for_status()
        assert health.json()["geometry_sha256"] == golden["geometry_sha256"]
        assert "<html" in client.get("/").text
        catalog = client.get("/api/catalog").json()
        run_ids, measurements = [], []
        inputs = [(item["file"], item["scenario"]) for item in catalog]
        inputs.append(
            (
                "jury-example.json",
                json.loads(
                    (ROOT / "tests/fixtures/jury-example.json").read_text("utf-8")
                ),
            )
        )
        for filename, scenario in inputs:
            started = time.monotonic()
            response = client.post("/api/runs", json=scenario)
            response.raise_for_status()
            run_id = response.json()["id"]
            run_ids.append(run_id)
            while True:
                status = client.get(f"/api/runs/{run_id}").json()
                if status["status"] == "completed":
                    break
                assert status["status"] in ("queued", "running"), status
                assert time.monotonic() - started < 90
                time.sleep(0.2)
            exported = client.get(f"/api/runs/{run_id}/export").json()
            assert exported["effective_scenario"] == scenario
            assert exported["schema_version"] == "cosmo-A-result-1.0"
            clients = [
                g["id"] for g in scenario["ground_sites"] if g["role"] == "client"
            ]
            samples = (
                scenario["environment"]["horizon_s"]
                // scenario["environment"]["step_s"]
            )
            assert len(exported["routes"]) == len(clients) * samples
            if filename == "jury-example.json":
                assert (
                    exported["summary"]["clients"]["Терминал-А"]["reachable_samples"]
                    == 2
                )
                snap = client.get(f"/api/runs/{run_id}/snapshot/1").json()
                assert snap["clients"]["Терминал-А"]["reason"] == "all_gateways_offline"
            else:
                for key, expected in golden["scenarios"][Path(filename).stem][
                    "clients"
                ].items():
                    actual = exported["summary"]["clients"][key]
                    assert all(actual[k] == v for k, v in expected.items()), (
                        filename,
                        key,
                        actual,
                    )
            assert httpx.get(args.url + f"/api/runs/{run_id}").status_code == 404
            elapsed = round(time.monotonic() - started, 3)
            measurements.append(
                {
                    "scenario": filename,
                    "wall_s": elapsed,
                    "engine_s": exported["provenance"]["elapsed_s"],
                }
            )
            print(f"{filename}: OK ({elapsed}s)", flush=True)
        state_path.parent.mkdir(exist_ok=True)
        state_path.write_text(
            json.dumps({"cookies": dict(client.cookies), "run_ids": run_ids}), "utf-8"
        )
        (ROOT / "docs/deployment-measurements.json").write_text(
            json.dumps(
                {
                    "environment": "Local Docker Desktop, Python 3.12, 2 calculation workers; sequential smoke check",
                    "runs": measurements,
                },
                indent=2,
            ),
            "utf-8",
        )
        print(
            "Static app, all baselines, new input, export and session isolation verified"
        )


if __name__ == "__main__":
    main()
