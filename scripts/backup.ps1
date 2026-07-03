<#
.SYNOPSIS
  IGFXPRO PostgreSQL daily backup script.

.DESCRIPTION
  Creates a compressed pg_dump of the igfxpro database.
  Stores backups in BACKUP_DIR with timestamp naming.
  Retains the last RETAIN_DAYS days of backups (auto-prunes older files).
  Validates the backup file is non-empty after creation.

  Usage (from igfxpro-apiv2 directory):
    .\scripts\backup.ps1

  Scheduled Task (daily at 02:00):
    schtasks /create /tn "IGFXPRO-DB-Backup" /tr "powershell -File C:\...\scripts\backup.ps1" /sc daily /st 02:00

  Environment variables (override defaults):
    $env:BACKUP_DIR     -- backup destination folder (default: .\backups)
    $env:RETAIN_DAYS    -- days to keep backups (default: 30)
    $env:DB_CONTAINER   -- Docker container name (default: igfxpro-postgres)
    $env:DB_NAME        -- database name (default: igfxpro)
    $env:DB_USER        -- database user (default: igfxpro)
#>

param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"  # check $LASTEXITCODE manually for native commands

# Config (PowerShell 5.1 compatible defaults)
if ($env:BACKUP_DIR)   { $BACKUP_DIR   = $env:BACKUP_DIR   } else { $BACKUP_DIR   = ".\backups" }
if ($env:RETAIN_DAYS)  { $RETAIN_DAYS  = [int]$env:RETAIN_DAYS } else { $RETAIN_DAYS  = 30 }
if ($env:DB_CONTAINER) { $DB_CONTAINER = $env:DB_CONTAINER } else { $DB_CONTAINER = "igfxpro-postgres" }
if ($env:DB_NAME)      { $DB_NAME      = $env:DB_NAME      } else { $DB_NAME      = "igfxpro" }
if ($env:DB_USER)      { $DB_USER      = $env:DB_USER      } else { $DB_USER      = "igfxpro" }

$ts       = Get-Date -Format "yyyy-MM-dd_HHmmss"
$filename = "igfxpro-backup-$ts.sql.gz"
$outPath  = Join-Path $BACKUP_DIR $filename

# Setup
if (-not (Test-Path $BACKUP_DIR)) {
    New-Item -ItemType Directory -Force -Path $BACKUP_DIR | Out-Null
    Write-Host "[backup] Created backup directory: $BACKUP_DIR"
}

Write-Host "[backup] Starting backup -- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "[backup] Target: $outPath"

$startTime = Get-Date

# pg_dump via Docker:
#   1. pg_dump writes to /tmp inside the container (-Fc custom format = compressed binary)
#   2. docker cp copies the file to the host
$filename = "igfxpro-backup-$ts.dump"
$outPath  = Join-Path $BACKUP_DIR $filename
$tmpPath  = "/tmp/igfxpro-backup-$ts.dump"

docker exec $DB_CONTAINER pg_dump -U $DB_USER -d $DB_NAME --no-password -Fc -f $tmpPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "[backup] pg_dump FAILED (exit $LASTEXITCODE). Backup aborted."
    exit 1
}

docker cp "${DB_CONTAINER}:${tmpPath}" $outPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "[backup] docker cp FAILED (exit $LASTEXITCODE)."
    exit 1
}
docker exec $DB_CONTAINER rm -f $tmpPath 2>&1 | Out-Null

# Validate
if (-not (Test-Path $outPath)) {
    Write-Error "[backup] Output file not created. Aborting."
    exit 1
}
$fileSize = (Get-Item $outPath).Length
if ($fileSize -lt 1024) {
    Write-Error "[backup] Backup file is suspiciously small ($fileSize bytes). Possible empty dump."
    Remove-Item $outPath -Force
    exit 1
}

$elapsed = [int](New-TimeSpan -Start $startTime -End (Get-Date)).TotalSeconds
$sizeMB  = [math]::Round($fileSize / 1MB, 2)
Write-Host "[backup] SUCCESS -- $filename ($sizeMB MB) in ${elapsed}s"

# Quick restore-list validation (pg_restore --list reads the archive TOC)
Write-Host "[backup] Running restore validation (listing archive TOC)..."
# Copy file into container and list TOC
$copyArgs = @("cp", $outPath, "${DB_CONTAINER}:/tmp/validate.dump")
& docker @copyArgs 2>&1 | Out-Null
$tocOutput = docker exec $DB_CONTAINER pg_restore -U $DB_USER --list /tmp/validate.dump 2>&1
$tableCount = ($tocOutput | Select-String "TABLE DATA").Count
docker exec $DB_CONTAINER rm -f /tmp/validate.dump 2>&1 | Out-Null
Write-Host "[backup] Validation: $tableCount TABLE DATA section(s) found in archive"

# Prune old backups
$cutoff = (Get-Date).AddDays(-$RETAIN_DAYS)
$pruned = 0
Get-ChildItem -Path $BACKUP_DIR -Filter "igfxpro-backup-*.dump" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Host "[backup] Pruned old backup: $($_.Name)"
        $pruned++
    }

$remaining = (Get-ChildItem -Path $BACKUP_DIR -Filter "*.dump").Count
Write-Host "[backup] Done. Pruned $pruned old backup(s). $remaining backup(s) retained."
