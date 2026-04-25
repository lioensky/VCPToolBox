"""Concurrent execution utilities for running independent provider calls in parallel.

Uses ``concurrent.futures.ThreadPoolExecutor`` (stdlib) so that existing
synchronous providers can be called in parallel without any code changes.

Thread-safety notes
-------------------
* ``UrllibJsonClient`` creates a fresh connection per request – no shared
  socket state, safe across threads.
* ``RecordingHttpClient`` writes each snapshot to a unique file (keyed by
  URL + params SHA-1 hash), so concurrent writes never collide.
* ``ReplayHttpClient`` loads all snapshots into a ``dict`` at init and only
  reads afterwards – concurrent dict reads are safe in CPython.
"""

from __future__ import annotations

import concurrent.futures
from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar

T = TypeVar("T")

__all__ = ["GatherError", "GatherResult", "gather"]


class GatherError(RuntimeError):
    """Raised when *fail_fast* is ``True`` and at least one task fails."""

    def __init__(
        self,
        message: str,
        results: dict[str, Any],
        errors: dict[str, BaseException],
    ) -> None:
        super().__init__(message)
        self.results = results
        self.errors = errors


@dataclass(frozen=True)
class GatherResult:
    """Container for the outcome of a :func:`gather` call.

    *results* holds values keyed by the label passed to ``gather()``.
    *errors* holds exceptions for any tasks that failed.
    """

    results: dict[str, Any] = field(default_factory=dict)
    errors: dict[str, BaseException] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        """``True`` when every task completed without error."""
        return len(self.errors) == 0

    def get(self, key: str) -> Any:
        """Return a successful result, or re-raise the stored error."""
        if key in self.errors:
            raise self.errors[key]
        return self.results[key]

    def get_or(self, key: str, default: T) -> Any:
        """Return a successful result, or *default* if the task failed."""
        if key in self.errors:
            return default
        return self.results.get(key, default)


def gather(
    tasks: dict[str, Callable[[], Any]],
    *,
    max_workers: int | None = None,
    timeout_seconds: float | None = None,
    fail_fast: bool = False,
) -> GatherResult:
    """Run multiple callables concurrently and collect their results.

    Parameters
    ----------
    tasks:
        Mapping of *label* → *callable*.  Each callable takes no arguments
        and returns a value.  Labels identify results in the returned
        :class:`GatherResult`.
    max_workers:
        Maximum thread-pool size.  Defaults to ``len(tasks)``.
    timeout_seconds:
        Wall-clock cap for the entire batch.  ``None`` means no limit.
    fail_fast:
        If ``True``, raise :class:`GatherError` as soon as any task fails.
        If ``False`` (the default), wait for every task and return partial
        results.

    Returns
    -------
    GatherResult
        Contains ``.results`` and ``.errors`` dicts keyed by label.
    """
    if not tasks:
        return GatherResult()

    effective_workers = max_workers if max_workers is not None else len(tasks)
    results: dict[str, Any] = {}
    errors: dict[str, BaseException] = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=effective_workers) as pool:
        future_to_label: dict[concurrent.futures.Future[Any], str] = {
            pool.submit(fn): label for label, fn in tasks.items()
        }

        done, not_done = concurrent.futures.wait(
            future_to_label,
            timeout=timeout_seconds,
            return_when=(
                concurrent.futures.FIRST_EXCEPTION
                if fail_fast
                else concurrent.futures.ALL_COMPLETED
            ),
        )

        for future in done:
            label = future_to_label[future]
            try:
                results[label] = future.result(timeout=0)
            except BaseException as exc:
                errors[label] = exc

        for future in not_done:
            label = future_to_label[future]
            future.cancel()
            errors[label] = TimeoutError(
                f"task {label!r} did not complete within {timeout_seconds}s"
            )

    if fail_fast and errors:
        first_label = next(iter(errors))
        raise GatherError(
            f"task {first_label!r} failed: {errors[first_label]}",
            results=results,
            errors=errors,
        )

    return GatherResult(results=results, errors=errors)
