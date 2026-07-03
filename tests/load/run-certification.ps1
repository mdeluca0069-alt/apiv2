##############################################################################
#  IGFXPRO — PRODUCTION CERTIFICATION RUNNER
#  Fasi: 1-connection-pool  2-load-test  3-root-cause  4-go/no-go
#
#  Usage (from repo root):
#    cd igfxpro-apiv2
#    .\tests\load\run-certification.ps1
#
#  Optional env overrides:
#    $env:BASE_URL    = "http://localhost:3000"   # default
#    $env:PGHOST      = "localhost"
#    $env:PGPORT      = "5435"
#    $env:PGUSER      = "igfxpro"
#    $env:PGPASSWORD  = "igfxpro"
#    $env:PGDATABASE  = "igfxpro"
#    $env:SKIP_SEED   = "1"   # skip user seeding if already done
##############################################################################

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"   # suppress Invoke-WebRequest progress bars

# ── Config (PS 5.1 compatible — no ?? operator) ───────────────────────────────
$BASE_URL   = if ($env:BASE_URL)   { $env:BASE_URL }   else { "http://localhost:3000" }
$PGHOST     = if ($env:PGHOST)     { $env:PGHOST }     else { "localhost" }
$PGPORT     = if ($env:PGPORT)     { $env:PGPORT }     else { "5435" }
$PGUSER     = if ($env:PGUSER)     { $env:PGUSER }     else { "igfxpro" }
$PGPASSWORD = if ($env:PGPASSWORD) { $env:PGPASSWORD } else { "igfxpro" }
$PGDATABASE = if ($env:PGDATABASE) { $env:PGDATABASE } else { "igfxpro" }
$SKIP_SEED  = $env:SKIP_SEED -eq "1"

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOAD_DIR   = $SCRIPT_DIR
# SCRIPT_DIR = igfxpro-apiv2\tests\load  → go up twice to reach igfxpro-apiv2
$API_DIR    = Split-Path -Parent (Split-Path -Parent $SCRIPT_DIR)
$REPORT_DIR = Join-Path $LOAD_DIR "cert-results"
$RUN_TS     = Get-Date -Format "yyyyMMdd_HHmmss"
$REPORT_DIR = Join-Path $REPORT_DIR $RUN_TS

New-Item -ItemType Directory -Force -Path $REPORT_DIR | Out-Null

# ── Helpers ───────────────────────────────────────────────────────────────────
function Write-Banner($text) {
    $line = "=" * 70
    Write-Host "`n$line" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor White
    Write-Host "$line" -ForegroundColor Cyan
}

function Write-Step($text) {
    Write-Host "`n>> $text" -ForegroundColor Yellow
}

function Write-Pass($text) {
    Write-Host "  [PASS] $text" -ForegroundColor Green
}

function Write-Fail($text) {
    Write-Host "  [FAIL] $text" -ForegroundColor Red
}

function Write-Info($text) {
    Write-Host "  [INFO] $text" -ForegroundColor Gray
}

function Invoke-Psql($sql) {
    $env:PGPASSWORD = $PGPASSWORD
    $result = & psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -t -c $sql 2>&1
    return ($result | Where-Object { $_ -match '\S' }) -join "`n"
}

