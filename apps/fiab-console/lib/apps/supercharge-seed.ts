/**
 * Supercharge medallion sample-data seeder (Azure-native, no Fabric).
 *
 * The Supercharge Bronze notebooks read their raw SOURCE from
 * `Files/output/<name>.parquet` (relative → the Livy home
 * `abfss://synapse@<adls>.dfs.core.windows.net/user/trusted-service-user/Files/...`).
 * On a fresh install those files do not exist and the medallion cannot flow —
 * this is the "sample data ingestion at install time" that was documented but
 * UNBUILT in lib/apps/content-bundles/types.ts.
 *
 * This module builds it for real:
 *   1. pre-creates the `lh_bronze` / `lh_silver` / `lh_gold` Spark databases
 *      (so bronze's `saveAsTable("lh_bronze.…")`, silver's read, gold's read
 *      all resolve), and
 *   2. generates small, deterministic SYNTHETIC source parquet for the core
 *      casino medallion sources — real Spark-written Delta-adjacent parquet
 *      matching each Bronze notebook's read schema, no mocks — so running
 *      Bronze populates lh_bronze, Silver reads it, Gold reads Silver.
 *
 * It executes as ONE pyspark statement on the same Synapse Spark pool the
 * notebooks run on (Livy), so the seeded Files/output/* and the lh_* databases
 * live exactly where the notebooks look. Wired into the app install worker
 * (post-provision, best-effort) and exposed as POST /api/apps/supercharge/seed.
 *
 * The seed source is delimited by SEED_PYSPARK_START / SEED_PYSPARK_END so the
 * task-#83 validation harness can extract and run the EXACT product seed.
 */
import {
  createLivySessionAsync,
  getLivySession,
  submitLivyStatement,
  getLivyStatement,
} from '@/lib/azure/synapse-dev-client';

/** App bundles whose Bronze notebooks read Files/output/* casino sources. */
export const SUPERCHARGE_MEDALLION_APPS = new Set<string>([
  'app-supercharge-bronze',
  'app-supercharge-silver',
  'app-supercharge-gold',
  'app-supercharge-ml',
]);

/** Does this app id want the casino-medallion sample-data seed? */
export function appWantsSuperchargeSeed(appId: string): boolean {
  return SUPERCHARGE_MEDALLION_APPS.has(appId);
}

