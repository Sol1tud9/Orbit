import argparse
import json
from pathlib import Path
import time
import tomllib

import httpx


ROOT = Path(__file__).resolve().parents[1]
VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text("utf-8"))["project"][
    "version"
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:18000")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    state = json.loads((ROOT / "var/deployment-check.json").read_text("utf-8"))
    checkpoint = ROOT / "var/stage6-check.json"
    with httpx.Client(base_url=args.url, timeout=30) as client:
        client.cookies.update(state["cookies"])
        assert client.get("/api/health").json()["version"] == VERSION
        if args.resume:
            saved = json.loads(checkpoint.read_text("utf-8"))
            report = client.get(f"/api/experiments/{saved['id']}/report")
            report.raise_for_status()
            assert report.json()["search"]["options"]["seed"] == 2026
            assert (
                client.get(f"/api/revisions/{saved['revision_id']}").status_code == 200
            )
            print("Search report, seed and candidate revision survived restart")
            return
        started = time.monotonic()
        baseline_id = state["run_ids"][1]
        payload = {
            "run_id": baseline_id,
            "kind": "optimization",
            "options": {"budget": 6, "seed": 2026},
        }
        response = client.post("/api/experiments", json=payload)
        response.raise_for_status()
        search_id = response.json()["id"]
        while True:
            run = client.get(f"/api/runs/{search_id}").json()
            if run["status"] == "completed":
                break
            assert run["status"] in ("queued", "running"), run["status"]
            assert time.monotonic() - started < 180
            time.sleep(0.3)
        report = client.get(f"/api/experiments/{search_id}/report").json()
        assert report["summary"]["case_count"] == 6
        assert report["summary"]["sample_count"] == 720
        assert report["summary"]["improvement_count"] > 0
        for case in report["cases"]:
            assert len(case["comparison"]["clients"]) == 3
            for row in case["comparison"]["clients"]:
                assert len(row["transitions"]) == 720
        candidate = next(
            c for c in report["cases"] if c["pareto"] and not c["is_baseline"]
        )
        baseline = client.get(f"/api/runs/{baseline_id}").json()
        revision = client.post(
            "/api/revisions",
            json=candidate["scenario"],
            headers={"X-Orbita-Parent-Revision": baseline["revision_id"]},
        )
        revision.raise_for_status()
        assert revision.json()["scenario"] == candidate["scenario"]
        assert (
            httpx.get(args.url + f"/api/experiments/{search_id}/report").status_code
            == 404
        )
        elapsed = round(time.monotonic() - started, 3)
        checkpoint.write_text(
            json.dumps({"id": search_id, "revision_id": revision.json()["id"]}), "utf-8"
        )
        measurement = {
            "version": VERSION,
            "environment": "Local Docker Desktop, HTTP and process pool",
            "baseline": "first launch stage",
            "wall_s": elapsed,
            "search": report["search"],
            "summary": report["summary"],
            "cases": [
                {
                    "key": c["key"],
                    "pareto": c["pareto"],
                    "is_baseline": c["is_baseline"],
                    "objectives": c["objectives"],
                    "scenario_sha256": c["provenance"]["scenario_sha256"],
                }
                for c in report["cases"]
            ],
        }
        (ROOT / "docs/stage6-measurements.json").write_text(
            json.dumps(measurement, ensure_ascii=False, indent=2), "utf-8"
        )
        print(
            f"Six full-day candidates, Pareto, export and revision verified in {elapsed}s"
        )


if __name__ == "__main__":
    main()
