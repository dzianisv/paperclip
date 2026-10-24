#!/usr/bin/env bash
# paperclip embedded-postgres bloat/stats guard  (kanban t_3f37a0f8)
#
# WHY THIS EXISTS
# ---------------
# Card t_3f37a0f8 was filed as "1.75GB of dead tuples, autovacuum never ran".
# Both halves of that were wrong, and they were wrong because the thing the
# operator read -- pg_stat_user_tables -- was itself broken:
#
#   heartbeat_runs | n_live_tup 10 | n_dead_tup 63 | last_autovacuum (null) | 1789 MB
#
# n_live_tup=10 on a table holding 8978 rows. Every one of the 173 user tables
# reported last_autovacuum/last_vacuum/last_analyze = NULL, and 152 of them
# reported n_live_tup=0 AND n_dead_tup=0. The cumulative stats are wiped on
# every restart of the embedded cluster (pg_stat/ is empty; PG only persists
# stats there on a CLEAN shutdown), and this instance restarts constantly.
#
# So the failure class is: THE BLOAT SIGNAL IS UNTRUSTWORTHY BY DEFAULT.
# An operator reading pg_stat_user_tables on this instance gets
#   - fake "0 rows"      -> real bloat looks like an empty table
#   - fake "never vacuumed" -> a healthy autovacuum looks broken
#   - fake dead-tuple ratios -> sends you to VACUUM FULL, which on this table
#     would have taken an exclusive lock to reclaim 1.8MB of a 1789MB relation.
#
# This guard therefore does NOT read the dead/live counters to decide anything.
# It measures physical truth with pgstattuple and separates the two conditions
# that the broken counters conflate:
#
#   RECLAIMABLE bloat (dead tuples)  -> a VACUUM would help
#   LIVE payload    (live tuples)    -> a VACUUM would NOT help; it is real data
#                                       and needs a retention/compaction policy
#
# P-GUARD COMPLIANCE
# ------------------
# Nothing here is a hand-maintained list of tables. The set of relations checked
# is DERIVED from the live catalog every run (pg_class/pg_stat_user_tables, all
# user relations over --min-size-mb, including their TOAST). A table added to
# the schema tomorrow is picked up with no edit to this file. There is no
# literal allowlist to forget to update.
#
# EXIT CODES
#   0  OK
#   1  operational failure (cannot connect, pgstattuple unavailable, bad args)
#   2  FINDING: reclaimable dead-tuple bloat over threshold (a VACUUM is owed)
#   3  FINDING: live payload over threshold (retention/compaction is owed)
# Exit 2 and 3 are independent; 3 is reported if both trip, since live payload
# is the condition a plain VACUUM cannot fix.

set -uo pipefail

PGPORT_DEFAULT=54329
PORT="${PAPERCLIP_PG_PORT:-$PGPORT_DEFAULT}"
HOSTDIR="${PAPERCLIP_PG_HOST:-/tmp}"
DBUSER="${PAPERCLIP_PG_USER:-paperclip}"
DBNAME="${PAPERCLIP_PG_DB:-paperclip}"
export PGPASSWORD="${PAPERCLIP_PG_PASSWORD:-paperclip}"

MIN_SIZE_MB=64          # only inspect relations big enough to matter
DEAD_PCT_MAX=25         # >25% dead bytes in a big relation => a VACUUM is owed
LIVE_MB_MAX=512         # >512MB of LIVE bytes in one relation => retention owed
DO_VACUUM=0             # --vacuum: plain VACUUM (ANALYZE), never VACUUM FULL
QUIET=0

usage() {
  cat <<EOF
usage: $0 [--min-size-mb N] [--dead-pct-max N] [--live-mb-max N] [--vacuum] [--quiet]

  --vacuum   run plain VACUUM (ANALYZE) on relations with reclaimable bloat.
             This takes NO exclusive lock and never rewrites the file. It is
             explicitly NOT VACUUM FULL / pg_repack: those need an exclusive
             lock on a live store and are a human decision, not a cron job.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --min-size-mb)  MIN_SIZE_MB="$2"; shift 2 ;;
    --dead-pct-max) DEAD_PCT_MAX="$2"; shift 2 ;;
    --live-mb-max)  LIVE_MB_MAX="$2"; shift 2 ;;
    --vacuum)       DO_VACUUM=1; shift ;;
    --quiet)        QUIET=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

psql_q() {
  psql -h "$HOSTDIR" -p "$PORT" -U "$DBUSER" -d "$DBNAME" \
       -v ON_ERROR_STOP=1 -tA -F'|' -c "$1"
}

if ! psql_q "SELECT 1" >/dev/null 2>&1; then
  echo "GUARD FAIL: cannot connect to paperclip postgres at $HOSTDIR:$PORT" >&2
  exit 1
