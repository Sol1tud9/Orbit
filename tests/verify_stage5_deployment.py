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
    state = json.loads((ROOT / "var/deployment-check.json").read_text("utf-8"))
    checkpoint = ROOT / "var/stage5-check.json"
    with httpx.Client(base_url=args.url, timeout=30) as client:
        client.cookies.update(state["cookies"])
        health = client.get("/api/health").json()
        assert health["version"] == "0.5.0"
        if args.resume:
            saved = json.loads(checkpoint.read_text("utf-8"))
            for run_id in saved["experiments"]:
                assert (
                    client.get(f"/api/experiments/{run_id}/report").status_code == 200
                )
            assert (
                client.get(f"/api/revisions/{saved['revision_id']}").status_code == 200
            )
            print("Stage 5 reports and revision survived container restart")
            return
        full, failed = state["run_ids"][0], state["run_ids"][2]
        comparison = client.get(f"/api/compare?a={full}&b={failed}")
        comparison.raise_for_status()
        c65 = next(c for c in comparison.json()["clients"] if c["client_id"] == "C65")
        assert c65["lost_samples"] == 125
        ids, measurements = [], []
        for kind, baseline in [("n_minus_one", full), ("recommendations", failed)]:
            started = time.monotonic()
            response = client.post(
                "/api/experiments", json={"run_id": baseline, "kind": kind}
            )
            response.raise_for_status()
            run_id = response.json()["id"]
            ids.append(run_id)
            while True:
                run = client.get(f"/api/runs/{run_id}").json()
                if run["status"] == "completed":
                    break
                assert run["status"] in ("running", "queued"), run
                assert time.monotonic() - started < 180
                time.sleep(0.25)
            report = client.get(f"/api/experiments/{run_id}/report").json()
            assert report["baseline_run_id"] == baseline
            if kind == "n_minus_one":
                assert report["summary"]["case_count"] == 48
                assert report["cases"][0]["satellite_id"] == "S44"
                assert report["cases"][0]["lost_samples"] == {
                    "C65": 17,
                    "C70": 14,
                    "C72": 14,
                }
            else:
                assert report["summary"]["improvement_count"] > 0
                base = client.get(f"/api/runs/{baseline}").json()
                candidate = report["cases"][0]
                revision = client.post(
                    "/api/revisions",
                    json=candidate["scenario"],
                    headers={"X-Orbita-Parent-Revision": base["revision_id"]},
                )
                revision.raise_for_status()
                revision_id = revision.json()["id"]
                assert revision.json()["scenario"] == candidate["scenario"]
            assert (
                httpx.get(args.url + f"/api/experiments/{run_id}/report").status_code
                == 404
            )
            elapsed = round(time.monotonic() - started, 3)
            measurements.append(
                {"kind": kind, "wall_s": elapsed, "summary": report["summary"]}
            )
            print(f"{kind}: passed ({elapsed}s)", flush=True)
        checkpoint.write_text(
            json.dumps({"experiments": ids, "revision_id": revision_id}), "utf-8"
        )
        (ROOT / "docs/stage5-deployment-measurements.json").write_text(
            json.dumps(
                {
                    "version": health["version"],
                    "environment": "Local Docker Desktop; existing 0.2 data migrated; real HTTP and process workers",
                    "experiments": measurements,
                },
                ensure_ascii=False,
                indent=2,
            ),
            "utf-8",
        )
        print(
            "Migration, comparison, full N-1, recommendations, revision and ownership verified"
        )


if __name__ == "__main__":
    main()
