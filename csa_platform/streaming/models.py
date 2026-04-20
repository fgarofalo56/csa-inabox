"""csa_platform.streaming.models — frozen Pydantic contracts (CSA-0137).

Every contract in this module is immutable (``ConfigDict(frozen=True)``) so
callers can safely pass them across async boundaries without worrying
about mutation.  The contracts are deliberately minimal — they describe
*what* a stream looks like, not *how* it is materialized — so they can
drive:

* :mod:`csa_platform.streaming.sources` (runtime source adapters)
* :mod:`csa_platform.streaming.bronze` (raw-event sink layout)
* :mod:`csa_platform.streaming.silver` (dbt-backed materialized views)
* :mod:`csa_platform.streaming.gold` (latency-governed consumer contract)
* :mod:`csa_platform.streaming.dbt_integration` (dbt sources.yml emitter)
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------


class SourceType(str, Enum):
    """Supported streaming source technologies.

    ``kafka`` here means a Kafka client connecting through the
    Event Hubs Kafka-compatible endpoint — we do not ship a direct
    Apache Kafka client because CSA-in-a-Box targets Azure-native
    services first.
    """

    EVENT_HUB = "event_hub"
    IOT_HUB = "iot_hub"
    KAFKA = "kafka"


class BronzeFormat(str, Enum):
    """On-disk formats supported by :class:`StreamingBronze`."""

    AVRO = "avro"
    PARQUET = "parquet"
    JSON = "json"


# ---------------------------------------------------------------------------
# Connection descriptor (non-secret metadata only)
# ---------------------------------------------------------------------------


class SourceConnection(BaseModel):
    """Non-secret connection descriptor for a streaming source.

    Secrets (connection strings, SAS keys) are NEVER stored on contracts —
    they are resolved at runtime from Key Vault or managed identity by
    the :class:`~csa_platform.streaming.sources.SourceAdapter` implementations.
    This keeps contracts safe to commit to git and to ship to dbt.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    namespace: str = Field(
        ...,
        min_length=1,
        description="Event Hubs namespace, IoT Hub name, or Kafka cluster identifier.",
    )
    entity: str = Field(
        ...,
        min_length=1,
        description="Event hub name, IoT Hub device path, or Kafka topic.",
    )
    consumer_group: str = Field(
        default="$Default",
        min_length=1,
        description="Consumer group used by the source adapter. Defaults to $Default for Event Hubs.",
    )
    fully_qualified_namespace: str | None = Field(
        default=None,
        description=(
            "Optional FQDN (e.g. ``csaiot-ehns.servicebus.windows.net``). "
            "When omitted, adapters resolve it from ``namespace`` + cloud suffix."
        ),
    )


# ---------------------------------------------------------------------------
# SourceContract
# ---------------------------------------------------------------------------


