[English](README.md) | [Русский](README_RU.md)

# Orbita

Orbita is an engineering web application for designing, simulating, and comparing satellite constellations under the mathematical model defined for CosmoHackathon 2026.

It calculates the network state over time, finds end-to-end routes from ground clients to gateways, explains outages, evaluates failures, and compares design alternatives. The organizer-provided `geometry.py` is used as the reference implementation for orbital geometry and contact availability.

![Orbita workspace](docs/screenshots/research.png)

## Features

- Load the four organizer scenarios or any valid JSON scenario with the same schema.
- Edit deployment stage, orbital planes, satellites, ground sites, failures, gateway outages, and communication parameters.
- Calculate coordinates, contacts, and client routes on the complete time grid.
- Measure ground coverage and end-to-end availability separately.
- Explore the constellation as a globe, polar map, topology graph, and timeline.
- Inspect routes, outages, network components, contacts, and disconnected-state reasons.
- Compare two completed simulations with synchronized time and camera controls.
- Run N-1 satellite failure analysis and evaluate verified improvement candidates.
- Search a reproducible grid of deployment stages, ISL ranges, and plane phases.
- Export scenarios, complete routes, summaries, comparisons, and experiment reports.

## Quick start

Docker Engine with Compose is recommended:

```sh
docker compose -p orbita up -d --build
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Check the API at [http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health).

Stop the application without deleting calculated results:

```sh
docker compose -p orbita down
```

Do not add `-v` unless the persistent Docker volume should also be deleted.

## Typical workflow

1. Select a bundled scenario or upload a JSON file.
2. Click `Рассчитать` to run the simulation.
3. Select a client and a time sample.
4. Inspect the route, timeline, outages, contacts, and topology.
5. Open `Проектирование`, change the design, save a revision, and calculate it.
6. Open `Сравнение A/B` to compare the baseline and the new result.
7. Use `Устойчивость` for N-1 and verified improvement candidates.
8. Use `Автоподбор` to evaluate parameter combinations and the Pareto frontier.
9. Export the selected scenario and result.

The interface is currently in Russian. The calculation API and exported formats are language-independent.

## Reference model

The sources of truth are the three organizer PDFs in the repository root and `Расчетный модуль/geometry.py`. Orbita calls the reference module through an adapter instead of recreating its geometry in the browser.

The model uses a spherical Earth with radius 6371 km, circular orbits, gravitational parameter `398600.435507 km^3/s^2`, Earth rotation period `86164.09054 s`, and Earth-fixed coordinates for contact calculations.

A satellite is active when `launch_batch <= launch_stage` and the current time does not belong to a failure interval `[start_s, end_s)`. A ground contact exists when the satellite is active and elevation is greater than or equal to `min_elevation_deg`. An inter-satellite link exists when both satellites are active, their distance is strictly less than `isl_range_km`, and the connecting segment does not intersect or touch the Earth sphere.

The application does not add radio budget, atmosphere, traffic capacity, interference, energy consumption, or packet latency to the organizer model.

## Routing

Each snapshot produces an undirected contact graph. A client is the source, active satellites are the only transit nodes, and an online gateway is a destination. Ground sites never relay traffic.

Routes are selected by three ordered criteria:

1. Minimum number of edges.
2. Minimum total geometric length among minimum-edge paths.
3. Lexicographically smallest complete ID sequence for a deterministic tie-break.

BFS builds minimum-edge layers. Dynamic programming on the resulting layered graph selects distance and lexical tie-breaks without sacrificing the primary criterion.

If no route exists, Orbita records one main reason: no client coverage, all gateways offline, no gateway contact, or disconnected satellite components. Detailed snapshot facts remain available for inspection.

![Disconnected satellite components](docs/screenshots/disconnected.png)

## Metrics

The time grid is `range(0, horizon_s, step_s)`. A 24-hour scenario with a 120-second step contains 720 samples from 0 to 86280 seconds.

For every client Orbita calculates coverage, availability, target margin, outage intervals and durations, route hop and distance statistics, route changes, and disconnected-state counts. Metrics describe the discrete grid and do not prove continuous connectivity between samples.

## Control scenarios

Every client has 720 samples. Each cell contains visible samples, reachable samples, and maximum outage duration.

| Scenario | C65 | C70 | C72 |
|---|---:|---:|---:|
| Full constellation | 704 / 696 / 480 s | 719 / 711 / 120 s | 720 / 712 / 120 s |
| First launch stage | 275 / 196 / 34320 s | 351 / 114 / 39480 s | 421 / 91 / 47760 s |
| Ten satellite outages | 609 / 571 / 1440 s | 650 / 582 / 1440 s | 670 / 594 / 1200 s |
| ISL range 2000 km | 704 / 558 / 5640 s | 719 / 448 / 10680 s | 720 / 469 / 240 s |

For C65, reducing ISL range to 2000 km keeps coverage at 97.78% while end-to-end availability falls from 96.67% to 77.50%. This demonstrates why coverage alone is insufficient.

![A/B comparison](docs/screenshots/comparison.png)

## Resilience and design search

N-1 evaluates an additional full-horizon failure of every deployed satellite. It recomputes all client routes and ranks satellites by their effect on availability.

![N-1 report](docs/screenshots/n-minus-one.png)

Verified recommendations test a bounded set of changes: remove declared failures, enable the next deployment stage, or increase ISL range by 1000 or 2000 km within the scenario limit. Every candidate is simulated over the full grid. A candidate is marked as supported only when it restores samples and loses none for any client.

![Verified recommendations](docs/screenshots/recommendations.png)

The parameter search evaluates up to 24 combinations of deployment stage, ISL range, and plane phase offsets. A seed makes selection from the finite grid reproducible. The Pareto frontier maximizes worst-client availability while minimizing maximum outage, deployed satellite count, and ISL range. It ranks evaluated combinations and does not claim a global optimum or financial cost.

![Parameter search](docs/screenshots/optimization.png)

## Architecture

```text
React and TypeScript UI
  -> FastAPI
  -> scenario validation and resource limits
  -> SQLite revision and job metadata
  -> separate Python worker process
  -> reference geometry for every time sample
  -> contact graph and routes
  -> time series, metrics, and outages
  -> compressed JSON result
  -> visualization, comparison, and export
