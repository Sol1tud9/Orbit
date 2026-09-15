from concurrent.futures import ProcessPoolExecutor
import logging
import multiprocessing
from threading import Lock

from .engine import CalculationCancelled, simulate
from .storage import Store
from .resilience import n_minus_one, recommendations
from .optimization import optimize

logger = logging.getLogger(__name__)


def perform_run(
    directory: str,
    run_id: str,
    scenario: dict,
    kind="simulation",
    parent_run_id=None,
    options=None,
):
    store = Store(directory)
    if not store.start(run_id):
        return
    try:
        calculate = (
            simulate
            if kind == "simulation"
            else n_minus_one
            if kind == "n_minus_one"
            else optimize
            if kind == "optimization"
            else recommendations
        )
        arguments = (
            {} if kind == "simulation" else {"baseline": store.result(parent_run_id)}
        )
        if kind == "optimization":
            arguments["options"] = options
        result = calculate(
            scenario,
            **arguments,
            progress=lambda done, total: store.progress(run_id, done),
            cancelled=lambda: store.is_cancelled(run_id),
        )
        store.complete(run_id, result)
    except CalculationCancelled:
        store.finish_cancelled(run_id)
    except Exception:
        logger.exception("Calculation failed: %s", run_id)
        if store.is_cancelled(run_id):
            store.finish_cancelled(run_id)
        else:
            store.fail(
                run_id,
                "Не удалось завершить расчёт. Проверьте сценарий; подробности записаны в журнал сервиса.",
            )


class JobManager:
    def __init__(self, store: Store, workers: int = 2):
        self.store = store
        self.pool = ProcessPoolExecutor(
            max_workers=workers, mp_context=multiprocessing.get_context("spawn")
        )
        self.futures = {}
        self.lock = Lock()

    def submit(
        self, run_id, scenario, kind="simulation", parent_run_id=None, options=None
    ):
        future = self.pool.submit(
            perform_run,
            str(self.store.directory),
            run_id,
            scenario,
            kind,
            parent_run_id,
            options,
        )
        with self.lock:
            self.futures[run_id] = future

        def finished(value):
            try:
                value.result()
            except Exception:
                logger.exception("Worker failed: %s", run_id)
                if self.store.is_cancelled(run_id):
                    self.store.finish_cancelled(run_id)
                else:
                    self.store.fail(
                        run_id,
                        "Расчётный процесс завершился с ошибкой. Повторите запуск.",
                    )
            finally:
                with self.lock:
                    self.futures.pop(run_id, None)

        future.add_done_callback(finished)

    def close(self):
        with self.lock:
            ids = list(self.futures)
        with self.store.connect() as db:
            for run_id in ids:
                db.execute(
                    "UPDATE runs SET cancel_requested=1 WHERE id=? AND status IN ('queued','running','cancelling')",
                    (run_id,),
                )
        self.pool.shutdown(wait=True, cancel_futures=True)
