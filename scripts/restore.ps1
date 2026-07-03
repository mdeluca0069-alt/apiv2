<#
.SYNOPSIS
  IGFXPRO PostgreSQL restore script from a backup .dump file.

.DESCRIPTION
  Restores a pg_dump custom-format (.dump) archive to a fresh database.

  *** DANGER: Drops and recreates the target database. ***
  *** Use only against a test/DR environment. ***

  Usage:
    .\scripts\restore.ps1 -BackupFile .\backups\igfxpro-backup-2026-06-12_020000.dump
    .\scripts\restore.ps1 -BackupFile .\backups\igfxpro-backup-2026-06-12_020000.dump -TargetDB igfxpro_restore -SkipConfirm

  Parameters:
    -BackupFile   Path to the .dump backup file (required)
    -TargetDB     Target database name (default: igfxpro_restore)
    -SkipConfirm  Skip interactive confirmation prompt (for CI/CD pipelines)
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [string]$TargetDB    = "igfxpro_restore",
    [string]$DBUser      = "igfxpro",
    [string]$DBContainer = "igfxpro-postgres",
    [switch]$SkipConfirm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"  # native exe stderr does not throw; we check $LASTEXITCODE manually

if ($env:DB_USER)      { $DBUser      = $env:DB_USER }
if ($env:DB_CONTAINER) { $DBContainer = $env:DB_CONTAINER }

# Validate backup file
if (-not (Test-Path $BackupFile)) {
    Write-Error "Backup file not found: $BackupFile"
    exit 1
}
$fileSize = (Get-Item $BackupFile).Length
if ($fileSize -lt 1024) {
    Write-Error "Backup file is suspiciously small ($fileSize bytes). Aborting."
    exit 1
}

Write-Host ""
Write-Host "=========================================================="
Write-Host "         IGFXPRO DATABASE RESTORE UTILITY"
Write-Host "=========================================================="
Write-Host ""
Write-Host "  Source : $BackupFile ($([math]::Round($fileSize/1MB,2)) MB)"
Write-Host "  Target : $TargetDB  (on container: $DBContainer)"
Write-Host ""

if (-not $SkipConfirm) {
    $answer = Read-Host "Type RESTORE to confirm (anything else aborts)"
    if ($answer -ne "RESTORE") {
        Write-Host "[restore] Aborted."
        exit 0
    }
}

$startTime = Get-Date
$tmpPath   = "/tmp/igfxpro-restore-$(Get-Date -Format 'yyyyMMddHHmmss').dump"

# Copy backup file into container
Write-Host "[restore] Copying backup into container..."
docker cp $BackupFile "${DBContainer}:${tmpPath}"
if ($LASTEXITCODE -ne 0) { Write-Error "docker cp failed"; exit 1 }

# Drop + recreate target database
Write-Host "[restore] Dropping '$TargetDB' (if exists) and recreating..."
docker exec $DBContainer psql -U $DBUser -d postgres -c "DROP DATABASE IF EXISTS `"$TargetDB`";" 2>&1 | Out-Null
docker exec $DBContainer psql -U $DBUser -d postgres -c "CREATE DATABASE `"$TargetDB`";" 2>&1 | Out-Null

# Restore
Write-Host "[restore] Running pg_restore..."
docker exec $DBContainer pg_restore -U $DBUser -d $TargetDB --no-owner --no-privileges -v $tmpPath 2>&1 |
    Where-Object { $_ -match "^pg_restore: (error|warning)" } |
    ForEach-Object { Write-Host "  $_" }

docker exec $DBContainer rm -f $tmpPath 2>&1 | Out-Null

# Validation: table counts
Write-Host "[restore] Validating restored database..."
function Invoke-PsqlQuery([string]$db, [string]$sql) {
    ($sql | docker exec -i $DBContainer psql -U $DBUser -d $db -t 2>&1) -join "" | ForEach-Object { $_.Trim() }
}

$tables    = Invoke-PsqlQuery $TargetDB "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"
$wallets   = Invoke-PsqlQuery $TargetDB 'SELECT COUNT(*) FROM "WalletAccount";'
$orders    = Invoke-PsqlQuery $TargetDB 'SELECT COUNT(*) FROM "Order";'
$positions = Invoke-PsqlQuery $TargetDB 'SELECT COUNT(*) FROM "Position";'
$ledger    = Invoke-PsqlQuery $TargetDB 'SELECT COUNT(*) FROM "LedgerEntry";'

# Margin invariant check
$invariantSql = @'
SELECT
  COUNT(*) FILTER (WHERE ABS(w.locked - p.sum_margin) > 0.01) AS mismatches,
  COUNT(*) AS users_checked
FROM (
  SELECT "userId", SUM("marginUsed") AS sum_margin
  FROM "Position" WHERE status = 'OPEN'
  GROUP BY "userId"
) p
JOIN "WalletAccount" w ON w."userId" = p."userId";
'@
$invariant = $invariantSql | docker exec -i $DBContainer psql -U $DBUser -d $TargetDB

$elapsed = [int](New-TimeSpan -Start $startTime -End (Get-Date)).TotalSeconds

Write-Host ""
Write-Host "=========================================================="
Write-Host "              RESTORE VALIDATION RESULTS"
Write-Host "=========================================================="
Write-Host "  Tables     : $tables"
Write-Host "  Wallets    : $wallets rows"
Write-Host "  Orders     : $orders rows"
Write-Host "  Positions  : $positions rows"
Write-Host "  Ledger     : $ledger rows"
Write-Host "  Duration   : ${elapsed}s"
Write-Host ""
Write-Host "  Margin invariant check:"
Write-Host $invariant
Write-Host ""
Write-Host "[restore] Done. Validate counts before promoting to production."
