/**
 * Casino Analytics — notebook cell bodies.
 *
 * Split out of `app-casino-analytics.ts` so that bundle stays under the
 * monolith-creep ratchet (scripts/ci/check-file-size.mjs, 1500 LOC). This module
 * holds ONLY the Python cell sources for the two starter notebooks; the bundle
 * next door owns the warehouse DDL, dbt models, starter queries, seed rows and
 * the item manifest.
 *
 * #4093 — these cells originally carried the upstream Databricks source
 * verbatim and read `silver.slv_slot_events` / `silver.slv_fnb_transactions`,
 * tables the bundle never creates, so they failed on the first Run. They are
 * now written against the star schema the bundle actually provisions and seeds
 * (casino.dim_player / dim_table / dim_date / fact_session / fact_handle),
 * read from the Synapse dedicated SQL pool with `spark.read.synapsesql`.
 *
 * The seed is deliberately small (24 rows), so every analysis degrades
 * gracefully at that scale rather than throwing or emitting a hollow result:
 * RFM uses rank percentiles instead of `pd.qcut` (which raises on tied/small
 * samples), the KMeans k sweep is bounded by the machine count, and each model
 * cross-validates and prints the row count rather than reporting an in-sample
 * fit as though it generalised.
 *
 * Not registered in `index.ts` — it is a helper module, not a bundle.
 */

// ─── Notebook cells ─────────────────────────────────────────────────────
// Source: examples/casino-analytics/notebooks/player_value_analysis.py
// Split into logical cells along the original `# COMMAND ----------` markers.

export const PVA_INTRO_MD = `# Player Value Analysis

Player analytics over the **casino star schema this app installs** — no silver
layer to build first, no Microsoft Fabric, no external dataset.

| Source table | Grain |
|---|---|
| casino.dim_player | one row per player (SCD2, current) |
| casino.dim_table | one row per machine / table game |
| casino.dim_date | one row per gaming day |
| casino.fact_session | one row per rated play session |
| casino.fact_handle | one row per handle event (spin, jackpot, cash-in, hand-pay) |

What the cells below produce:

- **RFM scoring and segmentation** — VIP / Loyal / Regular / New / At Risk / Lost
- **Churn-risk scorecard** — risk band, 0-100 risk score, value at risk
- **Comp efficiency and ADT** per player, plus annualised LTV when the observed
  window is long enough to project one honestly
- **A churn classifier** (LogReg / RandomForest / GBM) whose validation basis is
  chosen by the sample size and printed with the row count, so an in-sample fit
  is never mistaken for a generalisation estimate

The warehouse is an Azure Synapse **dedicated SQL pool**, so its tables are not
in the Spark metastore. Cells read them with the Azure Synapse Dedicated SQL
Pool Connector for Apache Spark (spark.read.synapsesql) — a default library in
every Synapse workspace, authenticated with Microsoft Entra ID pass-through.

> All seed data is **entirely synthetic** — no real player data is included.
`;

// Shared preface for BOTH notebooks: resolve the dedicated SQL pool, define the
// warehouse reader, and define the best-effort MLflow logger. Authored once and
// concatenated INTO each notebook's setup cell — a notebook cannot import from a
// sibling notebook, so this is inlined rather than referenced.
export const NB_WAREHOUSE_PREFACE = `# The Casino Data Warehouse this app installs is an Azure Synapse DEDICATED SQL
# pool (T-SQL), not a Spark database, so its tables are NOT visible to
# spark.table(). They are read with the Azure Synapse Dedicated SQL Pool
# Connector for Apache Spark:
#     spark.read.synapsesql("<pool>.<schema>.<table>")
# which ships as a default library in every Synapse workspace and authenticates
# with Microsoft Entra ID credential pass-through - no connection string, no
# secret, no Fabric.
# https://learn.microsoft.com/azure/synapse-analytics/spark/synapse-spark-sql-pool-import-export
import os
from decimal import Decimal

import numpy as np
import pandas as pd

if "loom_get_arg" not in globals():   # backend-util shim cell not run yet
    def loom_get_arg(name, default=None):
        return os.environ.get(name.upper(), default)

# Loom substitutes the pool name at install time from LOOM_SYNAPSE_DEDICATED_POOL.
# A notebook parameter or a spark.conf value wins, so the same notebook can be
# pointed at a different pool without editing it.
WAREHOUSE_DB = (
    loom_get_arg("warehouse_db")
    or spark.conf.get("spark.loom.warehouseDb", "")
    or "{{SYNAPSE_DEDICATED_POOL}}"
)
WAREHOUSE_SCHEMA = "casino"

if not WAREHOUSE_DB or "{{" in WAREHOUSE_DB:
    raise RuntimeError(
        "The dedicated SQL pool name did not resolve (got %r). Loom fills this "
        "in at install time from LOOM_SYNAPSE_DEDICATED_POOL; to override, pass "
        "the notebook parameter warehouse_db or set spark.loom.warehouseDb."
        % (WAREHOUSE_DB,)
    )


def read_warehouse(table):
    """Read one casino.<table> from the dedicated SQL pool into a pandas frame.

    Raises with what was actually OBSERVED plus the exact grant to apply. Never
    substitutes a fabricated or empty stand-in frame, and treats a zero-row read
    as a finding rather than a pass.
    """
    three_part = "%s.%s.%s" % (WAREHOUSE_DB, WAREHOUSE_SCHEMA, table)
    try:
        pdf = spark.read.synapsesql(three_part).toPandas()
    except Exception as exc:
        raise RuntimeError(
            "Could not read %s. Observed: %s. If that is an authorization "
            "failure, grant the Spark identity read access on the pool - "
            "EXEC sp_addrolemember 'db_exporter', [<spark-identity>]; - run "
            "against the %s database." % (three_part, exc, WAREHOUSE_DB)
        ) from exc
    # DECIMAL columns arrive as Python Decimal objects in an object-dtype column;
    # numpy and scikit-learn cannot do arithmetic on those, so coerce to float.
    for col in pdf.columns:
        if pdf[col].dtype == "object":
            nonnull = pdf[col].dropna()
            if len(nonnull) and isinstance(nonnull.iloc[0], Decimal):
                pdf[col] = pd.to_numeric(pdf[col], errors="coerce")
    if len(pdf) == 0:
        raise RuntimeError(
            "%s returned 0 rows. The app install seeds this table, so an empty "
            "read means the seed step did not run or was rolled back. Reinstall "
            "the Casino Analytics app rather than analysing an empty warehouse."
            % three_part
        )
    print("  %-16s %6d rows" % (table, len(pdf)))
    return pdf


def _mlflow_log(experiment, run_name, metrics):
    """Log metrics to MLflow when the runtime provides one.

    Synapse Spark pools do not ship an MLflow tracking server, so this is
    best-effort BY DESIGN: a missing or unreachable MLflow never breaks the run,
    and the cell says so rather than failing silently.
    """
    try:
        import mlflow
    except ImportError:
        return False
    try:
        mlflow.set_experiment(experiment)
        with mlflow.start_run(run_name=run_name):
            for key, value in metrics.items():
                mlflow.log_metric(key, float(value))
        return True
    except Exception as exc:
        print("  (MLflow logging unavailable: %s)" % exc)
        return False
`;