class SourceContract(BaseModel):
    """Contract describing a streaming source.

    Fields:

    * ``name`` — globally unique identifier; used as the dbt source name.
    * ``source_type`` — Event Hub / IoT Hub / Kafka.
    * ``connection`` — non-secret connection descriptor.
    * ``partition_key_path`` — JSONPath-style pointer to the partition key
      field inside each event payload (e.g. ``"$.sensor_id"``).
    * ``schema_ref`` — reference to the schema registry entry (URN/URL).
    * ``watermark_field`` — event-time field used for lateness windows and
      downstream deduplication.
    * ``max_lateness_seconds`` — how long late events are accepted.
    * ``expected_events_per_second`` — forecast used for auto-scale sizing.
    * ``throughput_units`` — provisioned Event Hub TU / IoT Hub units.
    * ``compliance_tags`` — free-form tags (``fedramp-high``, ``pii``, ...).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    source_type: SourceType
    connection: SourceConnection
    partition_key_path: str = Field(..., min_length=1)
    schema_ref: str = Field(..., min_length=1)
    watermark_field: str = Field(..., min_length=1)
    max_lateness_seconds: int = Field(default=300, ge=0, le=86_400)
    expected_events_per_second: int = Field(default=100, ge=1)
    throughput_units: int = Field(default=1, ge=1, le=40)
    compliance_tags: tuple[str, ...] = Field(default_factory=tuple)

    @field_validator("compliance_tags", mode="before")
    @classmethod
    def _coerce_tags(cls, v: Any) -> tuple[str, ...]:
        """Accept either list or tuple input for compliance tags."""
        if v is None:
            return ()
        if isinstance(v, (list, tuple)):
            return tuple(str(item) for item in v)
        raise ValueError("compliance_tags must be a list or tuple of strings")


# ---------------------------------------------------------------------------
# StreamingBronze
# ---------------------------------------------------------------------------


class StreamingBronze(BaseModel):
    """Raw-event sink descriptor for a streaming source.

    The ``path_template`` supports the tokens ``{source}``, ``{yyyy}``,
    ``{mm}``, ``{dd}`` and ``{hh}`` which are substituted at write time.
    Any other ``{token}`` will raise :class:`ValueError` when the bronze
    writer resolves the path.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    contract_ref: str = Field(
        ...,
        min_length=1,
        description="Name of the :class:`SourceContract` this bronze sink consumes.",
    )
    storage_account: str = Field(..., min_length=1)
    container: str = Field(..., min_length=1)
    path_template: str = Field(
        default="bronze/{source}/year={yyyy}/month={mm}/day={dd}/hour={hh}/",
        min_length=1,
    )
    format: BronzeFormat = Field(default=BronzeFormat.AVRO)
    capture_every_seconds: int = Field(default=300, ge=60, le=900)
    capture_size_mb: int = Field(default=300, ge=10, le=500)

    @field_validator("path_template")
    @classmethod
    def _require_tokens(cls, v: str) -> str:
        """At minimum ``{source}`` must appear — otherwise bronze files collide."""
        if "{source}" not in v:
            raise ValueError("path_template must include the '{source}' token")
        return v


# ---------------------------------------------------------------------------
# SilverMaterializedView
# ---------------------------------------------------------------------------


class SilverMaterializedView(BaseModel):
    """Materialized silver view backed by a dbt model.

    The actual SQL lives in the referenced dbt model
    (``dbt_model_ref``); the Pydantic contract only captures the
    metadata needed to wire bronze -> silver and to enforce
    watermark + dedup semantics at orchestration time.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    upstream_bronze: str = Field(
        ...,
        min_length=1,
        description="Name of the :class:`StreamingBronze` feeding this view.",
    )
    dbt_model_ref: str = Field(
        ...,
        min_length=1,
        description="dbt model reference (e.g. ``silver.iot_telemetry_clean``).",
    )
    refresh_interval_seconds: int = Field(default=300, ge=30, le=86_400)
    watermark_field: str = Field(..., min_length=1)
    deduplication_keys: tuple[str, ...] = Field(default_factory=tuple)

    @field_validator("deduplication_keys", mode="before")
    @classmethod
    def _coerce_dedup(cls, v: Any) -> tuple[str, ...]:
        if v is None:
            return ()
        if isinstance(v, (list, tuple)):
            return tuple(str(item) for item in v)
        raise ValueError("deduplication_keys must be a list or tuple of strings")


# ---------------------------------------------------------------------------
# LatencySLO
# ---------------------------------------------------------------------------


class LatencySLO(BaseModel):
    """End-to-end latency SLO for a Gold stream contract.

    Percentiles are expressed in milliseconds (source-event-time to
    consumer-readable-time).  ``sla_threshold_ms`` is the hard threshold
    evaluated by :class:`~csa_platform.streaming.slo.SLOMonitor`;
    ``rolling_window_minutes`` controls the sliding window.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    p50_ms: int = Field(..., ge=0)
    p95_ms: int = Field(..., ge=0)
    p99_ms: int = Field(..., ge=0)
    sla_threshold_ms: int = Field(..., ge=0)
    rolling_window_minutes: int = Field(default=5, ge=1, le=1_440)

    @model_validator(mode="after")
    def _percentiles_monotonic(self) -> LatencySLO:
        if not (self.p50_ms <= self.p95_ms <= self.p99_ms):
            raise ValueError(
                f"Latency percentiles must be monotonic: "
                f"p50={self.p50_ms} p95={self.p95_ms} p99={self.p99_ms}",
            )
        if self.sla_threshold_ms < self.p99_ms:
            # Not an error per se, but noisy in practice — warn loudly via ValueError
            # so tests catch nonsensical SLOs.
            raise ValueError(
                "sla_threshold_ms must be >= p99_ms (a tighter threshold than p99 "
                "is unachievable under normal operation)",
            )
        return self


