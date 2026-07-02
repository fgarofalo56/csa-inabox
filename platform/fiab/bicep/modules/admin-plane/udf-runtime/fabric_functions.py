"""
CSA Loom — `fabric.functions` compatibility shim.

Materialized by the ACA init container as `fabric/functions.py` so that
published User Data Function source imports unchanged:

    import fabric.functions as fn
    udf = fn.UserDataFunctions()

    @udf.function()
    def compute_score(user_id: str, weight: float = 1.0) -> dict:
        return {"user": user_id, "score": weight * 42}

The `@udf.function()` decorator registers the wrapped callable in a
module-level registry the host (app.py) reads after exec'ing the source. This
is a real executor — it runs the author's Python — not a mock; functions that
compute from their inputs (the common case) run fully.

Data-source binding types (FabricSqlConnection, lakehouse clients, etc.) are
provided as placeholders so that source using them as type annotations imports
cleanly. If a function actually *uses* one at runtime it raises
NotImplementedError with the exact remediation, which the host surfaces as an
HTTP 409 honest gate (per no-vaporware.md) rather than faking a result. Wire a
real connection by setting the connection env/secret and replacing the
placeholder — see README.md.
"""

_REGISTRY = {}


def registry():
    return _REGISTRY


def reset_registry():
    _REGISTRY.clear()


class _Unbound:
    """Placeholder for an unwired Fabric data-source binding (honest gate)."""

    def __init__(self, kind):
        self._kind = kind

    def __getattr__(self, _name):
        raise NotImplementedError(
            "Data-source binding '%s' is not wired in this Loom UDF runtime. "
            "Configure the connection (set its env/Key Vault secret and grant the "
            "Console UAMI access) then bind it in the function. See the udf-runtime "
            "README. The function's compute logic runs; only the external binding is gated."
            % self._kind
        )


class FabricSqlConnection(_Unbound):
    def __init__(self, *_a, **_k):
        super().__init__("FabricSqlConnection")


class FabricLakehouseClient(_Unbound):
    def __init__(self, *_a, **_k):
        super().__init__("FabricLakehouseClient")


class FabricLakehouseFilesClient(_Unbound):
    def __init__(self, *_a, **_k):
        super().__init__("FabricLakehouseFilesClient")


class UserDataFunctionContext:
    """Invocation context. Populated minimally; extend as needed."""

    def __init__(self, invocation_id=None, executing_user=None):
        self.invocation_id = invocation_id
        self.executing_user = executing_user or {}


class UserDataFunctions:
    """Registrar mirroring the Fabric UDF programming model."""

    def function(self, *_dargs, **_dkwargs):
        def deco(func):
            _REGISTRY[func.__name__] = func
            return func

        # Support both @udf.function and @udf.function()
        if len(_dargs) == 1 and callable(_dargs[0]) and not _dkwargs:
            func = _dargs[0]
            _REGISTRY[func.__name__] = func
            return func
        return deco

    def connection(self, *_dargs, **_dkwargs):
        """@udf.connection(argName=..., alias=...) — no-op binding decorator."""
        def deco(func):
            return func

        return deco

    def context(self, *_dargs, **_dkwargs):
        def deco(func):
            return func

        return deco