export const PVA_SETUP = `# Setup - resolve the warehouse and define the reader every cell below uses.
${NB_WAREHOUSE_PREFACE}
MLFLOW_EXPERIMENT = "/Casino/player_value_analysis"

print("Warehouse: %s.%s" % (WAREHOUSE_DB, WAREHOUSE_SCHEMA))
`;

export const PVA_LOAD = `# Load the star schema and denormalise it onto the grains the analyses need.
print("Loading casino star schema:")
dim_player = read_warehouse("dim_player")
dim_table = read_warehouse("dim_table")
dim_date = read_warehouse("dim_date")
fact_session = read_warehouse("fact_session")
fact_handle = read_warehouse("fact_handle")

dim_player["last_visit_date"] = pd.to_datetime(dim_player["last_visit_date"])
dim_date["full_date"] = pd.to_datetime(dim_date["full_date"])
fact_session["session_start"] = pd.to_datetime(fact_session["session_start"])
fact_handle["event_ts"] = pd.to_datetime(fact_handle["event_ts"])

# Session grain plus the player / table / date attributes the analyses read.
# floor_zone and denomination live on more than one table - take them from the
# fact so the joins stay free of _x/_y suffixes.
sessions = (
    fact_session
    .merge(
        dim_player[["player_sk", "player_id", "player_last_name", "tier",
                    "lifetime_adt", "last_visit_date", "self_excluded",
                    "do_not_market"]],
        on="player_sk", how="left")
    .merge(
        dim_table[["table_sk", "table_id", "table_type", "game_theme",
                   "target_hold_pct"]],
        on="table_sk", how="left")
    .merge(
        dim_date[["date_sk", "full_date", "is_weekend", "day_name"]],
        on="date_sk", how="left")
)

# Handle grain - event-level play, attributed to a player where the play is rated.
handles = fact_handle.merge(
    dim_player[["player_sk", "player_id", "tier"]], on="player_sk", how="left")

print("")
print("Sessions:      %d rows / %d players / %d gaming days"
      % (len(sessions), sessions["player_id"].nunique(),
         sessions["date_sk"].nunique()))
print("Handle events: %d rows / %d event types (%s)"
      % (len(handles), handles["event_type"].nunique(),
         ", ".join(sorted(handles["event_type"].unique()))))
print("Players:       %d across tiers %s"
      % (len(dim_player), ", ".join(sorted(dim_player["tier"].unique()))))
`;