/* SEED_PYSPARK_START */
export const SUPERCHARGE_SEED_PYSPARK = String.raw`# Loom supercharge medallion seed — Azure-native (Synapse Spark / ADLS Gen2).
# Creates the lh_bronze/lh_silver/lh_gold databases and lands synthetic Bronze
# SOURCE parquet under Files/output/ so the medallion (bronze->silver->gold) flows.
from pyspark.sql import functions as F

print("== Loom supercharge seed ==")
# The Livy session is created with fs.azure.createRemoteFileSystemDuringInitialization
# =true (see createLivySessionAsync), so the workspace default filesystem + Hive
# warehouse container exists and managed-table catalog ops resolve. Create the
# medallion databases under the default warehouse (idempotent).
for _db in ("lh_bronze", "lh_silver", "lh_gold"):
    spark.sql(f"CREATE DATABASE IF NOT EXISTS {_db}")
    print("  database ready:", _db)

_N = 600
_b = spark.range(_N)

def _ts(colid):
    # Deterministic PAST timestamps spread over ~5 days (portable — no interval fns,
    # and strictly < now so Silver's future-event filter keeps every row).
    return (F.current_timestamp().cast("long")
            - (colid % F.lit(5)) * F.lit(86400)
            - (colid % F.lit(24)) * F.lit(3600)
            - (colid % F.lit(60)) * F.lit(60)).cast("timestamp")

def _pick(colid, values):
    arr = F.array(*[F.lit(v) for v in values])
    return F.element_at(arr, (colid % F.lit(len(values))).cast("int") + F.lit(1))

def _write(df, name):
    path = f"Files/output/{name}.parquet"
    df.drop("id").write.mode("overwrite").parquet(path)
    print("  seeded:", path, "rows=", df.count())

# ---- 1) slot telemetry (bronze_slot_telemetry) ----
_zones = ["North", "South", "East", "West", "VIP", "High Limit", "Penny"]
_etypes = ["GAME_PLAY", "JACKPOT", "METER_UPDATE", "DOOR_OPEN", "BILL_IN", "TICKET_OUT"]
_mans = ["IGT", "Aristocrat", "Scientific Games", "Konami", "Everi"]
_mtypes = ["Video Slot", "Reel Slot", "Video Poker"]
_denoms = [0.01, 0.05, 0.25, 0.50, 1.00, 2.00, 5.00]
slot = (_b
  .withColumn("event_id", F.concat(F.lit("slot-evt-"), F.col("id").cast("string")))
  .withColumn("machine_id", F.concat(F.lit("SLOT-"), (F.col("id") % F.lit(50)).cast("string")))
  .withColumn("asset_number", F.concat(F.lit("AST-"), (F.col("id") % F.lit(50)).cast("string")))
  .withColumn("location_id", F.lit("CASINO-FLOOR-1"))
  .withColumn("zone", _pick(F.col("id"), _zones))
  .withColumn("event_type", _pick(F.col("id"), _etypes))
  .withColumn("event_timestamp", _ts(F.col("id")))
  .withColumn("denomination", _pick(F.col("id"), _denoms).cast("double"))
  .withColumn("coin_in", F.round(F.rand(1) * F.lit(1000), 2))
  .withColumn("coin_out", F.round(F.rand(2) * F.lit(850), 2))
  .withColumn("jackpot_amount", F.when(F.col("event_type") == F.lit("JACKPOT"), F.round(F.rand(3) * F.lit(5000), 2)).otherwise(F.lit(0.0)))
  .withColumn("games_played", (F.rand(4) * F.lit(200)).cast("int"))
  .withColumn("theoretical_hold", F.lit(0.08))
  .withColumn("actual_hold", F.round(F.rand(5) * F.lit(0.15), 4))
  .withColumn("player_id", F.concat(F.lit("PLAYER-"), (F.col("id") % F.lit(200)).cast("string")))
  .withColumn("session_id", F.concat(F.lit("SESS-"), (F.col("id") % F.lit(300)).cast("string")))
  .withColumn("machine_type", _pick(F.col("id"), _mtypes))
  .withColumn("manufacturer", _pick(F.col("id"), _mans))
  .withColumn("game_theme", F.lit("Classic"))
  .withColumn("error_code", F.lit(None).cast("string"))
  .withColumn("error_message", F.lit(None).cast("string"))
  .withColumn("_ingested_at", F.current_timestamp().cast("string"))
  .withColumn("_source", F.lit("loom-seed"))
  .withColumn("_batch_id", F.lit("seed")))
_write(slot, "bronze_slot_telemetry")

# ---- 2) player profile (bronze_player_profile) ----
_tiers = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"]
_states = ["NV", "NJ", "CA", "AZ", "FL", "NY"]
player = (_b
  .withColumn("player_id", F.concat(F.lit("PLAYER-"), (F.col("id") % F.lit(200)).cast("string")))
  .withColumn("first_name", F.concat(F.lit("First"), F.col("id").cast("string")))
  .withColumn("last_name", F.concat(F.lit("Last"), F.col("id").cast("string")))
  .withColumn("date_of_birth", F.lit("1980-01-01"))
  .withColumn("gender", _pick(F.col("id"), ["M", "F", "X"]))
  .withColumn("email", F.concat(F.lit("player"), F.col("id").cast("string"), F.lit("@example.com")))
  .withColumn("phone", F.concat(F.lit("+1555"), F.lpad((F.col("id") % F.lit(10000)).cast("string"), 4, "0")))
  .withColumn("address", F.concat(F.lit("100"), F.col("id").cast("string"), F.lit(" Main St")))
  .withColumn("city", F.lit("Las Vegas"))
  .withColumn("state", _pick(F.col("id"), _states))
  .withColumn("zip_code", F.lpad((F.col("id") % F.lit(99999)).cast("string"), 5, "0"))
  .withColumn("loyalty_tier", _pick(F.col("id"), _tiers))
  .withColumn("enrollment_date", F.lit("2023-06-15"))
  .withColumn("marketing_opt_in", (F.col("id") % F.lit(2) == F.lit(0)))
  .withColumn("ssn", F.lit(None).cast("string"))
  .withColumn("ssn_hash", F.sha2(F.concat(F.lit("ssn-"), F.col("id").cast("string")), 256))
  .withColumn("_ingested_at", F.current_timestamp().cast("string"))
  .withColumn("_source", F.lit("loom-seed"))
  .withColumn("_batch_id", F.lit("seed")))
_write(player, "bronze_player_profile")

# ---- 3) financial transactions (bronze_financial_txn) ----
_txtypes = ["BUY_IN", "CASH_OUT", "MARKER", "CHIP_EXCHANGE", "JACKPOT_PAYOUT"]
_pmethods = ["CASH", "CHIP", "CREDIT", "WIRE"]
_cages = ["CAGE-1", "CAGE-2", "CAGE-3"]
fin = (_b
  .withColumn("transaction_id", F.concat(F.lit("txn-"), F.col("id").cast("string")))
  .withColumn("transaction_type", _pick(F.col("id"), _txtypes))
  .withColumn("amount", F.round(F.rand(11) * F.lit(20000), 2))
  .withColumn("transaction_timestamp", _ts(F.col("id")))
  .withColumn("player_id", F.concat(F.lit("PLAYER-"), (F.col("id") % F.lit(200)).cast("string")))
  .withColumn("cage_location", _pick(F.col("id"), _cages))
  .withColumn("cashier_id", F.concat(F.lit("CASH-"), (F.col("id") % F.lit(30)).cast("string")))
  .withColumn("source_amount", F.round(F.rand(12) * F.lit(20000), 2))
  .withColumn("destination_amount", F.round(F.rand(13) * F.lit(20000), 2))
  .withColumn("currency", F.lit("USD"))
  .withColumn("payment_method", _pick(F.col("id"), _pmethods))
  .withColumn("ctr_required", (F.col("amount") > F.lit(10000)))
  .withColumn("ctr_filed", (F.col("amount") > F.lit(10000)) & (F.col("id") % F.lit(3) != F.lit(0)))
  .withColumn("marker_number", F.concat(F.lit("MKR-"), F.col("id").cast("string")))
  .withColumn("approval_code", F.concat(F.lit("APR-"), F.col("id").cast("string")))
  .withColumn("notes", F.lit(None).cast("string"))
  .withColumn("_ingested_at", F.current_timestamp().cast("string"))
  .withColumn("_source", F.lit("loom-seed"))
  .withColumn("_batch_id", F.lit("seed")))
_write(fin, "bronze_financial_txn")

# ---- 4) compliance filings (bronze_compliance_filings) ----
_ftypes = ["CTR", "SAR", "W2G", "MTL"]
_sar = ["STRUCTURING", "MINIMAL_GAMING", "LARGE_CASH", "UNUSUAL_PATTERN"]
comp = (_b
  .withColumn("filing_id", F.concat(F.lit("file-"), F.col("id").cast("string")))
  .withColumn("filing_type", _pick(F.col("id"), _ftypes))
  .withColumn("filing_timestamp", _ts(F.col("id")))
  .withColumn("player_id", F.concat(F.lit("PLAYER-"), (F.col("id") % F.lit(200)).cast("string")))
  .withColumn("amount", F.round(F.rand(21) * F.lit(50000), 2))
  .withColumn("transaction_date", F.lit("2026-06-01"))
  .withColumn("gaming_day", F.lit("2026-06-01"))
  .withColumn("transaction_type", _pick(F.col("id"), _txtypes))
  .withColumn("cage_location", _pick(F.col("id"), _cages))
  .withColumn("cashier_id", F.concat(F.lit("CASH-"), (F.col("id") % F.lit(30)).cast("string")))
  .withColumn("suspicious_activity_type", F.when(F.col("filing_type") == F.lit("SAR"), _pick(F.col("id"), _sar)).otherwise(F.lit(None).cast("string")))
  .withColumn("narrative", F.lit("Automated seed filing."))
  .withColumn("game_type", _pick(F.col("id"), ["SLOT", "TABLE", "POKER"]))
  .withColumn("machine_id", F.concat(F.lit("SLOT-"), (F.col("id") % F.lit(50)).cast("string")))
  .withColumn("wager_amount", F.round(F.rand(22) * F.lit(5000), 2))
  .withColumn("filing_status", _pick(F.col("id"), ["DRAFT", "FILED", "ACCEPTED"]))
  .withColumn("due_date", F.lit("2026-06-15"))
  .withColumn("_ingested_at", F.current_timestamp().cast("string"))
  .withColumn("_source", F.lit("loom-seed"))
  .withColumn("_batch_id", F.lit("seed")))
_write(comp, "bronze_compliance_filings")

# ---- 5) table games (bronze_table_games) ----
_games = ["BLACKJACK", "ROULETTE", "BACCARAT", "CRAPS", "POKER"]
_tevents = ["BET", "WIN", "LOSS", "PUSH", "BUY_IN", "COLOR_UP"]
_outcomes = ["WIN", "LOSS", "PUSH"]
tbl = (_b
  .withColumn("event_id", F.concat(F.lit("tbl-evt-"), F.col("id").cast("string")))
  .withColumn("table_id", F.concat(F.lit("TABLE-"), (F.col("id") % F.lit(40)).cast("string")))
  .withColumn("game_type", _pick(F.col("id"), _games))
  .withColumn("event_type", _pick(F.col("id"), _tevents))
  .withColumn("event_timestamp", _ts(F.col("id")))
  .withColumn("player_id", F.concat(F.lit("PLAYER-"), (F.col("id") % F.lit(200)).cast("string")))
  .withColumn("dealer_id", F.concat(F.lit("DEAL-"), (F.col("id") % F.lit(60)).cast("string")))
  .withColumn("pit_id", F.concat(F.lit("PIT-"), (F.col("id") % F.lit(8)).cast("string")))
  .withColumn("bet_amount", F.round(F.rand(31) * F.lit(1000), 2).cast("decimal(18,2)"))
  .withColumn("win_amount", F.round(F.rand(32) * F.lit(1500), 2).cast("decimal(18,2)"))
  .withColumn("chip_count", (F.rand(33) * F.lit(500)).cast("int"))
  .withColumn("hand_number", (F.col("id") % F.lit(200)).cast("int"))
  .withColumn("cards_dealt", F.lit("A-K"))
  .withColumn("outcome", _pick(F.col("id"), _outcomes))
  .withColumn("session_id", F.concat(F.lit("TSESS-"), (F.col("id") % F.lit(300)).cast("string")))
  .withColumn("seat_position", (F.col("id") % F.lit(7)).cast("int"))
  .withColumn("game_specific", F.lit(None).cast("string"))
  .withColumn("_ingested_at", F.current_timestamp().cast("string"))
  .withColumn("_source", F.lit("loom-seed"))
  .withColumn("_batch_id", F.lit("seed")))
_write(tbl, "bronze_table_games")

# ---- 6) security events (bronze_security_events) ----
_sev_types = ["ACCESS_DENIED", "SURVEILLANCE_ALERT", "INCIDENT", "EXCLUSION_MATCH", "DOOR_FORCED"]
_sev_levels = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
_loc_types = ["GAMING_FLOOR", "CAGE", "VAULT", "ENTRANCE", "PARKING"]
sec = (_b
  .withColumn("event_id", F.concat(F.lit("sec-evt-"), F.col("id").cast("string")))
  .withColumn("event_type", _pick(F.col("id"), _sev_types))
  .withColumn("event_timestamp", _ts(F.col("id")))
  .withColumn("location_id", F.concat(F.lit("LOC-"), (F.col("id") % F.lit(25)).cast("string")))
  .withColumn("location_type", _pick(F.col("id"), _loc_types))
  .withColumn("severity_level", _pick(F.col("id"), _sev_levels))
  .withColumn("person_id", F.concat(F.lit("PERSON-"), (F.col("id") % F.lit(150)).cast("string")))
  .withColumn("person_type", _pick(F.col("id"), ["PATRON", "EMPLOYEE", "VENDOR", "UNKNOWN"]))
  .withColumn("description", F.lit("Automated seed security event."))
  .withColumn("camera_id", F.concat(F.lit("CAM-"), (F.col("id") % F.lit(80)).cast("string")))
  .withColumn("badge_id", F.concat(F.lit("BADGE-"), (F.col("id") % F.lit(120)).cast("string")))
  .withColumn("door_id", F.concat(F.lit("DOOR-"), (F.col("id") % F.lit(40)).cast("string")))
  .withColumn("responding_officer_id", F.concat(F.lit("OFF-"), (F.col("id") % F.lit(20)).cast("string")))
  .withColumn("response_timestamp", _ts(F.col("id")))
  .withColumn("resolution_timestamp", _ts(F.col("id")))
  .withColumn("resolution_status", _pick(F.col("id"), ["OPEN", "RESOLVED", "ESCALATED"]))
  .withColumn("resolution_notes", F.lit(None).cast("string"))
  .withColumn("exclusion_info", F.lit(None).cast("string"))
  .withColumn("incident_info", F.lit(None).cast("string"))
  .withColumn("gaming_related", (F.col("id") % F.lit(2) == F.lit(0)))
  .withColumn("table_id", F.concat(F.lit("TABLE-"), (F.col("id") % F.lit(40)).cast("string")))
  .withColumn("machine_id", F.concat(F.lit("SLOT-"), (F.col("id") % F.lit(50)).cast("string")))
  .withColumn("amount_involved", F.round(F.rand(41) * F.lit(10000), 2))
  .withColumn("attachments", F.lit(None).cast("string"))
  .withColumn("_ingested_at", F.current_timestamp().cast("string"))
  .withColumn("_source", F.lit("loom-seed"))
  .withColumn("_batch_id", F.lit("seed")))
_write(sec, "bronze_security_events")

print("== Loom supercharge seed complete ==")
`;
/* SEED_PYSPARK_END */

