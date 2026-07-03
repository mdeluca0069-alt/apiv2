param([string]$Script)
$env:PGPASSWORD = "igfxpro"
$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
Write-Host "--- Resetting wallets for $Script ---"
& $psql -h localhost -p 5435 -U igfxpro -d igfxpro -f "C:\Users\User\Downloads\Igfxpro-olos\igfxpro-apiv2\tests\reset_wallets.sql" 2>&1 | Select-String "rows|UPDATE|DELETE"
Write-Host "--- Running $Script ---"
Set-Location "C:\Users\User\Downloads\Igfxpro-olos\igfxpro-apiv2"
k6 run "tests/load/$Script" 2>&1
