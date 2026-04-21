"""Async concurrency stress tests for Azure Functions."""
import asyncio
import sys
import tempfile
from typing import Any

import pytest
from portal.shared.api.persistence import SqliteStore


@pytest.mark.asyncio
class TestAIConcurrency:
    """Test AI enrichment function under concurrent load."""

    async def test_async_gather_collects_all_results(self) -> None:
        """asyncio.gather collects all results from concurrent coroutines without interference."""
        results: list[dict[str, object]] = []
        errors: list[dict[str, object]] = []

        async def simulate_request(text: str, request_id: int) -> None:
            try:
                await asyncio.sleep(0.01)
                results.append({"id": request_id, "text": text})
            except Exception as e:
                errors.append({"id": request_id, "error": str(e)})

        tasks = [simulate_request(f"Document {i} content", i) for i in range(50)]
        await asyncio.gather(*tasks)

        assert len(results) == 50
        assert len(errors) == 0
        ids = {r["id"] for r in results}
        assert len(ids) == 50

    @pytest.mark.xfail(
        sys.platform == "win32",
        reason="SQLite file locking on Windows prevents temp dir cleanup",
        strict=False,
    )
    async def test_concurrent_store_operations(self) -> None:
        """SQLite store should handle concurrent reads/writes safely."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SqliteStore("test_concurrent", data_dir=tmpdir)

            errors: list[str] = []

            async def write_item(i: int) -> None:
                try:
                    store.add({"name": f"item-{i}", "value": i})
                except Exception as e:
                    errors.append(str(e))

            async def read_items() -> list[dict[str, Any]]:
                try:
                    return store.list()
                except Exception as e:
                    errors.append(str(e))
                    return []

            # Concurrent writes
            write_tasks = [write_item(i) for i in range(100)]
            await asyncio.gather(*write_tasks)

            assert len(errors) == 0, f"Errors during concurrent writes: {errors}"
            items = store.list()
            assert len(items) == 100

            # Concurrent reads while writing
            mixed_tasks = [
                *[write_item(100 + i) for i in range(50)],
                *[read_items() for _ in range(50)],
            ]
            await asyncio.gather(*mixed_tasks)

            assert len(errors) == 0, f"Errors during mixed operations: {errors}"
            final_items = store.list()
            assert len(final_items) == 150


@pytest.mark.asyncio
class TestEventProcessingConcurrency:
    """Test event processing under concurrent load."""

    async def test_async_batch_processing_collects_all_events(self) -> None:
        """asyncio.gather over multiple batch coroutines collects all events without loss."""
        processed: list[dict[str, object]] = []

        async def process_batch(batch_id: int, events: list[str]) -> None:
            for event in events:
                await asyncio.sleep(0.001)
                processed.append({"batch": batch_id, "event": event})

        batches = [
            process_batch(i, [f"event-{i}-{j}" for j in range(10)]) for i in range(20)
        ]
        await asyncio.gather(*batches)

        assert len(processed) == 200  # 20 batches * 10 events
        event_ids = [p["event"] for p in processed]
        assert len(set(event_ids)) == 200