fi

# pgstattuple is the only trustworthy source here. Fail loudly rather than
# silently falling back to the counters we already know are wrong.
if ! psql_q "CREATE EXTENSION IF NOT EXISTS pgstattuple" >/dev/null 2>&1; then
  echo "GUARD FAIL: pgstattuple unavailable; refusing to fall back to pg_stat_user_tables (known-unreliable on this instance)" >&2
  exit 1
fi

# --- stats-trust probe -------------------------------------------------------
# Report, every run, whether the cumulative stats are currently lying. This is
# what made the original card misdiagnose; surfacing it keeps the next operator
# from repeating it.
read -r NTAB NZEROED NNOVAC < <(psql_q "
  SELECT count(*),
         count(*) FILTER (WHERE n_live_tup = 0 AND n_dead_tup = 0),
         count(*) FILTER (WHERE last_vacuum IS NULL AND last_autovacuum IS NULL)
    FROM pg_stat_user_tables" | tr '|' ' ')

say "stats-trust: ${NTAB} user tables, ${NZEROED} reporting 0 live AND 0 dead, ${NNOVAC} never vacuumed/analyzed"
if [ "${NNOVAC:-0}" -gt $(( ${NTAB:-1} / 2 )) ]; then
  say "stats-trust: WARNING cumulative stats look wiped (embedded cluster restart drops them);"
  say "stats-trust:          do NOT size bloat from pg_stat_user_tables -- this guard uses pgstattuple."
fi

# --- derive the relation set from the catalog (never a hand-kept list) -------
RELS=$(psql_q "
  SELECT c.oid::regclass::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','m')
     AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
     AND pg_total_relation_size(c.oid) >= ${MIN_SIZE_MB} * 1024 * 1024
   ORDER BY pg_total_relation_size(c.oid) DESC")

if [ -z "$RELS" ]; then
  say "no relation >= ${MIN_SIZE_MB}MB; nothing to inspect"
  exit 0
fi

DEAD_HITS=""
LIVE_HITS=""

while IFS= read -r rel; do
  [ -n "$rel" ] || continue

  # Physical truth for the relation AND its TOAST. heartbeat_runs' 1789MB was
  # 99% TOAST, so a heap-only reading would have missed all of it.
  read -r TOTAL LIVE DEAD < <(psql_q "
    WITH t AS (
      SELECT c.oid AS heap, c.reltoastrelid AS toast FROM pg_class c WHERE c.oid = '${rel}'::regclass
    ), s AS (
      SELECT (pgstattuple(heap)).* FROM t
      UNION ALL
      SELECT (pgstattuple(toast)).* FROM t WHERE toast <> 0
    )
    SELECT coalesce(sum(table_len),0)::bigint,
           coalesce(sum(tuple_len),0)::bigint,
           coalesce(sum(dead_tuple_len),0)::bigint
      FROM s" | tr '|' ' ')

  [ -n "${TOTAL:-}" ] || continue
  [ "$TOTAL" -gt 0 ] || continue

  DEAD_PCT=$(( DEAD * 100 / TOTAL ))
  LIVE_MB=$(( LIVE / 1024 / 1024 ))
  TOTAL_MB=$(( TOTAL / 1024 / 1024 ))

  say "$(printf '%-34s total=%6sMB live=%6sMB dead=%3s%%' "$rel" "$TOTAL_MB" "$LIVE_MB" "$DEAD_PCT")"

  if [ "$DEAD_PCT" -gt "$DEAD_PCT_MAX" ]; then
    DEAD_HITS="${DEAD_HITS}${rel} (${DEAD_PCT}% dead of ${TOTAL_MB}MB)\n"
    if [ "$DO_VACUUM" = "1" ]; then
      say "  -> plain VACUUM (ANALYZE) ${rel}"
      psql_q "VACUUM (ANALYZE) ${rel}" >/dev/null || say "  -> VACUUM FAILED on ${rel}"
    fi
  fi

  if [ "$LIVE_MB" -gt "$LIVE_MB_MAX" ]; then
    LIVE_HITS="${LIVE_HITS}${rel} (${LIVE_MB}MB LIVE -- a VACUUM cannot shrink this)\n"
  fi
done <<< "$RELS"

RC=0
if [ -n "$DEAD_HITS" ]; then
  echo "FINDING reclaimable bloat (a plain VACUUM is owed):"
  printf "%b" "$DEAD_HITS"
  RC=2
fi
if [ -n "$LIVE_HITS" ]; then
  echo "FINDING live payload over ${LIVE_MB_MAX}MB (retention/compaction owed, NOT a vacuum problem):"
  printf "%b" "$LIVE_HITS"
  RC=3
fi
[ "$RC" = "0" ] && say "OK: no relation over thresholds"
exit $RC