export const PVA_RFM = `# RFM - Recency / Frequency / Monetary scoring and segmentation.
#
# Scores are RANK-PERCENTILE based rather than pd.qcut: qcut raises or collapses
# to a single bin on small or heavily tied samples, which is exactly what a
# freshly seeded warehouse looks like. Rank percentiles are well defined at any
# row count, from one player to millions.

RFM_BINS = 5
LTV_MIN_WINDOW_DAYS = 30   # below this an annualised projection is not honest


def rfm_score(series, higher_is_better=True, bins=RFM_BINS):
    """Score a measure into 1..bins by rank percentile. Safe at any sample size."""
    pct = series.rank(pct=True, ascending=higher_is_better, method="average")
    return np.ceil(pct * bins).clip(lower=1, upper=bins).astype(int)


def compute_rfm(sessions, handles, players):
    # As-of date = the day after the latest signal in the warehouse, so recency
    # is measured against the DATA rather than against wall-clock today (which
    # would drift the whole analysis as the seeded warehouse ages).
    as_of = max(sessions["full_date"].max(),
                players["last_visit_date"].max()) + pd.Timedelta(days=1)
    window_days = max((as_of - sessions["full_date"].min()).days, 1)

    gaming = (
        sessions.groupby("player_id")
        .agg(rated_sessions=("session_id", "count"),
             visit_days=("date_sk", "nunique"),
             coin_in=("coin_in", "sum"),
             coin_out=("coin_out", "sum"),
             theoretical_win=("theoretical_win", "sum"),
             actual_win=("actual_win", "sum"),
             comp_value=("comp_value", "sum"),
             avg_bet=("avg_bet", "mean"),
             avg_session_minutes=("duration_minutes", "mean"),
             game_variety=("game_type", "nunique"),
             zones_played=("floor_zone", "nunique"))
        .reset_index()
    )

    # Every tracked handle event evidences depth of play, so it counts toward
    # Frequency alongside the rated session itself.
    events = (
        handles.dropna(subset=["player_id"])
        .groupby("player_id")
        .agg(handle_events=("event_id", "count"),
             jackpots=("jackpot_amount", lambda s: int(s.notna().sum())),
             cash_in_amount=("coin_in_amount", "sum"))
        .reset_index()
    )

    rfm = (
        players[["player_id", "player_last_name", "tier", "lifetime_adt",
                 "last_visit_date", "self_excluded", "do_not_market"]]
        .merge(gaming, on="player_id", how="left")
        .merge(events, on="player_id", how="left")
    )
    measures = ["rated_sessions", "visit_days", "coin_in", "coin_out",
                "theoretical_win", "actual_win", "comp_value", "avg_bet",
                "avg_session_minutes", "game_variety", "zones_played",
                "handle_events", "jackpots", "cash_in_amount"]
    rfm[measures] = rfm[measures].fillna(0)

    rfm["recency_days"] = (as_of - rfm["last_visit_date"]).dt.days
    rfm["frequency"] = rfm["rated_sessions"] + rfm["handle_events"]

    rfm["r_score"] = rfm_score(rfm["recency_days"], higher_is_better=False)
    rfm["f_score"] = rfm_score(rfm["frequency"])
    rfm["m_score"] = rfm_score(rfm["coin_in"])
    rfm["rfm_score"] = rfm["r_score"] * 100 + rfm["f_score"] * 10 + rfm["m_score"]

    def segment(row):
        r, f, m = row["r_score"], row["f_score"], row["m_score"]
        if r >= 4 and f >= 4 and m >= 4:
            return "VIP"
        if r >= 3 and f >= 3:
            return "Loyal"
        if r >= 4 and f <= 2:
            return "New"
        if r <= 2 and f >= 3:
            return "At Risk"
        if r <= 2 and f <= 2:
            return "Lost"
        return "Regular"

    rfm["segment"] = rfm.apply(segment, axis=1)

    # ADT (average daily theoretical) and comp efficiency - the two numbers a
    # player-development host actually works from. Comps should stay under ~40%
    # of theoretical win.
    rfm["observed_adt"] = (rfm["theoretical_win"] /
                           rfm["visit_days"].replace(0, np.nan)).round(2)
    rfm["comp_efficiency_pct"] = (
        100.0 * rfm["comp_value"] / rfm["theoretical_win"].replace(0, np.nan)
    ).round(1)

    # Annualised LTV is projected ONLY when the observed window can support it.
    # Extrapolating a full year from a few days of play would be a made-up number.
    projected = window_days >= LTV_MIN_WINDOW_DAYS
    if projected:
        rfm["projected_visits_per_year"] = (
            rfm["visit_days"] * 365.0 / window_days).round(1)
        rfm["projected_annual_ltv"] = (
            rfm["observed_adt"] * rfm["projected_visits_per_year"]).round(2)

    meta = {"as_of": as_of, "window_days": window_days, "ltv_projected": projected}
    return rfm.sort_values("rfm_score", ascending=False).reset_index(drop=True), meta


player_rfm, rfm_meta = compute_rfm(sessions, handles, dim_player)

value_cols = ["observed_adt", "lifetime_adt", "comp_efficiency_pct"]
if rfm_meta["ltv_projected"]:
    value_cols += ["projected_visits_per_year", "projected_annual_ltv"]
else:
    print("NOTE: the warehouse holds %d day(s) of session history, below the "
          "%d-day minimum for an annualised LTV projection, so value is ranked "
          "on observed ADT and the dimension's maintained lifetime_adt rather "
          "than on a projected figure."
          % (rfm_meta["window_days"], LTV_MIN_WINDOW_DAYS))

print("Players scored: %d   (recency as-of %s)"
      % (len(player_rfm), rfm_meta["as_of"].date()))
print("")
print("Segment distribution:")
print(player_rfm["segment"].value_counts().to_string())
print("")
print(player_rfm[["player_id", "player_last_name", "tier", "segment",
                  "recency_days", "frequency", "coin_in", "theoretical_win"]
                 + value_cols + ["rfm_score"]].to_string(index=False))
`;

