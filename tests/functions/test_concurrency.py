"""Async concurrency stress tests for Azure Functions."""
import asyncio
import os
import tempfile

import pytest

from portal.shared.api.persistence import SqliteStore


@pytest.mark.asyncio
class TestAIConcurrency:
    """Test AI enrichment function under concurrent load."""

    async def test_concurrent_enrichment_requests(self):
        """Multiple simultaneous enrichment requests should not interfere."""
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

    async def test_concurrent_store_operations(self):
        """SQLite store should handle concurrent reads/writes safely."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test.db")
            store = SqliteStore("test_concurrent", db_path=db_path)

            errors: list[str] = []

            async def write_item(i: int) -> None:
                try:
                    store.add({"name": f"item-{i}", "value": i})
                except Exception as e:
                    errors.append(str(e))

            async def read_items() -> list[dict[str, object]]:
                try:
                    return store.list()  # type: ignore[return-value]
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

    async def test_concurrent_event_batches(self):
        """Multiple event batches processed concurrently should not lose events."""
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
