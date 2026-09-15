"""Single-host SQLite metadata plus atomic compressed run artifacts."""

from contextlib import contextmanager
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sqlite3
import uuid

from .scenario import canonical_hash


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.artifacts = self.directory / "runs"
        self.artifacts.mkdir(exist_ok=True)
        self.database = self.directory / "orbita.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS revisions (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
                    scenario TEXT NOT NULL, scenario_hash TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(id),
                    status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
                    cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                    finished_at TEXT, error TEXT, summary TEXT
                );
                CREATE INDEX IF NOT EXISTS runs_owner_created ON runs(owner, created_at);
            """)
            revision_columns = {
                r[1] for r in db.execute("PRAGMA table_info(revisions)")
            }
            run_columns = {r[1] for r in db.execute("PRAGMA table_info(runs)")}
            if "parent_id" not in revision_columns:
                db.execute("ALTER TABLE revisions ADD COLUMN parent_id TEXT")
            if "kind" not in run_columns:
                db.execute(
                    "ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'simulation'"
                )
                db.execute("ALTER TABLE runs ADD COLUMN parent_run_id TEXT")
            if "options" not in run_columns:
                db.execute("ALTER TABLE runs ADD COLUMN options TEXT")
            db.execute("PRAGMA user_version=3")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def recover(self):
        with self.connect() as db:
            db.execute(
                "UPDATE runs SET status='interrupted', finished_at=?, error=? WHERE status IN ('queued','running','cancelling')",
                (now(), "Сервис был перезапущен. Запустите расчёт повторно."),
            )

    def create(
        self,
        owner: str,
        scenario: dict,
        max_owner_pending=3,
        max_pending=16,
        parent_revision=None,
        kind="simulation",
        parent_run_id=None,
        total_override=None,
        options=None,
    ) -> dict:
        revision_id, run_id = uuid.uuid4().hex, uuid.uuid4().hex
        timestamp = now()
        total = (
            scenario["environment"]["horizon_s"] // scenario["environment"]["step_s"]
        )
        if total_override is not None:
            total = total_override
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            pending = db.execute(
                "SELECT owner FROM runs WHERE status IN ('queued','running','cancelling')"
            ).fetchall()
            if (
                len(pending) >= max_pending
                or sum(r["owner"] == owner for r in pending) >= max_owner_pending
            ):
                raise OverflowError(
                    "Очередь расчётов заполнена. Дождитесь завершения или отмените задание."
                )
            db.execute(
                "INSERT INTO revisions (id,owner,title,scenario,scenario_hash,created_at,parent_id) VALUES (?,?,?,?,?,?,?)",
                (
                    revision_id,
                    owner,
                    scenario["meta"]["title"],
                    json.dumps(scenario, ensure_ascii=False, allow_nan=False),
                    canonical_hash(scenario),
                    timestamp,
                    parent_revision,
                ),
            )
            db.execute(
                "INSERT INTO runs (id,owner,revision_id,status,total,created_at,kind,parent_run_id,options) VALUES (?,?,?,'queued',?,?,?,?,?)",
                (
                    run_id,
                    owner,
                    revision_id,
                    total,
                    timestamp,
                    kind,
                    parent_run_id,
                    json.dumps(options, allow_nan=False)
                    if options is not None
                    else None,
                ),
            )
        return self.get(run_id, owner)

    @staticmethod
    def public_row(row):
        if row is None:
            return None
        result = dict(row)
        result.pop("owner", None)
        result.pop("cancel_requested", None)
        result["options"] = (
            json.loads(result["options"]) if result.get("options") else None
        )
        if "scenario" in result:
            result["effective_scenario"] = json.loads(result.pop("scenario"))
        result["summary"] = (
            json.loads(result["summary"]) if result.get("summary") else None
        )
        return result

    def get(self, run_id, owner):
        with self.connect() as db:
            row = db.execute(
                "SELECT runs.*, revisions.title, revisions.scenario, revisions.scenario_hash FROM runs JOIN revisions ON revisions.id=runs.revision_id WHERE runs.id=? AND runs.owner=?",
                (run_id, owner),
            ).fetchone()
        return self.public_row(row)

    def list(self, owner, kind="simulation"):
        with self.connect() as db:
            rows = db.execute(
                "SELECT runs.*, revisions.title, revisions.scenario_hash FROM runs JOIN revisions ON revisions.id=runs.revision_id WHERE runs.owner=? AND runs.kind=? ORDER BY runs.created_at DESC LIMIT 100",
                (owner, kind),
            ).fetchall()
        return [self.public_row(row) for row in rows]

    def revision(self, revision_id, owner):
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM revisions WHERE id=? AND owner=?", (revision_id, owner)
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result.pop("owner")
        result["scenario"] = json.loads(result["scenario"])
        return result

    def revisions(self, owner):
        with self.connect() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT id,title,scenario_hash,created_at,parent_id FROM revisions WHERE owner=? ORDER BY created_at DESC LIMIT 200",
                    (owner,),
                ).fetchall()
            ]

    def save_revision(self, owner, scenario, parent_id=None):
        revision_id = uuid.uuid4().hex
        with self.connect() as db:
            db.execute(
                "INSERT INTO revisions (id,owner,title,scenario,scenario_hash,created_at,parent_id) VALUES (?,?,?,?,?,?,?)",
                (
                    revision_id,
                    owner,
                    scenario["meta"]["title"],
                    json.dumps(scenario, ensure_ascii=False, allow_nan=False),
                    canonical_hash(scenario),
                    now(),
                    parent_id,
                ),
            )
        return self.revision(revision_id, owner)

    def start(self, run_id):
        with self.connect() as db:
            return (
                db.execute(
                    "UPDATE runs SET status='running' WHERE id=? AND status='queued' AND cancel_requested=0",
                    (run_id,),
                ).rowcount
                == 1
            )

    def progress(self, run_id, completed):
        with self.connect() as db:
            db.execute(
                "UPDATE runs SET progress=? WHERE id=? AND status='running'",
                (completed, run_id),
            )

    def is_cancelled(self, run_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT cancel_requested,status FROM runs WHERE id=?", (run_id,)
            ).fetchone()
        return (
            row is None
            or row["cancel_requested"]
            or row["status"] not in ("queued", "running")
        )

    def cancel(self, run_id, owner):
        with self.connect() as db:
            return (
                db.execute(
                    "UPDATE runs SET cancel_requested=1, status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END, finished_at=CASE WHEN status='queued' THEN ? ELSE NULL END WHERE id=? AND owner=? AND status IN ('queued','running','cancelling')",
                    (now(), run_id, owner),
                ).rowcount
                == 1
            )

    def finish_cancelled(self, run_id):
        with self.connect() as db:
            db.execute(
                "UPDATE runs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','running','cancelling')",
                (now(), run_id),
            )

    def fail(self, run_id, message):
        with self.connect() as db:
            db.execute(
                "UPDATE runs SET status='failed', error=?, finished_at=? WHERE id=? AND status IN ('queued','running')",
                (message, now(), run_id),
            )

    def complete(self, run_id, result):
        artifact = self.artifacts / f"{run_id}.json.gz"
        temporary = artifact.with_suffix(".tmp")
        with gzip.open(temporary, "wt", encoding="utf-8") as stream:
            json.dump(
                result,
                stream,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
        temporary.replace(artifact)
        with self.connect() as db:
            changed = db.execute(
                "UPDATE runs SET status='completed', progress=total, summary=?, finished_at=? WHERE id=? AND status='running' AND cancel_requested=0",
                (json.dumps(result["summary"], ensure_ascii=False), now(), run_id),
            ).rowcount
        if not changed:
            artifact.unlink(missing_ok=True)
            self.finish_cancelled(run_id)

    def result(self, run_id):
        if len(run_id) != 32 or any(c not in "0123456789abcdef" for c in run_id):
            raise ValueError("Invalid run ID")
        with gzip.open(
            self.artifacts / f"{run_id}.json.gz", "rt", encoding="utf-8"
        ) as stream:
            return json.load(stream)