export const PVA_CHURN = `# Churn risk - a transparent scorecard first, then a classifier whose validation
# basis is chosen by the sample size and printed alongside the result.
#
# The scorecard is the deliverable that always holds: deterministic, explainable
# to a player-development host, and correct at any row count.
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import LeaveOneOut, cross_val_predict, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CHURN_DAYS = 30             # dbt var churn_medium_risk_days
CHURN_HIGH_RISK_DAYS = 45   # dbt var churn_high_risk_days
MIN_ROWS_FOR_HOLDOUT = 30   # below this a hold-out split is not informative
MIN_ROWS_FOR_LOOCV = 5      # below this not even leave-one-out is meaningful


def churn_scorecard(rfm):
    df = rfm.copy()
    df["is_churn_risk"] = (df["recency_days"] > CHURN_DAYS).astype(int)
    df["risk_band"] = pd.cut(
        df["recency_days"],
        bins=[-1, 14, CHURN_DAYS, CHURN_HIGH_RISK_DAYS, 90, 10 ** 6],
        labels=["ACTIVE", "WATCH", "AT_RISK", "HIGH_RISK", "LAPSED"],
    ).astype(str)
    # r/f/m are already 1..5; invert the weighted sum into a 0-100 risk score.
    df["churn_risk_score"] = (
        100 - (df["r_score"] * 12 + df["f_score"] * 5 + df["m_score"] * 3)
    ).clip(lower=0, upper=100)
    # What walks out of the door if they do not come back.
    df["value_at_risk"] = df["lifetime_adt"].fillna(0).round(2)
    df["contactable"] = ~(df["self_excluded"].astype(bool)
                          | df["do_not_market"].astype(bool))
    return df.sort_values(["churn_risk_score", "value_at_risk"],
                          ascending=[False, False]).reset_index(drop=True)


def churn_classifier(scored):
    """Fit LogReg / RandomForest / GBM on BEHAVIOURAL features.

    recency_days DEFINES the label, so it is excluded from the feature set -
    feeding it back in would leak the label and return a meaningless perfect
    score.
    """
    features = ["frequency", "rated_sessions", "visit_days", "coin_in",
                "theoretical_win", "actual_win", "comp_value", "avg_bet",
                "avg_session_minutes", "game_variety", "zones_played",
                "handle_events"]
    X = scored[features].fillna(0).astype(float)
    y = scored["is_churn_risk"].astype(int)
    n = len(X)
    balance = y.value_counts().to_dict()
    print("Churn model input: %d players, %d behavioural features, "
          "class balance %s" % (n, len(features), balance))

    if y.nunique() < 2:
        print("SKIPPED: every player falls in the same class, so there is "
              "nothing to separate. The scorecard above is the churn output "
              "for this warehouse.")
        return None

    # Validation strategy by sample size. Every branch reports a number that is
    # TRUE of what it measured, and says which it is.
    min_class = min(balance.values())
    if n >= MIN_ROWS_FOR_HOLDOUT and min_class >= 2:
        mode = "holdout"
        X_tr, X_te, y_tr, y_te = train_test_split(
            X, y, test_size=0.25, stratify=y, random_state=42)
        basis = "stratified hold-out (%d train / %d test)" % (len(X_tr), len(X_te))
    elif n >= MIN_ROWS_FOR_LOOCV and min_class >= 2:
        mode = "loocv"
        basis = ("leave-one-out cross-validation over all %d rows - below the "
                 "%d-row hold-out minimum, so every prediction below comes from "
                 "a model that never saw that player. A real generalisation "
                 "estimate, not an in-sample fit." % (n, MIN_ROWS_FOR_HOLDOUT))
    else:
        mode = "insample"
        basis = ("IN-SAMPLE on all %d rows - too few rows, or too few in one "
                 "class, for any hold-out or cross-validated estimate, so these "
                 "figures describe the FIT, not generalisation" % n)
    print("Validation basis: %s" % basis)

    results = {}
    for name, model in (
        ("logreg", LogisticRegression(max_iter=1000, random_state=42)),
        ("rf", RandomForestClassifier(n_estimators=200, max_depth=6, random_state=42)),
        ("gbm", GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=42)),
    ):
        # Scaling inside the pipeline so it is re-fit per CV fold rather than
        # leaking the held-out row's statistics into training.
        pipe = make_pipeline(StandardScaler(), model)
        if mode == "holdout":
            pipe.fit(X_tr, y_tr)
            truth, pred = y_te, pipe.predict(X_te)
            prob = pipe.predict_proba(X_te)[:, 1]
        elif mode == "loocv":
            cv = LeaveOneOut()
            truth = y
            pred = cross_val_predict(pipe, X, y, cv=cv)
            prob = cross_val_predict(pipe, X, y, cv=cv, method="predict_proba")[:, 1]
        else:
            pipe.fit(X, y)
            truth, pred = y, pipe.predict(X)
            prob = pipe.predict_proba(X)[:, 1]
        f1 = f1_score(truth, pred, zero_division=0)
        try:
            auc = roc_auc_score(truth, prob)
        except ValueError:
            auc = float("nan")   # a single-class evaluation set has no AUC
        pipe.fit(X, y)           # final model sees everything, for scoring new players
        results[name] = {"model": pipe, "f1": f1, "auc": auc, "basis": mode}
        print("  %-7s F1=%.3f  AUC=%.3f" % (name, f1, auc))
        _mlflow_log(MLFLOW_EXPERIMENT, "churn_%s" % name,
                    {"f1": f1, "auc": auc, "rows": n})
    return results


churn_scored = churn_scorecard(player_rfm)
print("Churn-risk scorecard (highest risk first):")
print(churn_scored[["player_id", "player_last_name", "tier", "risk_band",
                    "recency_days", "churn_risk_score", "value_at_risk",
                    "contactable"]].to_string(index=False))
print("")
print("Risk-band distribution:")
print(churn_scored["risk_band"].value_counts().to_string())
print("")
churn_models = churn_classifier(churn_scored)
`;

