import time

from fastapi.testclient import TestClient

from orbita.api import create_app
from orbita.jobs import perform_run
from orbita.storage import Store


class ImmediateJobs:
    def __init__(self, store, workers):
        self.store = store

    def submit(self, run_id, scenario):
        perform_run(str(self.store.directory), run_id, scenario)

    def close(self):
        pass


class DormantJobs(ImmediateJobs):
    def submit(self, run_id, scenario):
        pass


def test_api_roundtrip_and_session_isolation(tmp_path, tiny):
    app = create_app(tmp_path, job_manager_factory=ImmediateJobs)
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert len(client.get("/api/catalog").json()) == 4
        started = client.post("/api/runs", json=tiny)
        assert started.status_code == 202
        run_id = started.json()["id"]
        assert client.get(f"/api/runs/{run_id}").json()["status"] == "completed"
        assert (
            client.get(f"/api/runs/{run_id}/snapshot/0").json()["clients"]["customer"][
                "hop_count"
            ]
            == 2
        )
        assert client.get(f"/api/runs/{run_id}/snapshot/3").status_code == 422
        exported = client.get(f"/api/runs/{run_id}/export").json()
        assert len(exported["routes"]) == 3
        saved = client.get(f"/api/runs/{run_id}/scenario").json()
        assert saved == tiny
        assert client.post("/api/validate", json=saved).status_code == 200
        assert client.post(f"/api/runs/{run_id}/cancel").status_code == 409
        cookie = client.cookies.get("orbita_session")
        client.cookies.clear()
        assert client.get(f"/api/runs/{run_id}").status_code == 404
        assert client.get("/api/runs").json() == []
        client.cookies.set("orbita_session", cookie)
        assert len(client.get("/api/runs").json()) == 1
    with TestClient(
        create_app(tmp_path, job_manager_factory=ImmediateJobs)
    ) as restarted:
        restarted.cookies.set("orbita_session", cookie)
        assert restarted.get(f"/api/runs/{run_id}/export").json() == exported


def test_validation_cancel_and_recovery(tmp_path, tiny):
    with TestClient(create_app(tmp_path, job_manager_factory=DormantJobs)) as client:
        invalid = client.post("/api/validate", content='{"a":1,"a":2}')
        assert (
            invalid.status_code == 422
            and invalid.json()["issues"][0]["code"] == "duplicate_key"
        )
        run_id = client.post("/api/runs", json=tiny).json()["id"]
        assert client.get(f"/api/runs/{run_id}/export").status_code == 409
        assert client.post(f"/api/runs/{run_id}/cancel").json()["status"] == "cancelled"
        another = client.post("/api/runs", json=tiny).json()["id"]
        cookie = client.cookies.get("orbita_session")
    with TestClient(create_app(tmp_path, job_manager_factory=DormantJobs)) as restarted:
        restarted.cookies.set("orbita_session", cookie)
        assert restarted.get(f"/api/runs/{another}").json()["status"] == "interrupted"


def test_real_background_process(tmp_path, tiny):
    with TestClient(create_app(tmp_path, workers=1)) as client:
        run_id = client.post("/api/runs", json=tiny).json()["id"]
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            status = client.get(f"/api/runs/{run_id}").json()["status"]
            if status not in ("queued", "running"):
                break
            time.sleep(0.05)
        assert status == "completed"
        assert (
            client.get(f"/api/runs/{run_id}/result").json()["summary"]["sample_count"]
            == 3
        )


def test_cancel_completion_race_is_not_completed(tmp_path, tiny):
    from orbita.engine import simulate

    store = Store(tmp_path)
    run = store.create("owner", tiny)
    assert store.start(run["id"])
    assert store.cancel(run["id"], "owner")
    store.complete(run["id"], simulate(tiny))
    assert store.get(run["id"], "owner")["status"] == "cancelled"
    assert not (store.artifacts / f"{run['id']}.json.gz").exists()