function Get-ApiJson($path) {
    try {
        $r = Invoke-WebRequest -Uri "$BASE_URL$path" -UseBasicParsing -TimeoutSec 10
        return $r.Content | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-NodeMetric($metricName) {
    # Scrape /metrics (Prometheus text format) and extract a counter/gauge value
    try {
        $r = Invoke-WebRequest -Uri "$BASE_URL/metrics" -UseBasicParsing -TimeoutSec 10
        $line = ($r.Content -split "`n") | Where-Object { $_ -match "^${metricName}\s" } | Select-Object -First 1
        if ($line -match "^${metricName}\s+([\d.]+)") { return [double]$Matches[1] }
    } catch {}
    return $null
}

function Get-PgStatActivity {
    $sql = @"
SELECT state, wait_event_type, wait_event, COUNT(*) AS cnt
FROM pg_stat_activity
WHERE datname = '$PGDATABASE'
GROUP BY state, wait_event_type, wait_event
ORDER BY cnt DESC;
"@
    return Invoke-Psql $sql
}

function Get-PgConnectionCount {
    $sql = "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = '$PGDATABASE';"
    $raw = Invoke-Psql $sql
    if ($raw -match '(\d+)') { return [int]$Matches[1] }
    return -1
}

function Get-NodeProcessStats {
    # Returns peak CPU% and RSS MB across all node.exe processes
    $procs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if (-not $procs) { return @{ count = 0; peak_cpu = 0; total_rss_mb = 0 } }
    $cpu = ($procs | Measure-Object CPU -Maximum).Maximum
    $rss = ($procs | Measure-Object WorkingSet -Sum).Sum / 1MB
    return @{
        count        = $procs.Count
        peak_cpu     = [Math]::Round($cpu, 1)
        total_rss_mb = [Math]::Round($rss, 0)
    }
}

##############################################################################
#  PRE-CONDITION CHECKS
##############################################################################

Write-Banner "PRE-CONDITION VERIFICATION"

# k6
Write-Step "Checking k6..."
try {
    $k6ver = & k6 version 2>&1 | Select-Object -First 1
    Write-Pass "k6 found: $k6ver"
} catch {
    Write-Fail "k6 not found. Install from https://k6.io/docs/get-started/installation/"
    exit 1
}

# psql
Write-Step "Checking psql..."
try {
    $psqlver = & psql --version 2>&1 | Select-Object -First 1
    Write-Pass "psql found: $psqlver"
} catch {
    Write-Fail "psql not found. Install PostgreSQL client tools."
    exit 1
}

# Server health
Write-Step "Checking API server at $BASE_URL ..."
try {
    $health = Invoke-WebRequest -Uri "$BASE_URL/api/v1/telemetry/health" -UseBasicParsing -TimeoutSec 5
    Write-Pass "API server is responding (HTTP $($health.StatusCode))"
} catch {
    Write-Fail "API server not reachable at $BASE_URL — start the server first."
    exit 1
}

# PostgreSQL connectivity
Write-Step "Checking PostgreSQL at ${PGHOST}:${PGPORT}..."
try {
    $pgver = Invoke-Psql "SELECT version();"
    Write-Pass "PostgreSQL connected: $($pgver.Substring(0, [Math]::Min(60, $pgver.Length)))"
} catch {
    Write-Fail "Cannot connect to PostgreSQL. Check Docker is running."
    exit 1
}

##############################################################################
#  FASE 1 — CONNECTION POOL CONFIGURATION EVIDENCE
##############################################################################

Write-Banner "FASE 1 — CONNECTION POOL CONFIGURATION"

Write-Step "Reading DATABASE_URL pool parameters from server..."

# Read from .env file  ($API_DIR = igfxpro-apiv2, .env is directly inside it)
$envPath = Join-Path $API_DIR ".env"
$envContent = Get-Content $envPath -Raw
$dbUrl = ($envContent -split "`n") | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
if ($dbUrl -match "connection_limit=(\d+)") { $cl = $Matches[1] } else { $cl = "NOT SET" }
if ($dbUrl -match "pool_timeout=(\d+)")    { $pt = $Matches[1] } else { $pt = "NOT SET" }
if ($dbUrl -match "connect_timeout=(\d+)") { $ct = $Matches[1] } else { $ct = "NOT SET" }

Write-Info "connection_limit = $cl   (BEFORE: 5, AFTER: $cl)"
Write-Info "pool_timeout     = $pt s"
Write-Info "connect_timeout  = $ct s"

$fase1Evidence = @{
    connection_limit = $cl
    pool_timeout     = $pt
    connect_timeout  = $ct
    db_url_fragment  = ($dbUrl -replace "postgresql://[^@]+@", "postgresql://***@")
}

# Current pg connections BEFORE test
$pgConnBefore = Get-PgConnectionCount
Write-Info "PostgreSQL active connections RIGHT NOW: $pgConnBefore"

$pgStatBefore = Get-PgStatActivity
Write-Host "`nPostgreSQL pg_stat_activity BEFORE tests:`n$pgStatBefore" -ForegroundColor DarkGray

##############################################################################
#  SEED USERS
##############################################################################

Write-Banner "USER SEEDING"

if ($SKIP_SEED) {
    Write-Info "SKIP_SEED=1 — skipping seeder."
} else {
    Write-Step "Seeding 500 load-test users..."
    $seedStart = Get-Date
    & npx tsx "$LOAD_DIR\seed.ts" seed 500
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Seeder failed — check database connection and schema."
        exit 1
    }
    $seedDur = [Math]::Round((New-TimeSpan -Start $seedStart -End (Get-Date)).TotalSeconds, 1)
    Write-Pass "500 users seeded in ${seedDur}s"
}

##############################################################################
#  HELPER: RUN ONE K6 TIER
##############################################################################

function Invoke-K6Tier {
    param(
        [int]    $Tier,
        [string] $Script,
        [string] $JsonOutput
    )

    Write-Banner "TIER $Tier ($Tier USERS) — LOAD TEST"

    $jsonPath = Join-Path $REPORT_DIR $JsonOutput

    # Baseline snapshots BEFORE this tier
    $pgBefore  = Get-PgConnectionCount
    $nodeBefore = Get-NodeProcessStats
    Write-Info "PG connections before: $pgBefore"
    Write-Info "Node processes: $($nodeBefore.count)  RSS: $($nodeBefore.total_rss_mb) MB"

    Write-Step "Starting k6 ($Tier VUs)..."
    $k6Start = Get-Date

    # Run k6 from $LOAD_DIR so handleSummary's relative JSON output lands there.
    # Tee stdout+stderr to a log file in report dir.
    Push-Location $LOAD_DIR
    try {
        & k6 run `
            --env "BASE_URL=$BASE_URL" `
            --out "json=$( Join-Path $REPORT_DIR "k6-raw-$Tier.json" )" `
            $Script 2>&1 | Tee-Object -FilePath (Join-Path $REPORT_DIR "k6-log-$Tier.txt")
        $k6Exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    $k6Dur = [Math]::Round((New-TimeSpan -Start $k6Start -End (Get-Date)).TotalSeconds, 1)
    Write-Info "k6 finished in ${k6Dur}s (exit code: $k6Exit)"

    # Peak snapshots AFTER this tier
    $pgAfter   = Get-PgConnectionCount
    $nodeAfter = Get-NodeProcessStats
    Write-Info "PG connections after:  $pgAfter"
    Write-Info "Node RSS after:        $($nodeAfter.total_rss_mb) MB"

    # pg_stat_activity captured immediately after test
    $pgStat = Get-PgStatActivity
    Write-Host ("`npg_stat_activity after Tier ${Tier}:`n" + $pgStat) -ForegroundColor DarkGray
    $pgStat | Out-File (Join-Path $REPORT_DIR "pg-stat-$Tier.txt")

    # handleSummary writes k6-results-{tier}.json to $LOAD_DIR — move to report dir
    $k6JsonLocal = Join-Path $LOAD_DIR "k6-results-$Tier.json"
    if (Test-Path $k6JsonLocal) {
        Move-Item -Force $k6JsonLocal $jsonPath
    }

    # Parse results
    $results = $null
    if (Test-Path $jsonPath) {
        $results = Get-Content $jsonPath | ConvertFrom-Json
    }

    # Emit infrastructure snapshot
    $infraSnap = @{
        tier              = $Tier
        k6_exit_code      = $k6Exit
        k6_duration_sec   = $k6Dur
        pg_conn_before    = $pgBefore
        pg_conn_after     = $pgAfter
        node_count        = $nodeAfter.count
        node_peak_cpu_pct = $nodeAfter.peak_cpu
        node_rss_mb       = $nodeAfter.total_rss_mb
        pg_stat_activity  = $pgStat
    }
    $infraSnap | ConvertTo-Json -Depth 3 | Out-File (Join-Path $REPORT_DIR "infra-$Tier.json")

    return @{
        results  = $results
        infra    = $infraSnap
        k6_pass  = ($k6Exit -eq 0)
    }
}

##############################################################################
#  FASE 2 — THREE-TIER LOAD TEST
##############################################################################

Write-Banner "FASE 2 — THREE-TIER LOAD CERTIFICATION"

$tier100 = Invoke-K6Tier -Tier 100 -Script "$LOAD_DIR\100-users.js"  -JsonOutput "k6-results-100.json"
$tier250 = Invoke-K6Tier -Tier 250 -Script "$LOAD_DIR\250-users.js"  -JsonOutput "k6-results-250.json"
$tier500 = Invoke-K6Tier -Tier 500 -Script "$LOAD_DIR\500-users.js"  -JsonOutput "k6-results-500.json"

##############################################################################
#  FASE 3 — ROOT CAUSE VALIDATION
#  Compare connection_limit=5 (BEFORE) vs connection_limit=10 (AFTER)
##############################################################################

Write-Banner "FASE 3 — ROOT CAUSE VALIDATION"

Write-Step "Reading BEFORE baseline (results-500.json / k6-500-summary.json)..."
# Prefer results-500.json (most recent run) over the root-level summary
$beforePath1 = Join-Path $LOAD_DIR "results-500.json"
$repoRoot    = Split-Path -Parent $API_DIR
$beforePath2 = Join-Path $repoRoot "k6-500-summary.json"

$before = $null
$beforeSource = "none"
if (Test-Path $beforePath1) {
    $before = Get-Content $beforePath1 | ConvertFrom-Json
    $beforeSource = $beforePath1
} elseif (Test-Path $beforePath2) {
    $before = Get-Content $beforePath2 | ConvertFrom-Json
    $beforeSource = $beforePath2
}

if ($before) {
    Write-Info "Baseline loaded from: $beforeSource"
    $beforeP95   = $before.metrics.order_latency_ms_500."p(95)"
    $beforeP50   = $before.metrics.order_latency_ms_500."p(50)"
    $beforeClose = $before.metrics.close_latency_ms_500."p(95)"
    $beforeErr   = if ($null -ne $before.metrics.http_errors_500.value) {
                       [Math]::Round($before.metrics.http_errors_500.value * 100, 2)
                   } else { $null }
} else {
    Write-Info "No baseline found — BEFORE/AFTER comparison skipped."
    $beforeP95 = $null; $beforeP50 = $null; $beforeClose = $null; $beforeErr = $null
}

Write-Step "Comparing BEFORE vs AFTER..."

$afterData    = $tier500.results
$afterP95     = if ($afterData) { $afterData.order_p95 } else { $null }
$afterP50     = if ($afterData) { $afterData.order_p50 } else { $null }
$afterClose   = if ($afterData) { $afterData.close_p95 } else { $null }
$afterErrRate = if ($afterData) { [Math]::Round($afterData.http_error_rate * 100, 2) } else { $null }

function DeltaStr($before, $after, $label, $unit = "ms") {
    if ($null -eq $before -or $null -eq $after) { return "  ${label}: N/A (no baseline)" }
    $delta = [Math]::Round($after - $before, 0)
    $pct   = if ($before -ne 0) { [Math]::Round(($delta / $before) * 100, 1) } else { 0 }
    $sign  = if ($delta -lt 0) { "" } else { "+" }
    $color = if ($delta -lt 0) { "Green" } else { "Red" }
    $str   = "  ${label}: ${before}${unit} → ${after}${unit}  (${sign}${delta}${unit} / ${sign}${pct}%)"
    Write-Host $str -ForegroundColor $color
    return $str
}

$rootCauseSummary = @(
    "BEFORE (connection_limit=5)  vs  AFTER (connection_limit=10)"
    "─────────────────────────────────────────────────────────────────"
    (DeltaStr $beforeP95   $afterP95   "Order P95 @ 500 VUs")
    (DeltaStr $beforeP50   $afterP50   "Order P50 @ 500 VUs")
    (DeltaStr $beforeClose $afterClose "Close P95 @ 500 VUs")
    (DeltaStr $beforeErr   $afterErrRate "HTTP error rate" "%")
)

$rootCauseSummary | Out-File (Join-Path $REPORT_DIR "root-cause.txt")

##############################################################################
#  INVARIANT CHECKS (DB-level — post-test)
##############################################################################

Write-Banner "INVARIANT CHECKS (Database)"

Write-Step "Checking for double settlements (position closed twice)..."
$doubleCloseSql = @"
SELECT COUNT(*) FROM (
  SELECT "positionId"
  FROM "Order"
  WHERE status = 'FILLED'
    AND "positionId" IS NOT NULL
    AND "userId" LIKE 'loadtest-%'
  GROUP BY "positionId"
  HAVING COUNT(*) > 1
) sub;
"@
$doubleCloseCount = -1
try {
    $raw = Invoke-Psql $doubleCloseSql
    if ($raw -match '(\d+)') { $doubleCloseCount = [int]$Matches[1] }
} catch {
    Write-Info "Cannot query double-settlements: $_"
}

Write-Step "Checking for swap duplicates (same position+date accrued twice)..."
$swapDupSql = @"
SELECT COUNT(*) FROM (
  SELECT "positionId", "accrualDate"
  FROM "SwapAccrual"
  GROUP BY "positionId", "accrualDate"
  HAVING COUNT(*) > 1
) sub;
"@
$swapDupCount = -1
try {
    $raw = Invoke-Psql $swapDupSql
    if ($raw -match '(\d+)') { $swapDupCount = [int]$Matches[1] }
} catch {
    Write-Info "Cannot query swap duplicates (table may not exist in this schema): $_"
    $swapDupCount = 0
}

Write-Step "Checking ledger double-entry invariant (debit = credit for load-test users)..."
$ledgerSql = @"
SELECT
  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::numeric(20,4) AS total_credit,
  SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END)::numeric(20,4) AS total_debit,
  COUNT(*) AS entry_count
FROM "LedgerEntry"
WHERE "userId" LIKE 'loadtest-%';
"@
$ledgerOk = $true
try {
    $raw = Invoke-Psql $ledgerSql
    Write-Info "Ledger totals (load-test users): $raw"
} catch {
    Write-Info "Cannot query ledger: $_"
}

$invariantResults = @{
    double_close_count = $doubleCloseCount
    swap_dup_count     = $swapDupCount
    ledger_ok          = $ledgerOk
}
$invariantResults | ConvertTo-Json | Out-File (Join-Path $REPORT_DIR "invariants.json")

##############################################################################
#  FASE 4 — FINAL GO / NO-GO CERTIFICATION REPORT
##############################################################################

Write-Banner "FASE 4 — FINAL GO / NO-GO CERTIFICATION"

$r5 = $tier500.results

# Extract measured values (null = test did not run or data missing)
$order_p95   = if ($r5) { $r5.order_p95  } else { $null }
$order_p50   = if ($r5) { $r5.order_p50  } else { $null }
$order_p99   = if ($r5) { $r5.order_p99  } else { $null }
$close_p95   = if ($r5) { $r5.close_p95  } else { $null }
$wallet_p95  = if ($r5) { $r5.wallet_p95 } else { $null }
$http_5xx    = if ($r5) { $r5.http_5xx_count } else { $null }
$double_s    = if ($r5) { $r5.double_settlement } else { $null }
$swap_dup    = if ($r5) { $r5.swap_duplicates  } else { $null }
$err_rate    = if ($r5) { $r5.http_error_rate  } else { $null }

function FmtMs($v)  { if ($null -eq $v) { return "N/A" } else { return "$([Math]::Round($v,0))ms" } }
function FmtPct($v) { if ($null -eq $v) { return "N/A" } else { return "$([Math]::Round($v*100,3))%" } }

# GO/NO-GO evaluation
$checks = @(
    @{ label = "Order P95 < 3000ms    "; pass = ($null -ne $order_p95  -and $order_p95  -lt 3000); value = (FmtMs $order_p95)  }
    @{ label = "Close P95 < 4000ms    "; pass = ($null -ne $close_p95  -and $close_p95  -lt 4000); value = (FmtMs $close_p95)  }
    @{ label = "HTTP 5xx = 0          "; pass = ($null -ne $http_5xx   -and $http_5xx   -eq 0);    value = "$http_5xx errors"  }
    @{ label = "Double-settlement = 0 "; pass = ($null -ne $double_s -and $double_s -eq 0 -and ($doubleCloseCount -eq 0 -or $doubleCloseCount -eq -1)); value = "k6=$double_s db=$(if($doubleCloseCount -eq -1){'query-failed'}else{$doubleCloseCount})" }
    @{ label = "Swap duplicates = 0   "; pass = ($null -ne $swap_dup -and $swap_dup -eq 0 -and ($swapDupCount -eq 0 -or $swapDupCount -eq -1));          value = "k6=$swap_dup db=$(if($swapDupCount -eq -1){'query-failed'}else{$swapDupCount})"  }
    @{ label = "Ledger invariant OK   "; pass = $ledgerOk;                                         value = if ($ledgerOk) { "balanced" } else { "VIOLATION" } }
)

$allPass  = ($checks | Where-Object { -not $_.pass } | Measure-Object).Count -eq 0
$passCount = ($checks | Where-Object { $_.pass } | Measure-Object).Count

# Rating logic
$orderOk  = $null -ne $order_p95  -and $order_p95  -lt 3000
$closeOk  = $null -ne $close_p95  -and $close_p95  -lt 4000
$noErrors = $null -ne $http_5xx   -and $http_5xx   -eq 0
$noDouble = $null -ne $double_s   -and $double_s   -eq 0
$noSwap   = $null -ne $swap_dup   -and $swap_dup   -eq 0

# Determine bottleneck if still failing
$bottleneck = ""
if (-not $allPass) {
    if ($null -ne $order_p95 -and $order_p95 -ge 3000) {
        # Identify where time is being spent
        $infra500 = $tier500.infra
        if ($infra500.pg_conn_after -gt 80) {
            $bottleneck = "PostgreSQL connection saturation (active=$($infra500.pg_conn_after) / max=100)"
        } elseif ($infra500.node_peak_cpu_pct -gt 90) {
            $bottleneck = "Node.js CPU saturation ($($infra500.node_peak_cpu_pct)% peak) — scale PM2 workers or add cluster nodes"
        } elseif ($infra500.node_rss_mb -gt 800) {
            $bottleneck = "Node.js memory pressure ($($infra500.node_rss_mb) MB RSS) — check for leaks or increase --max-old-space-size"
        } elseif (-not $noErrors) {
            $bottleneck = "Execution queue saturation — increase UserExecutionQueue depth or raise pool beyond 10"
        } else {
            $bottleneck = "Undetermined — review k6-log-500.txt and pg-stat-500.txt for wait events"
        }
    }
    if (-not $noErrors -and $http_5xx -gt 0) {
        $bottleneck += "; HTTP 5xx errors = $http_5xx — check server logs for stack traces"
    }
}

# Write report
$reportLines = @()
$reportLines += "╔══════════════════════════════════════════════════════════════════════╗"
$reportLines += "║          IGFXPRO — PRODUCTION CERTIFICATION REPORT                 ║"
$reportLines += "║          Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')                        ║"
$reportLines += "╚══════════════════════════════════════════════════════════════════════╝"
$reportLines += ""
$reportLines += "FASE 1 — CONNECTION POOL"
$reportLines += "  connection_limit : $cl  (BEFORE: 5, AFTER: $cl)"
$reportLines += "  pool_timeout     : ${pt}s"
$reportLines += "  connect_timeout  : ${ct}s"
$reportLines += "  PG conns before  : $pgConnBefore"
$reportLines += ""
$reportLines += "FASE 2 — MEASURED RESULTS (500 USERS)"
$reportLines += "  Order P50        : $(FmtMs $order_p50)"
$reportLines += "  Order P95        : $(FmtMs $order_p95)"
$reportLines += "  Order P99        : $(FmtMs $order_p99)"
$reportLines += "  Close P95        : $(FmtMs $close_p95)"
$reportLines += "  Wallet P95       : $(FmtMs $wallet_p95)"
$reportLines += "  HTTP error rate  : $(FmtPct $err_rate)"
$reportLines += "  Node processes   : $($tier500.infra.node_count)"
$reportLines += "  Node RSS         : $($tier500.infra.node_rss_mb) MB"
$reportLines += "  PG conns (post)  : $($tier500.infra.pg_conn_after)"
$reportLines += ""
$reportLines += "FASE 3 — ROOT CAUSE VALIDATION (connection_limit 5 → 10)"
if ($null -ne $beforeP95 -and $null -ne $afterP95) {
    $delta = [Math]::Round($afterP95 - $beforeP95, 0)
    $pct   = if ($beforeP95 -ne 0) { [Math]::Round(($delta / $beforeP95) * 100, 1) } else { 0 }
    $reportLines += "  Order P95 BEFORE : ${beforeP95}ms"
    $reportLines += "  Order P95 AFTER  : $(FmtMs $afterP95)"
    $reportLines += "  P95 delta        : ${delta}ms  (${pct}%)"
    $reportLines += "  Err BEFORE       : ${beforeErr}%"
    $reportLines += "  Err AFTER        : $(FmtPct $err_rate)"
} else {
    $reportLines += "  No baseline found in k6-500-summary.json — comparison skipped."
}
$reportLines += ""
$reportLines += "FASE 4 — CERTIFICATION CHECKS (500 USERS)"
foreach ($c in $checks) {
    $symbol = if ($c.pass) { "[PASS]" } else { "[FAIL]" }
    $reportLines += "  $symbol  $($c.label)   $($c.value)"
}
$reportLines += ""

if ($allPass) {
    $verdict = "FULL PRODUCTION READY"
} elseif ($orderOk -and $closeOk -and $noErrors -and $noDouble -and $noSwap) {
    $verdict = "BETA READY"
} elseif ($orderOk -and $closeOk) {
    $verdict = "LIMITED LIVE READY"
} else {
    $verdict = "NOT READY"
}

$reportLines += "════════════════════════════════════════════════"
$reportLines += "  VERDICT: $verdict  ($passCount/$($checks.Count) checks pass)"
$reportLines += "════════════════════════════════════════════════"
if ($bottleneck) {
    $reportLines += ""
    $reportLines += "BOTTLENECK IDENTIFIED:"
    $reportLines += "  $bottleneck"
}
$reportLines += ""
$reportLines += "Report saved to: $REPORT_DIR"

# Print report
$reportLines | ForEach-Object {
    if ($_ -match "PASS")     { Write-Host $_ -ForegroundColor Green }
    elseif ($_ -match "FAIL") { Write-Host $_ -ForegroundColor Red   }
    elseif ($_ -match "VERDICT") {
        $color = if ($verdict -eq "FULL PRODUCTION READY") { "Green" } else { "Yellow" }
        Write-Host $_ -ForegroundColor $color
    }
    else { Write-Host $_ }
}

# Save report
$reportPath = Join-Path $REPORT_DIR "CERTIFICATION_REPORT.txt"
$reportLines | Out-File $reportPath -Encoding utf8

# Save JSON summary
$summary = @{
    run_ts        = $RUN_TS
    verdict       = $verdict
    checks        = $checks
    results_500   = $r5
    results_250   = $tier250.results
    results_100   = $tier100.results
    infra_500     = $tier500.infra
    invariants    = $invariantResults
    pool_config   = $fase1Evidence
    bottleneck    = $bottleneck
}
$summary | ConvertTo-Json -Depth 5 | Out-File (Join-Path $REPORT_DIR "summary.json") -Encoding utf8

Write-Host "`nFull results in: $REPORT_DIR" -ForegroundColor Cyan
Write-Host "Report file:     $reportPath" -ForegroundColor Cyan

# Exit code: 0 = PASS, 1 = FAIL
exit $(if ($allPass) { 0 } else { 1 })