export const PVA_SAVE = `# Persist the RFM segments and the churn scorecard as Delta tables in a Spark
# database, so downstream notebooks, the SQL endpoint, and the floor-operations
# dashboard can read them. The warehouse itself is a dedicated SQL pool, which
# needs a staging grant to write into, so outputs land in the Spark catalog.

GOLD_DB = loom_get_arg("gold_db") or spark.conf.get("spark.loom.goldDb", "casino_gold")
spark.sql("CREATE DATABASE IF NOT EXISTS %s" % GOLD_DB)

analysis_date = pd.Timestamp.today().normalize()


def save_gold(pdf, table, columns):
    out = pdf[[c for c in columns if c in pdf.columns]].copy()
    for col in out.columns:
        if str(out[col].dtype) == "category":
            out[col] = out[col].astype(str)
    out["analysis_date"] = analysis_date
    full_name = "%s.%s" % (GOLD_DB, table)
    try:
        (spark.createDataFrame(out)
            .write.mode("overwrite").option("overwriteSchema", "true")
            .format("delta").saveAsTable(full_name))
    except Exception as exc:
        raise RuntimeError(
            "Could not write %s. Observed: %s. If that is an authorization "
            "failure, grant the Spark identity Storage Blob Data Contributor on "
            "the Synapse workspace's primary ADLS Gen2 account."
            % (full_name, exc)) from exc
    # Verify by reading back rather than assuming the write landed.
    written = spark.table(full_name).count()
    if written == 0:
        raise RuntimeError("%s wrote 0 rows - the save did not land." % full_name)
    print("  %-40s %d rows" % (full_name, written))
    return written


print("Writing gold outputs:")
save_gold(player_rfm, "gld_player_rfm_segments",
          ["player_id", "player_last_name", "tier", "segment", "rfm_score",
           "r_score", "f_score", "m_score", "recency_days", "frequency",
           "rated_sessions", "visit_days", "coin_in", "coin_out",
           "theoretical_win", "actual_win", "comp_value", "observed_adt",
           "lifetime_adt", "comp_efficiency_pct", "projected_visits_per_year",
           "projected_annual_ltv"])
save_gold(churn_scored, "gld_player_churn_risk",
          ["player_id", "player_last_name", "tier", "segment", "risk_band",
           "is_churn_risk", "churn_risk_score", "recency_days",
           "value_at_risk", "contactable"])

print("")
print("Outputs:")
print("  %s.gld_player_rfm_segments" % GOLD_DB)
print("  %s.gld_player_churn_risk" % GOLD_DB)
print("  MLflow experiment (when the runtime provides one): %s" % MLFLOW_EXPERIMENT)
`;

// Floor optimization notebook cells.
export const FLR_INTRO_MD = `# Casino Floor Optimization

Floor and slot analytics over the **casino star schema this app installs** — no
silver layer to build first, no Microsoft Fabric, no external dataset.

| Source table | Used for |
|---|---|
| casino.dim_table | machine / table inventory, floor zone, target hold, par-sheet RTP |
| casino.fact_session | rated play per machine: coin-in, coin-out, theo and actual win |
| casino.fact_handle | event-level play: spins, jackpots, hand pays, Title 31 triggers |
| casino.dim_date | gaming-day calendar |

What the cells below produce:

- **Machine performance ranking** — revenue, actual hold vs target, actual RTP
- **Zone optimisation** — revenue density, an optimisation score (0-100), and a
  recommendation per zone: ADD_MACHINES / REMOVE_MACHINES /
  CHANGE_DENOMINATION_MIX / REVIEW_PAR_SHEETS / MONITOR
- **A GBM revenue model** whose validation basis is chosen by the sample size
  and printed with the machine count
- **KMeans clustering** of machines by performance profile, with k swept only
  over the range the sample actually supports

The warehouse is an Azure Synapse **dedicated SQL pool**, so cells read it with
spark.read.synapsesql — the Synapse dedicated-pool connector, a default library
in every Synapse workspace.

> All seed data is **entirely synthetic**.
`;

export const FLR_SETUP = `# Setup - resolve the warehouse and define the reader every cell below uses.
${NB_WAREHOUSE_PREFACE}
MLFLOW_EXPERIMENT = "/Casino/floor_optimization"

print("Warehouse: %s.%s" % (WAREHOUSE_DB, WAREHOUSE_SCHEMA))
`;

export const FLR_LOAD = `# Load the machine inventory and both play facts.
print("Loading casino star schema:")
dim_table = read_warehouse("dim_table")
dim_date = read_warehouse("dim_date")
fact_session = read_warehouse("fact_session")
fact_handle = read_warehouse("fact_handle")

dim_date["full_date"] = pd.to_datetime(dim_date["full_date"])
fact_session["session_start"] = pd.to_datetime(fact_session["session_start"])
fact_handle["event_ts"] = pd.to_datetime(fact_handle["event_ts"])

sessions = fact_session.merge(
    dim_date[["date_sk", "full_date", "is_weekend", "day_name"]],
    on="date_sk", how="left")
handles = fact_handle.merge(
    dim_date[["date_sk", "full_date", "is_weekend"]], on="date_sk", how="left")

print("")
print("Machines / tables: %d across zones %s"
      % (len(dim_table), ", ".join(sorted(dim_table["floor_zone"].unique()))))
print("Rated sessions:    %d over %d gaming days"
      % (len(sessions), sessions["date_sk"].nunique()))
print("Handle events:     %d (%s)"
      % (len(handles), ", ".join(sorted(handles["event_type"].unique()))))
`;

