from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
import secrets

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .engine import analyze_snapshot, export_result
from .geometry_adapter import ROOT, geometry_hash, reference, snapshot
from .jobs import JobManager
from .scenario import (
    Scenario,
    ScenarioError,
    load_scenario,
    parse_json,
    validate_scenario,
)
from .storage import Store
from .comparison import compare_results
from .resilience import recommendation_candidates, snapshot_diagnostics
from .optimization import SearchOptions, search_plan
from pydantic import BaseModel, ConfigDict
from typing import Literal


class ExperimentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str
    kind: Literal["n_minus_one", "recommendations", "optimization"]
    options: SearchOptions | None = None


MAX_UPLOAD = 10 * 1024 * 1024


def create_app(
    data_dir: str | Path | None = None, workers=2, job_manager_factory=JobManager
) -> FastAPI:
    directory = data_dir or os.getenv("ORBITA_DATA_DIR", str(ROOT / "var"))

    @asynccontextmanager
    async def lifespan(app):
        app.state.store = Store(directory)
        app.state.store.recover()
        app.state.jobs = job_manager_factory(app.state.store, workers)
        yield
        app.state.jobs.close()

    app = FastAPI(
        title="Орбита — расчётный API", version=__version__, lifespan=lifespan
    )

    @app.middleware("http")
    async def session(request, call_next):
        owner = request.cookies.get("orbita_session", "")
        fresh = not re.fullmatch(r"[a-f0-9]{64}", owner)
        if fresh:
            owner = secrets.token_hex(32)
        request.state.owner = owner
        response = await call_next(request)
        if fresh:
            response.set_cookie(
                "orbita_session",
                owner,
                httponly=True,
                samesite="strict",
                max_age=60 * 60 * 24 * 30,
                secure=os.getenv("ORBITA_SECURE_COOKIE", "0") == "1",
            )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ScenarioError)
    async def invalid_scenario(request, exc):
        return JSONResponse(
            status_code=422, content={"error": "invalid_scenario", "issues": exc.issues}
        )

    async def read_scenario(request):
        chunks, length = [], 0
        async for chunk in request.stream():
            length += len(chunk)
            if length > MAX_UPLOAD:
                raise HTTPException(413, "Файл превышает 10 МБ")
            chunks.append(chunk)
        return validate_scenario(parse_json(b"".join(chunks)))

    def owned_run(request, run_id, completed=False):
        run = app.state.store.get(run_id, request.state.owner)
        if run is None:
            raise HTTPException(404, "Расчёт не найден")
        if completed and run["status"] != "completed":
            raise HTTPException(409, "Расчёт ещё не завершён")
        return run

    def parent_revision(request):
        revision_id = request.headers.get("X-Orbita-Parent-Revision")
        if (
            revision_id
            and app.state.store.revision(revision_id, request.state.owner) is None
        ):
            raise HTTPException(404, "Исходная ревизия не найдена")
        return revision_id

    @app.get("/api/revisions")
    def revisions(request: Request):
        return app.state.store.revisions(request.state.owner)

    @app.get("/api/revisions/{revision_id}")
    def revision(revision_id: str, request: Request):
        value = app.state.store.revision(revision_id, request.state.owner)
        if value is None:
            raise HTTPException(404, "Ревизия не найдена")
        return value

    @app.post("/api/revisions", status_code=201)
    async def save_revision(request: Request):
        scenario = await read_scenario(request)
        return app.state.store.save_revision(
            request.state.owner, scenario, parent_revision(request)
        )

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "version": __version__,
            "geometry_sha256": geometry_hash(),
        }

    @app.get("/api/scenario-schema")
    def schema():
        return Scenario.model_json_schema()

    @app.get("/api/catalog")
    def catalog():
        items = []
        for path in sorted((ROOT / "Данные").glob("*.json")):
            scenario = load_scenario(path)
            items.append(
                {
                    "file": path.name,
                    "title": scenario["meta"]["title"],
                    "scenario": scenario,
                }
            )
        return items

    @app.post("/api/validate")
    async def validate(request: Request):
        scenario = await read_scenario(request)
        env = scenario["environment"]
        return {
            "valid": True,
            "scenario": scenario,
            "sample_count": env["horizon_s"] // env["step_s"],
        }

    @app.get("/api/runs")
    def runs(request: Request):
        return app.state.store.list(request.state.owner)

    @app.post("/api/runs", status_code=202)
    async def start(request: Request):
        scenario = await read_scenario(request)
        env = scenario["environment"]
        samples = env["horizon_s"] // env["step_s"]
        satellites = len(scenario["design"]["satellites"])
        ground = len(scenario["ground_sites"])
        budget = int(os.getenv("ORBITA_MAX_WORK", "100000000"))
        if (
            satellites > 1024
            or samples * (satellites**2 + satellites * ground) > budget
            or samples * ground > 1000000
        ):
            raise HTTPException(
                422,
                "Сценарий корректен, но превышает ресурсный бюджет сервера. Уменьшите объём или увеличьте бюджет ORBITA_MAX_WORK при развёртывании.",
            )
        try:
            run = app.state.store.create(
                request.state.owner, scenario, parent_revision=parent_revision(request)
            )
        except OverflowError as exc:
            raise HTTPException(429, str(exc)) from exc
        try:
            app.state.jobs.submit(run["id"], scenario)
        except Exception:
            app.state.store.fail(run["id"], "Не удалось запустить расчётный процесс")
            raise HTTPException(503, "Расчётный процесс недоступен")
        return run

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str, request: Request):
        return owned_run(request, run_id)

    @app.post("/api/runs/{run_id}/cancel")
    def cancel(run_id: str, request: Request):
        owned_run(request, run_id)
        if not app.state.store.cancel(run_id, request.state.owner):
            raise HTTPException(409, "Завершённый расчёт нельзя отменить")
        return owned_run(request, run_id)

    @app.get("/api/runs/{run_id}/result")
    def result(run_id: str, request: Request):
        owned_run(request, run_id, completed=True)
        return app.state.store.result(run_id)

    @app.get("/api/runs/{run_id}/snapshot/{index}")
    def get_snapshot(run_id: str, index: int, request: Request):
        run = owned_run(request, run_id, completed=True)
        if run["kind"] != "simulation":
            raise HTTPException(422, "Нужен расчёт сценария")
        scenario = run["effective_scenario"]
        if not 0 <= index < run["total"]:
            raise HTTPException(422, "Индекс отсчёта вне расчётной сетки")
        t_s = index * scenario["environment"]["step_s"]
        snap = snapshot(scenario, t_s)
        clients, network = analyze_snapshot(scenario, snap)
        sat_map = {s["id"]: s for s in scenario["design"]["satellites"]}
        for sat in snap["satellites"]:
            source = sat_map[sat["id"]]
            sat.update(
                plane_id=source["plane_id"],
                launch_batch=source["launch_batch"],
                state="active"
                if sat["active"]
                else "not_launched"
                if source["launch_batch"] > scenario["design"]["launch_stage"]
                else "failed",
            )
        ground_sites = []
        for ground in scenario["ground_sites"]:
            xyz = reference().ground_position(ground)
            ground_sites.append(
                {
                    **ground,
                    "x_km": float(xyz[0]),
                    "y_km": float(xyz[1]),
                    "z_km": float(xyz[2]),
                    "online": ground["role"] == "client"
                    or ground["id"] in network["online_gateways"],
                }
            )
        return {
            **snap,
            "run_id": run_id,
            "index": index,
            "clients": clients,
            "network": network,
            "ground_sites": ground_sites,
        }

    @app.get("/api/runs/{run_id}/export")
    def export(run_id: str, request: Request):
        run = owned_run(request, run_id, completed=True)
        if run["kind"] != "simulation":
            raise HTTPException(409, "Для эксперимента используйте экспорт отчёта")
        data = export_result(app.state.store.result(run_id))
        return Response(
            json.dumps(data, ensure_ascii=False, allow_nan=False),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="orbita-result-{run_id[:8]}.json"'
            },
        )

    @app.get("/api/runs/{run_id}/scenario")
    def scenario_export(run_id: str, request: Request):
        run = owned_run(request, run_id)
        return Response(
            json.dumps(
                run["effective_scenario"], ensure_ascii=False, allow_nan=False, indent=2
            ),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="orbita-scenario-{run_id[:8]}.json"'
            },
        )

    @app.get("/api/compare")
    def compare(a: str, b: str, request: Request):
        for run_id in (a, b):
            if owned_run(request, run_id, completed=True)["kind"] != "simulation":
                raise HTTPException(422, "Сравниваются только расчёты сценариев")
        return compare_results(app.state.store.result(a), app.state.store.result(b))

    @app.get("/api/runs/{run_id}/diagnostics/{index}")
    def diagnostics(run_id: str, index: int, client: str, request: Request):
        run = owned_run(request, run_id, completed=True)
        scenario = run["effective_scenario"]
        if (
            run["kind"] != "simulation"
            or not 0 <= index < run["total"]
            or client
            not in {g["id"] for g in scenario["ground_sites"] if g["role"] == "client"}
        ):
            raise HTTPException(422, "Некорректный отсчёт или клиент")
        return snapshot_diagnostics(
            scenario, index * scenario["environment"]["step_s"], client
        )

    @app.get("/api/experiments")
    def experiments(request: Request):
        rows = (
            app.state.store.list(request.state.owner, "n_minus_one")
            + app.state.store.list(request.state.owner, "recommendations")
            + app.state.store.list(request.state.owner, "optimization")
        )
        return sorted(rows, key=lambda r: r["created_at"], reverse=True)

    @app.post("/api/experiments", status_code=202)
    def experiment(payload: ExperimentRequest, request: Request):
        baseline = owned_run(request, payload.run_id, completed=True)
        if baseline["kind"] != "simulation":
            raise HTTPException(422, "Нужен базовый расчёт сценария")
        scenario = baseline["effective_scenario"]
        count = baseline["total"]
        satellites = len(scenario["design"]["satellites"])
        clients = sum(g["role"] == "client" for g in scenario["ground_sites"])
        options = None
        if payload.kind == "optimization":
            try:
                plan = search_plan(
                    scenario, payload.options.model_dump() if payload.options else None
                )
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            options = plan["options"]
            if not plan["candidates"]:
                raise HTTPException(
                    422,
                    "Нет новых сочетаний. Увеличьте дальность, сдвиг фаз или разрешите следующие очереди.",
                )
        elif payload.options is not None:
            raise HTTPException(
                422, "Параметры поиска допустимы только для автоподбора"
            )
        cases = (
            len(plan["candidates"])
            if payload.kind == "optimization"
            else sum(
                s["launch_batch"] <= scenario["design"]["launch_stage"]
                for s in scenario["design"]["satellites"]
            )
            if payload.kind == "n_minus_one"
            else len(recommendation_candidates(scenario))
        )
        work = (
            count
            * max(1, cases)
            * (satellites**2 + satellites * len(scenario["ground_sites"]))
        )
        if (
            work > int(os.getenv("ORBITA_MAX_EXPERIMENT_WORK", "200000000"))
            or count * cases * clients > 250000
        ):
            raise HTTPException(
                422,
                "Эксперимент превышает бюджет сервера. Уменьшите состав или число отсчётов.",
            )
        try:
            run = app.state.store.create(
                request.state.owner,
                scenario,
                parent_revision=baseline["revision_id"],
                kind=payload.kind,
                parent_run_id=payload.run_id,
                total_override=count * max(1, cases),
                options=options,
            )
        except OverflowError as exc:
            raise HTTPException(429, str(exc)) from exc
        try:
            app.state.jobs.submit(
                run["id"], scenario, payload.kind, payload.run_id, options
            )
        except Exception:
            app.state.store.fail(run["id"], "Не удалось запустить эксперимент")
            raise HTTPException(503, "Расчётный процесс недоступен")
        return run

    @app.get("/api/experiments/{run_id}/report")
    def experiment_report(run_id: str, request: Request):
        run = owned_run(request, run_id, completed=True)
        if run["kind"] == "simulation":
            raise HTTPException(422, "Нужен эксперимент")
        data = {
            **app.state.store.result(run_id),
            "run_id": run_id,
            "baseline_run_id": run["parent_run_id"],
        }
        return Response(
            json.dumps(data, ensure_ascii=False, allow_nan=False),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="orbita-experiment-{run_id[:8]}.json"'
            },
        )

    dist = ROOT / "web" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app


app = create_app()