export interface SeedResult {
  ok: boolean;
  status: 'succeeded' | 'failed' | 'gated';
  error?: string;
  gate?: string;
  sessionId?: number;
  textPlain?: string;
}

/**
 * Run the supercharge medallion seed on a Synapse Spark pool via Livy and wait
 * for it to finish. Creates a pyspark session (cold-start tolerant), submits
 * SUPERCHARGE_SEED_PYSPARK, polls the statement to a terminal state. Never
 * throws — returns a structured result the install worker records. Honest gate:
 * when Synapse/Livy is not configured the error surfaces as status:'gated'.
 */
export async function runSuperchargeSeed(
  pool: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SeedResult> {
  const timeoutMs = opts.timeoutMs ?? 12 * 60 * 1000;
  const pollMs = opts.pollMs ?? 5000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const sess = await createLivySessionAsync(pool, 'pyspark', 'loom-supercharge-seed');
    const sessionId = sess.id;
    const deadline = Date.now() + timeoutMs;

    // Wait for the session to become idle (cold-start).
    let idle = false;
    while (Date.now() < deadline) {
      const live = await getLivySession(pool, sessionId);
      if (live.state === 'idle') { idle = true; break; }
      if (['error', 'dead', 'killed'].includes(live.state)) {
        return { ok: false, status: 'failed', error: `Spark session entered '${live.state}' before the seed could run`, sessionId };
      }
      await sleep(pollMs);
    }
    if (!idle) return { ok: false, status: 'failed', error: 'Spark session did not reach idle before timeout', sessionId };

    const stmt = await submitLivyStatement(pool, sessionId, { code: SUPERCHARGE_SEED_PYSPARK, kind: 'pyspark' });
    while (Date.now() < deadline) {
      const st = await getLivyStatement(pool, sessionId, stmt.id);
      const out = (st as any).output || {};
      if (out.status === 'ok') {
        return { ok: true, status: 'succeeded', sessionId, textPlain: out.data?.['text/plain'] };
      }
      if (out.status === 'error') {
        return { ok: false, status: 'failed', sessionId, error: `${out.ename || 'error'}: ${(out.evalue || '').slice(0, 400)}` };
      }
      await sleep(pollMs);
    }
    return { ok: false, status: 'failed', error: 'seed statement did not complete before timeout', sessionId };
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Honest infra gate — Livy/Synapse not wired in this deployment.
    if (/LOOM_SYNAPSE|not configured|Synapse/i.test(msg)) {
      return { ok: false, status: 'gated', gate: msg };
    }
    return { ok: false, status: 'failed', error: msg };
  }
}