export const FLR_PERF = `# Machine performance - revenue, actual hold vs target, and actual RTP per
# machine. dim_table is the LEFT side so a machine with no play in the window
# still appears (at zero) instead of silently vanishing from the ranking.

def machine_performance(tables, sessions, handles):
    per_session = (
        sessions.groupby("table_sk")
        .agg(rated_sessions=("session_id", "count"),
             unique_players=("player_sk", "nunique"),
             active_days=("date_sk", "nunique"),
             coin_in=("coin_in", "sum"),
             coin_out=("coin_out", "sum"),
             theoretical_win=("theoretical_win", "sum"),
             actual_win=("actual_win", "sum"),
             comp_value=("comp_value", "sum"),
             avg_session_minutes=("duration_minutes", "mean"))
        .reset_index()
    )
    per_event = (
        handles.groupby("table_sk")
        .agg(handle_events=("event_id", "count"),
             jackpot_events=("jackpot_amount", lambda s: int(s.notna().sum())),
             jackpot_amount=("jackpot_amount", "sum"),
             hand_pay_amount=("hand_pay_amount", "sum"),
             ctr_events=("ctr_trigger", lambda s: int(s.astype(bool).sum())),
             avg_rtp_contribution=("rtp_contribution", "mean"))
        .reset_index()
    )
    spins = handles[handles["event_type"] == "SPIN"]
    per_spin = (
        spins.groupby("table_sk")
        .agg(total_spins=("event_id", "count"),
             credits_wagered=("credits_wagered", "sum"),
             credits_won=("credits_won", "sum"))
        .reset_index()
    )

    perf = (
        tables[["table_sk", "table_id", "table_type", "game_theme", "floor_zone",
                "denomination", "target_hold_pct", "par_sheet_rtp_pct",
                "is_active"]]
        .merge(per_session, on="table_sk", how="left")
        .merge(per_event, on="table_sk", how="left")
        .merge(per_spin, on="table_sk", how="left")
    )
    measures = ["rated_sessions", "unique_players", "active_days", "coin_in",
                "coin_out", "theoretical_win", "actual_win", "comp_value",
                "avg_session_minutes", "handle_events", "jackpot_events",
                "jackpot_amount", "hand_pay_amount", "ctr_events",
                "total_spins", "credits_wagered", "credits_won"]
    perf[measures] = perf[measures].fillna(0)

    perf["revenue"] = (perf["coin_in"] - perf["coin_out"]).round(2)
    perf["actual_hold_pct"] = np.where(
        perf["coin_in"] > 0,
        100.0 * (perf["coin_in"] - perf["coin_out"]) / perf["coin_in"],
        0.0).round(2)
    perf["hold_variance_pct"] = (perf["actual_hold_pct"]
                                 - perf["target_hold_pct"]).round(2)
    perf["actual_rtp_pct"] = np.where(
        perf["credits_wagered"] > 0,
        100.0 * perf["credits_won"] / perf["credits_wagered"],
        np.nan).round(2)
    perf["revenue_per_day"] = np.where(
        perf["active_days"] > 0, perf["revenue"] / perf["active_days"],
        0.0).round(2)
    perf["hold_status"] = np.where(
        perf["hold_variance_pct"].abs() <= 1.0, "ON_TARGET",
        np.where(perf["hold_variance_pct"] > 1.0, "ABOVE_TARGET",
                 "BELOW_TARGET"))
    return perf.sort_values("revenue", ascending=False).reset_index(drop=True)


machine_perf = machine_performance(dim_table, sessions, handles)

print("Machine performance (%d machines, highest revenue first):"
      % len(machine_perf))
print(machine_perf[["table_id", "table_type", "game_theme", "floor_zone",
                    "denomination", "rated_sessions", "total_spins",
                    "coin_in", "coin_out", "revenue", "actual_hold_pct",
                    "target_hold_pct", "hold_variance_pct", "actual_rtp_pct",
                    "hold_status"]].to_string(index=False))
print("")
print("Hold status distribution:")
print(pd.Series(machine_perf["hold_status"]).value_counts().to_string())
`;