# ---------------------------------------------------------------------------
# GoldStreamContract
# ---------------------------------------------------------------------------


class GoldStreamContract(BaseModel):
    """Latency-governed gold consumer contract.

    A gold contract unions one or more silver materialized views via
    ``query_spec`` (a dbt model, a KQL view, or a stored query name) and
    is consumed by the identifiers listed in ``consumers``.  The
    :class:`LatencySLO` is enforced by the runtime SLO monitor.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    upstream_silver_refs: tuple[str, ...] = Field(..., min_length=1)
    latency_slo: LatencySLO
    query_spec: str = Field(
        ...,
        min_length=1,
        description="Reference to the materialization query (dbt model, KQL view, etc.).",
    )
    consumers: tuple[str, ...] = Field(..., min_length=1)

    @field_validator("upstream_silver_refs", "consumers", mode="before")
    @classmethod
    def _coerce_sequence(cls, v: Any) -> tuple[str, ...]:
        if isinstance(v, (list, tuple)):
            return tuple(str(item) for item in v)
        raise ValueError("upstream_silver_refs/consumers must be a list or tuple")


# ---------------------------------------------------------------------------
# Top-level bundle: a full streaming contract file
# ---------------------------------------------------------------------------


class StreamingContractBundle(BaseModel):
    """A YAML-loadable bundle of all streaming contracts for a vertical.

    This is the top-level container parsed by the CLI validator.  It ties
    the four contract types together and runs cross-reference checks
    (e.g. every ``StreamingBronze.contract_ref`` must exist in
    ``sources``).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    sources: tuple[SourceContract, ...] = Field(default_factory=tuple)
    bronze: tuple[StreamingBronze, ...] = Field(default_factory=tuple)
    silver: tuple[SilverMaterializedView, ...] = Field(default_factory=tuple)
    gold: tuple[GoldStreamContract, ...] = Field(default_factory=tuple)

    @field_validator("sources", "bronze", "silver", "gold", mode="before")
    @classmethod
    def _coerce_tuples(cls, v: Any) -> tuple[Any, ...]:
        if v is None:
            return ()
        if isinstance(v, (list, tuple)):
            return tuple(v)
        raise ValueError("contract bundle fields must be lists or tuples")

    @model_validator(mode="after")
    def _cross_reference_check(self) -> StreamingContractBundle:
        """Ensure every downstream reference resolves to a known upstream."""
        source_names = {s.name for s in self.sources}
        bronze_refs = {b.contract_ref for b in self.bronze}
        silver_names = {sv.name for sv in self.silver}

        # Bronze must point at an existing source
        missing_bronze = bronze_refs - source_names
        if missing_bronze:
            raise ValueError(
                f"StreamingBronze.contract_ref references unknown sources: "
                f"{sorted(missing_bronze)}",
            )

        # Silver.upstream_bronze must point at an existing bronze contract_ref
        bronze_source_refs = {b.contract_ref for b in self.bronze}
        for sv in self.silver:
            if sv.upstream_bronze not in bronze_source_refs:
                raise ValueError(
                    f"SilverMaterializedView {sv.name!r} points at unknown "
                    f"upstream_bronze {sv.upstream_bronze!r}",
                )

        # Gold.upstream_silver_refs must point at existing silver views
        for g in self.gold:
            missing = set(g.upstream_silver_refs) - silver_names
            if missing:
                raise ValueError(
                    f"GoldStreamContract {g.name!r} references unknown silver "
                    f"views: {sorted(missing)}",
                )

        return self
