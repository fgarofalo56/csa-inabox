"""Tests for ``csa_platform.ai_integration.graphrag.graph_store``.

Pin the dataclass contracts and the constructor's environment-variable
behavior. Real Cosmos Gremlin calls are not exercised — the client is
constructed lazily and is monkey-patched here to keep the test pure.
"""

from __future__ import annotations

import pytest

from csa_platform.ai_integration.graphrag.graph_store import (
    CosmosGremlinStore,
    GraphEntity,
    GraphRelationship,
)


class TestDataclasses:
    def test_graph_entity_defaults(self) -> None:
        e = GraphEntity(id="1", name="Acme", type="Org", description="d")
        assert e.properties == {}

    def test_graph_relationship_default_weight(self) -> None:
        r = GraphRelationship(
            source_id="1", target_id="2", type="OWNS", description="d"
        )
        assert r.weight == 1.0
        assert r.properties == {}


class TestCosmosGremlinStoreConstruction:
    def test_reads_env_when_kwargs_not_given(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("COSMOS_GREMLIN_ENDPOINT", "wss://example/")
        monkeypatch.setenv("COSMOS_GREMLIN_KEY", "secret")
        monkeypatch.setattr(
            "csa_platform.ai_integration.graphrag.graph_store.DefaultAzureCredential",
            lambda: object(),
        )
        store = CosmosGremlinStore()
        # Internal attrs are private; assert through behavior:
        assert store._endpoint == "wss://example/"
        assert store._key == "secret"
        assert store._client is None  # lazy

    def test_kwargs_override_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("COSMOS_GREMLIN_ENDPOINT", "env-endpoint")
        monkeypatch.setattr(
            "csa_platform.ai_integration.graphrag.graph_store.DefaultAzureCredential",
            lambda: object(),
        )
        store = CosmosGremlinStore(
            endpoint="kwarg-endpoint", database="db1", graph="g1", key="k1"
        )
        assert store._endpoint == "kwarg-endpoint"
        assert store._database == "db1"
        assert store._graph == "g1"
        assert store._key == "k1"

    def test_get_client_raises_clear_error_when_gremlin_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "csa_platform.ai_integration.graphrag.graph_store.DefaultAzureCredential",
            lambda: object(),
        )
        store = CosmosGremlinStore(endpoint="wss://x/", key="k")

        # Force the inner import to fail.
        import builtins

        real_import = builtins.__import__

        def fake_import(name: str, *args: object, **kwargs: object) -> object:
            if name.startswith("gremlin_python"):
                raise ImportError("simulated")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        with pytest.raises(ImportError, match="gremlinpython"):
            store._get_client()
