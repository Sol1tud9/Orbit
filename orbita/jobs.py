from concurrent.futures import ProcessPoolExecutor
import logging
import multiprocessing
from threading import Lock

from .engine import CalculationCancelled, simulate
from .storage import Store

logger = logging.getLogger(__name__)


def perform_run(directory: str, run_id: str, scenario: dict):
    store = Store(directory)
    if not store.start(run_id):
        return
    try:
        result = simulate(
            scenario,
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

    def submit(self, run_id, scenario):
        future = self.pool.submit(
            perform_run, str(self.store.directory), run_id, scenario
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
        # Mark owned jobs for cancellation before waiting for process shutdown.
        with self.lock:
            ids = list(self.futures)
        with self.store.connect() as db:
            for run_id in ids:
                db.execute(
                    "UPDATE runs SET cancel_requested=1 WHERE id=? AND status IN ('queued','running','cancelling')",
                    (run_id,),
                )
        self.pool.shutdown(wait=True, cancel_futures=True)