export const FLR_ZONE = `# Zone optimisation - the rollup a floor manager acts on. Mirrors the
# gld_floor_optimization dbt model: a 0-100 composite of revenue density (40),
# utilisation (30), and hold accuracy (20), plus a recommendation per zone.

def zone_optimization(perf):
    zone = (
        perf.groupby("floor_zone")
        .agg(machines=("table_sk", "count"),
             active_days=("active_days", "max"),
             unique_players=("unique_players", "sum"),
             rated_sessions=("rated_sessions", "sum"),
             coin_in=("coin_in", "sum"),
             coin_out=("coin_out", "sum"),
             revenue=("revenue", "sum"),
             theoretical_win=("theoretical_win", "sum"),
             avg_session_minutes=("avg_session_minutes", "mean"),
             target_hold_pct=("target_hold_pct", "mean"),
             jackpot_events=("jackpot_events", "sum"),
             ctr_events=("ctr_events", "sum"))
        .reset_index()
    )
    zone["actual_hold_pct"] = np.where(
        zone["coin_in"] > 0,
        100.0 * (zone["coin_in"] - zone["coin_out"]) / zone["coin_in"],
        0.0).round(2)
    zone["hold_variance_pct"] = (zone["actual_hold_pct"]
                                 - zone["target_hold_pct"]).round(2)
    zone["revenue_per_machine_day"] = np.where(
        (zone["machines"] > 0) & (zone["active_days"] > 0),
        zone["revenue"] / (zone["machines"] * zone["active_days"]),
        0.0).round(2)

    revenue_points = np.clip(zone["revenue_per_machine_day"] / 50.0 * 40, 0, 40)
    utilisation_points = np.clip(zone["avg_session_minutes"] / 240.0 * 30, 0, 30)
    hold_points = np.select(
        [zone["hold_variance_pct"].abs() <= 0.5,
         zone["hold_variance_pct"].abs() <= 1.0,
         zone["hold_variance_pct"].abs() <= 2.0],
        [20, 15, 10], default=5)
    zone["optimization_score"] = (
        revenue_points + utilisation_points + hold_points).round(1)

    zone["recommendation"] = np.select(
        [(zone["revenue_per_machine_day"] < 20) & (zone["avg_session_minutes"] < 30),
         (zone["revenue_per_machine_day"] < 30) & (zone["avg_session_minutes"] > 120),
         (zone["revenue_per_machine_day"] > 80) & (zone["avg_session_minutes"] > 120),
         zone["hold_variance_pct"].abs() > 2.0],
        ["REMOVE_MACHINES", "CHANGE_DENOMINATION_MIX", "ADD_MACHINES",
         "REVIEW_PAR_SHEETS"],
        default="MONITOR")
    return zone.sort_values("optimization_score",
                            ascending=False).reset_index(drop=True)


zone_perf = zone_optimization(machine_perf)

print("Zone optimisation (%d zones, best score first):" % len(zone_perf))
print(zone_perf[["floor_zone", "machines", "rated_sessions", "unique_players",
                 "coin_in", "revenue", "revenue_per_machine_day",
                 "actual_hold_pct", "target_hold_pct", "hold_variance_pct",
                 "optimization_score", "recommendation"]].to_string(index=False))
print("")
print("Recommendations: %s"
      % pd.Series(zone_perf["recommendation"]).value_counts().to_dict())
print("Title 31 CTR-triggering events on the floor: %d"
      % int(zone_perf["ctr_events"].sum()))
`;

export const FLR_REV_MODEL = `# Revenue prediction - a GBM regressor over machine attributes. The validation
# basis follows the sample size and is printed with the result, so an in-sample
# fit is never mistaken for a generalisation estimate.
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import LeaveOneOut, cross_val_predict, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import LabelEncoder, StandardScaler

MIN_MACHINES_FOR_HOLDOUT = 25
MIN_MACHINES_FOR_LOOCV = 5


def predict_machine_revenue(perf):
    df = perf.copy()
    df["zone_encoded"] = LabelEncoder().fit_transform(df["floor_zone"].astype(str))
    df["type_encoded"] = LabelEncoder().fit_transform(df["table_type"].astype(str))
    features = ["total_spins", "handle_events", "rated_sessions",
                "unique_players", "coin_in", "avg_session_minutes",
                "denomination", "target_hold_pct", "zone_encoded",
                "type_encoded"]
    X = df[features].fillna(0).astype(float)
    y = df["revenue"].astype(float)
    n = len(X)
    print("Revenue model input: %d machines, %d features" % (n, len(features)))

    if n < 3:
        print("SKIPPED: %d machine(s) is too few to fit a regressor. The "
              "per-machine and per-zone rankings above are the floor output "
              "for this warehouse." % n)
        return None

    if n >= MIN_MACHINES_FOR_HOLDOUT:
        mode = "holdout"
        X_tr, X_te, y_tr, y_te = train_test_split(
            X, y, test_size=0.25, random_state=42)
        basis = "hold-out (%d train / %d test)" % (len(X_tr), len(X_te))
    elif n >= MIN_MACHINES_FOR_LOOCV:
        mode = "loocv"
        basis = ("leave-one-out cross-validation over all %d machines - below "
                 "the %d-machine hold-out minimum, so every prediction below "
                 "comes from a model that never saw that machine. A real "
                 "generalisation estimate, not an in-sample fit."
                 % (n, MIN_MACHINES_FOR_HOLDOUT))
    else:
        mode = "insample"
        basis = ("IN-SAMPLE on all %d machines - too few for any hold-out or "
                 "cross-validated estimate, so these figures describe the FIT, "
                 "not generalisation" % n)
    print("Validation basis: %s" % basis)

    # Scaling inside the pipeline so it is re-fit per CV fold rather than
    # leaking the held-out machine's statistics into training.
    pipe = make_pipeline(
        StandardScaler(),
        GradientBoostingRegressor(n_estimators=100, max_depth=3, random_state=42))
    if mode == "holdout":
        pipe.fit(X_tr, y_tr)
        truth, pred = y_te, pipe.predict(X_te)
    elif mode == "loocv":
        truth = y
        pred = cross_val_predict(pipe, X, y, cv=LeaveOneOut())
    else:
        pipe.fit(X, y)
        truth, pred = y, pipe.predict(X)
    mae = mean_absolute_error(truth, pred)
    r2 = r2_score(truth, pred) if len(truth) > 1 else float("nan")
    print("  MAE = %.2f   R2 = %.4f" % (mae, r2))
    if mode == "loocv" and r2 < 0:
        print("  A negative R2 under leave-one-out means the floor is still too "
              "small for the model to beat simply predicting the mean - expected "
              "at %d machines, and the honest read of this sample. It rises as "
              "real play accumulates; the per-machine and per-zone rankings "
              "above do not depend on it." % n)

    pipe.fit(X, y)   # final model sees every machine, for scoring new ones
    model = pipe.steps[-1][1]   # the fitted regressor at the end of the pipeline
    drivers = (pd.DataFrame({"feature": features,
                             "importance": model.feature_importances_})
               .sort_values("importance", ascending=False)
               .head(6).round(4))
    print("")
    print("Top revenue drivers (fitted on all %d machines):" % n)
    print(drivers.to_string(index=False))
    _mlflow_log(MLFLOW_EXPERIMENT, "floor_revenue_gbm",
                {"mae": mae, "r2": r2, "machines": n})
    return pipe


revenue_model = predict_machine_revenue(machine_perf)
`;