```

| Path | Responsibility |
|---|---|
| `orbita/scenario.py` | JSON parsing, validation, references, and scenario hash |
| `orbita/geometry_adapter.py` | Loading and identifying the reference geometry |
| `orbita/topology.py` | Contact graph and satellite components |
| `orbita/routing.py` | Route selection and disconnected-state explanation |
| `orbita/analysis.py` | Coverage, availability, outages, and route statistics |
| `orbita/engine.py` | Complete simulation and required export |
| `orbita/comparison.py` | A/B compatibility and deltas |
| `orbita/resilience.py` | Diagnostics, N-1, and verified recommendations |
| `orbita/optimization.py` | Reproducible search and Pareto frontier |
| `orbita/storage.py` | SQLite metadata and atomic compressed artifacts |
| `orbita/jobs.py` | Process pool, progress, cancellation, and recovery |
| `orbita/api.py` | HTTP API, anonymous sessions, and resource limits |
| `web/src` | Interface, editor, scenes, timeline, and experiments |

The UI never recalculates orbital geometry. Camera rotation, themes, and projection changes only affect presentation.

## Input and output

The scenario schema version is `cosmo-A-1.0`. The structural schema is available at [docs/scenario.schema.json](docs/scenario.schema.json). Cross-field references and organizer validation are enforced by the backend and reference module.

Unknown scenario fields are preserved. Duplicate keys, non-finite numbers, invalid references, malformed intervals, and invalid grid settings are rejected with field paths. HTTP uploads are limited to 10 MB and calculations are protected by resource budgets.

The required `cosmo-A-result-1.0` export contains the complete effective scenario, exactly one route record for every client and sample, summaries, and engine, scenario, geometry, and routing provenance.

## Local development

Requirements: Python 3.12 and Node.js 22.12 or newer.

Windows PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
cd web
npm ci
npm run build
cd ..
.\.venv\Scripts\python.exe -m uvicorn orbita.api:app --host 127.0.0.1 --port 8000 --workers 1
```

Linux or macOS:

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
cd web
npm ci
npm run build
cd ..
python -m uvicorn orbita.api:app --host 127.0.0.1 --port 8000 --workers 1
```

CLI example:

```sh
python -m orbita.cli "Данные/01_full_constellation.json" --output var/full-result.json
```

## Verification

```sh
python -m pytest -q
python -m pip install ruff==0.9.7
python -m ruff check orbita tests
cd web
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```

The suite contains 114 Python tests and 10 browser tests. It covers the control scenarios, route validity and tie-breaks, boundary conditions, arbitrary IDs, multiple gateways, revisions, cancellation, A/B comparison, N-1 equivalence, recommendations, reproducible search, themes, and responsive layouts. GitHub Actions runs the Python and browser suites on pushes and pull requests.

## Public deployment

`compose.public.yaml` adds Caddy and HTTPS for a server with a domain. Copy `.env.example` to `.env`, set `ORBITA_DOMAIN`, and run:

```sh
docker compose -p orbita -f compose.yaml -f compose.public.yaml up -d --build
```

Run one Uvicorn worker. CPU-bound simulations are handled by a separate process pool. Back up the complete `/data` volume while the application container is stopped.

## Limitations

- Results are evaluated on a discrete time grid.
- The model describes geometric contacts, not radio capacity or hardware reliability.
- Search is bounded and does not prove a global optimum.
- An alternative path may share satellites with the primary path.
- Sessions are anonymous and browser-cookie based; there are no user accounts.
- Storage is designed for one server with SQLite and one API worker.
- Old artifacts are not deleted automatically.
- PDF reports and cost optimization are not implemented.

The repository includes the organizer task statement, data description, evaluation criteria, four source scenarios, and the unchanged reference geometry module.