export const FLR_CLUSTER = `# Cluster machines by performance profile to find the optimisation groups.
#
# k is swept only over the range the SAMPLE supports: a silhouette score needs
# at least 2 clusters and at most n-1, so the upper bound is derived from the
# machine count rather than being a fixed literal that throws on a small floor.
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

MAX_CLUSTERS = 8


def cluster_machines(perf):
    cols = ["total_spins", "handle_events", "revenue", "actual_hold_pct",
            "hold_variance_pct", "denomination", "unique_players",
            "avg_session_minutes"]
    X = perf[cols].fillna(0).astype(float)
    n = len(X)
    k_max = min(MAX_CLUSTERS, n - 1)
    print("Clustering input: %d machines, %d features" % (n, len(cols)))

    if k_max < 2:
        print("SKIPPED: %d machine(s) supports no valid k - a silhouette score "
              "needs 2 <= k <= n-1. The per-machine and per-zone rankings above "
              "are the floor output for this warehouse." % n)
        perf["cluster"] = 0
        return perf, None

    X_scaled = StandardScaler().fit_transform(X)
    scores = {}
    for k in range(2, k_max + 1):
        labels = KMeans(n_clusters=k, random_state=42, n_init=10).fit_predict(X_scaled)
        scores[k] = round(float(silhouette_score(X_scaled, labels)), 3)
    best_k = max(scores, key=scores.get)
    print("  silhouette by k (2..%d): %s" % (k_max, scores))
    print("  best k = %d (silhouette %.3f)" % (best_k, scores[best_k]))

    perf["cluster"] = KMeans(n_clusters=best_k, random_state=42,
                             n_init=10).fit_predict(X_scaled)
    summary = (perf.groupby("cluster")
               .agg(machines=("table_id", "count"),
                    avg_revenue=("revenue", "mean"),
                    total_revenue=("revenue", "sum"),
                    avg_hold_variance=("hold_variance_pct", "mean"),
                    zones=("floor_zone", lambda s: ",".join(sorted(set(s)))))
               .round(2))
    print("")
    print(summary.to_string())
    _mlflow_log(MLFLOW_EXPERIMENT, "floor_kmeans",
                {"k": best_k, "silhouette": scores[best_k], "machines": n})
    return perf, summary


machine_perf, cluster_summary = cluster_machines(machine_perf)
`;

export const FLR_SAVE = `# Persist the machine and zone outputs as Delta tables in a Spark database for
# the floor-operations dashboard. The warehouse itself is a dedicated SQL pool,
# which needs a staging grant to write into, so outputs land in the Spark catalog.

GOLD_DB = loom_get_arg("gold_db") or spark.conf.get("spark.loom.goldDb", "casino_gold")
spark.sql("CREATE DATABASE IF NOT EXISTS %s" % GOLD_DB)

analysis_date = pd.Timestamp.today().normalize()


def save_gold(pdf, table, columns):
    out = pdf[[c for c in columns if c in pdf.columns]].copy()
    for col in out.columns:
        if str(out[col].dtype) == "category":
            out[col] = out[col].astype(str)
    out["analysis_date"] = analysis_date
    full_name = "%s.%s" % (GOLD_DB, table)
    try:
        (spark.createDataFrame(out)
            .write.mode("overwrite").option("overwriteSchema", "true")
            .format("delta").saveAsTable(full_name))
    except Exception as exc:
        raise RuntimeError(
            "Could not write %s. Observed: %s. If that is an authorization "
            "failure, grant the Spark identity Storage Blob Data Contributor on "
            "the Synapse workspace's primary ADLS Gen2 account."
            % (full_name, exc)) from exc
    # Verify by reading back rather than assuming the write landed.
    written = spark.table(full_name).count()
    if written == 0:
        raise RuntimeError("%s wrote 0 rows - the save did not land." % full_name)
    print("  %-44s %d rows" % (full_name, written))
    return written


print("Writing gold outputs:")
save_gold(machine_perf, "gld_machine_performance",
          ["table_id", "table_type", "game_theme", "floor_zone", "denomination",
           "rated_sessions", "unique_players", "active_days", "total_spins",
           "handle_events", "jackpot_events", "ctr_events", "coin_in",
           "coin_out", "revenue", "revenue_per_day", "theoretical_win",
           "actual_win", "actual_hold_pct", "target_hold_pct",
           "hold_variance_pct", "actual_rtp_pct", "par_sheet_rtp_pct",
           "hold_status", "cluster"])
save_gold(zone_perf, "gld_floor_zone_optimization",
          ["floor_zone", "machines", "rated_sessions", "unique_players",
           "coin_in", "coin_out", "revenue", "revenue_per_machine_day",
           "actual_hold_pct", "target_hold_pct", "hold_variance_pct",
           "jackpot_events", "ctr_events", "optimization_score",
           "recommendation"])

print("")
print("Outputs:")
print("  %s.gld_machine_performance" % GOLD_DB)
print("  %s.gld_floor_zone_optimization" % GOLD_DB)
print("  MLflow experiment (when the runtime provides one): %s" % MLFLOW_EXPERIMENT)
`;
