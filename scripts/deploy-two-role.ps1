<#
  Staged, confirmation-gated deployment of Two-Role User Management.
  Windows PowerShell 5.1+. Run from the repository root:

    powershell -ExecutionPolicy Bypass -File .\scripts\deploy-two-role.ps1 -Stage check
    ... -Stage backup      (READ-ONLY: verified local backup of the 4 business tables; creates nothing in production)
    ... -Stage migrate     (re-verifies the backup, then applies the SQL migration; asks you to type APPLY)
    ... -Stage deploy      (deploys the admin-users Edge Function; asks to confirm)
    ... -Stage verify      (read-only checks of the live project)

  Safety:
   * Every command targets the explicit project ref below; link state is never trusted.
   * The script never reads, stores or prints access tokens, passwords or the service-role key.
   * 'check', 'backup' and 'verify' are read-only (the backup stage creates NO table or other object in production).
     Only 'migrate' (database\migrations\2026-11-23-two-role-user-management.sql, one transaction) and 'deploy' change anything.
   * 'migrate' refuses to run without a verified, fresh (default <= 6 h) backup whose row counts still match the database.
   * It never runs reset, drop-database, delete or any rollback by itself.
   * Any unexpected result stops the script (ErrorActionPreference = Stop).
#>
param(
  [ValidateSet('check', 'backup', 'migrate', 'deploy', 'verify')]
  [string]$Stage = 'check',
  # A backup older than this (hours) is never used by -Stage migrate.
  [double]$MaxBackupAgeHours = 6
)

$ErrorActionPreference = 'Stop'
$Ref = 'atmmjqwrqeidlqozuuje'
$Migration = 'database\migrations\2026-11-23-two-role-user-management.sql'
# SHA-256 of the migration exactly as reviewed and approved; -Stage migrate refuses to run any other bytes.
$ApprovedMigrationSha256 = '0938604beb09cc9c3a2007e7479fba909144d78057f77fe933c9a7c1ebbc9196'
$BackupDir = 'backups'
. (Join-Path $PSScriptRoot 'backup-lib.ps1')
Set-StrictMode -Off   # the library is strict for its own tests; this script keeps PowerShell's default behaviour

if (-not (Test-Path 'supabase\functions\admin-users\index.ts') -or -not (Test-Path $Migration)) {
  throw 'Run this script from the repository root (the folder that contains supabase\ and database\).'
}

function Invoke-Cli {
  # Runs the Supabase CLI through npx (no global install). Stops on a non-zero exit code.
  # Calls npx.cmd, NOT "npx": from a PowerShell session "npx" resolves to npx.ps1, which ignores its arguments and re-runs the SOURCE TEXT
  # of the calling statement. With "@args" that text is expanded inside npx.ps1, the command line is duplicated, and the CLI prints its
  # general help and EXITS 0 without doing anything. npx.cmd passes the arguments through unchanged.
  # The CLI writes a harmless "Target: project ..." banner to stderr. Under $ErrorActionPreference = 'Stop' some hosts turn any stderr line into a
  # terminating error, which could abort a write command half-way, so stderr text is not allowed to throw. The EXIT CODE is still checked below.
  $prevPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & npx.cmd --yes supabase @args } finally { $ErrorActionPreference = $prevPreference }
  if ($LASTEXITCODE -ne 0) { throw "supabase $($args -join ' ') failed with exit code $LASTEXITCODE" }
}
# All database access in this script is read-only and goes through Invoke-SupabaseReadQuery (SQL via --file, see backup-lib.ps1).
$ReadRunner = { param([string]$Sql) Invoke-SupabaseReadQuery -Ref $Ref -Sql $Sql }
function Invoke-Sql([string]$Sql) { Show-QueryRows (& $ReadRunner $Sql) }
function Confirm-Step([string]$Message, [string]$Word = 'yes') {
  Write-Host ''
  Write-Host $Message -ForegroundColor Yellow
  $answer = Read-Host "Type '$Word' to continue, anything else to stop"
  if ($answer -cne $Word) { throw 'Stopped by user. Nothing further was changed.' }
}

# ---------------------------------------------------------------- check
function Stage-Check {
  Write-Host "== CLI ==" -ForegroundColor Cyan
  $ver = (& npx --yes supabase --version 2>&1 | Out-String)
  if ($ver -match '(\d+\.\d+\.\d+)') { Write-Host "Supabase CLI $($Matches[1]) is available through npx (nothing installed globally)." -ForegroundColor Green }
  else { throw "Could not run the Supabase CLI through npx. Check Node/npm and your network." }
  Write-Host "== Login / project access ==" -ForegroundColor Cyan
  $list = (& npx --yes supabase projects list 2>&1) | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "Not logged in (or the CLI could not list projects). Run:  npx supabase login   (a browser window opens; nothing secret is printed), then re-run this stage.`nCLI said: $list"
  }
  if ($list -notmatch $Ref) { throw "Project $Ref was not found in the projects your account can access. Check you are logged in to the right account." }
  Write-Host "Project $Ref is visible to your account." -ForegroundColor Green
  Write-Host "== Link ==" -ForegroundColor Cyan
  Invoke-Cli link --project-ref $Ref
  $linkedFile = 'supabase\.temp\project-ref'
  if (Test-Path $linkedFile) {
    $linked = (Get-Content $linkedFile -Raw).Trim()
    if ($linked -ne $Ref) { throw "Linked project is '$linked', expected '$Ref'." }
    Write-Host "Linked project ref verified: $linked" -ForegroundColor Green
  } else { Write-Warning "Could not read $linkedFile to double-check the link; all commands still use the explicit ref $Ref." }

  Write-Host "== Read-only pre-flight on the live database ==" -ForegroundColor Cyan
  # (the CLI rejects DO blocks under --read-only, so the checks are one SELECT whose columns are verdicts)
  $pf = Get-CliRow (& $ReadRunner @'
select
  (to_regclass('public.snack_records') is not null and to_regclass('public.employees') is not null
   and to_regclass('public.snacks') is not null and to_regclass('public.user_profiles') is not null) as tables_exist,
  exists (select 1 from public.user_profiles where role = 'admin') as admin_exists,
  not exists (select 1 from public.user_profiles where role not in ('admin', 'employee', 'user')) as roles_known,
  not exists (select 1 from public.user_profiles where employee_id is not null group by employee_id having count(*) > 1) as one_login_per_employee,
  (to_regprocedure('public.delete_employee_permanently(bigint)') is not null) as has_delete_employee_fn,
  (to_regprocedure('public.delete_snack_permanently(bigint)') is not null) as has_delete_snack_fn,
  (to_regprocedure('public.admin_list_users()') is not null) as migration_already_applied
'@) @('tables_exist', 'admin_exists', 'roles_known', 'one_login_per_employee', 'migration_already_applied')
  $problems = @()
  if (-not $pf['tables_exist']) { $problems += 'an expected table is missing' }
  if (-not $pf['admin_exists']) { $problems += 'no admin profile exists (run database/link_supabase_admin.sql first)' }
  if (-not $pf['roles_known']) { $problems += 'unexpected role values in user_profiles' }
  if (-not $pf['one_login_per_employee']) { $problems += 'two profiles share one employee' }
  if ($problems) { throw "PRECHECK FAILED: $($problems -join '; '). Do not migrate." }
  if (-not $pf['has_delete_employee_fn'] -or -not $pf['has_delete_snack_fn']) { Write-Warning 'A permanent-delete function is not installed in this project (the migration does not touch them).' }
  if ($pf['migration_already_applied']) { Write-Host 'Note: the migration already appears to be applied (re-running it is safe).' -ForegroundColor Yellow }
  Write-Host "Pre-flight passed." -ForegroundColor Green
  Write-Host "== Current state (read-only) ==" -ForegroundColor Cyan
  Invoke-Sql "select role, count(*) as profiles from public.user_profiles group by role order by role"
  Invoke-Sql "select (select count(*) from public.employees) as employees, (select count(*) from public.snacks) as snacks, (select count(*) from public.snack_records) as snack_records"
}

# ---------------------------------------------------------------- backup
function Stage-Backup {
  Assert-WindowsPowerShell
  # 1. Backups must never be committable.
  New-Item -ItemType Directory -Force $BackupDir | Out-Null
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    & git check-ignore -q "$BackupDir/probe.json"
    if ($LASTEXITCODE -ne 0) { throw "STOP: '$BackupDir/' is not git-ignored. Add 'backups/' to .gitignore before taking a backup (it holds business data)." }
    $tracked = & git ls-files -- $BackupDir
    if ($tracked) { throw "STOP: files under '$BackupDir/' are tracked by git. Remove them from the index first." }
  } else { Write-Warning 'git not found: could not verify that backups/ is ignored. Do not commit the backups folder.' }

  # 2-3. Export, parse, count-check, hash, write manifest last, rename. Throws (and stops the deployment) on any problem.
  $final = New-VerifiedBackup -Runner $ReadRunner -Root $BackupDir -Ref $Ref
  $createdUtc = (ConvertFrom-JsonText ([IO.File]::ReadAllText((Join-Path $final 'manifest.json'), (Get-Utf8NoBom))))['createdUtc']

  # 4. Independent re-verification of the finished folder, exactly as -Stage migrate will do it.
  $live = @{}; foreach ($t in $script:BackupTables.Keys) { $live[$t] = Get-TableCount $ReadRunner $t }
  [void](Test-BackupFolder -Dir $final -Ref $Ref -MaxAgeHours 1 -LiveCounts $live)
  Write-Host ''
  Write-Host "BACKUP VERIFIED: $final" -ForegroundColor Green
  $verified = Test-BackupFolder -Dir $final -Ref $Ref
  foreach ($t in $script:BackupTables.Keys) { $e = $verified['tables'][$t]; "  {0,-14} {1,8} rows  {2,12:N0} bytes  sha256 {3}" -f $t, $e['rowCount'], $e['bytes'], ([string]$e['sha256']).Substring(0, 12) }
  Write-Host "  taken $createdUtc for project $Ref. Nothing was created or changed in production."
  Write-Host "Keep this folder private (business data, git-ignored). Restore help: .\scripts\restore-from-backup.ps1" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- migrate
function Stage-Migrate {
  Assert-WindowsPowerShell
  $dir = Find-LatestBackupFolder -Root $BackupDir -Ref $Ref
  Write-Host "Checking backup $dir ..." -ForegroundColor Cyan
  $live = @{}; foreach ($t in $script:BackupTables.Keys) { $live[$t] = Get-TableCount $ReadRunner $t }
  $manifest = Test-BackupFolder -Dir $dir -Ref $Ref -MaxAgeHours $MaxBackupAgeHours -LiveCounts $live   # throws on any problem
  Write-Host ("Backup is verified: taken {0}, every file re-parsed, SHA-256 matches, and row counts equal the live database ({1})." -f $manifest['createdUtc'], (($script:BackupTables.Keys | ForEach-Object { "$_=$($live[$_])" }) -join ', ')) -ForegroundColor Green
  # Show exactly what will run, and refuse any bytes other than the approved migration.
  $migPath = (Resolve-Path -LiteralPath $Migration).Path
  $migSha = Get-FileSha256 $migPath
  Write-Host ("Migration file: {0}`n  {1:N0} bytes, {2} lines, SHA-256 {3}" -f $migPath, (Get-Item -LiteralPath $migPath).Length, @([IO.File]::ReadAllLines($migPath)).Count, $migSha) -ForegroundColor Cyan
  if ($migSha -cne $ApprovedMigrationSha256) { throw "STOP: $Migration is not the approved file (approved SHA-256 $ApprovedMigrationSha256). Nothing was changed." }
  # Never apply twice, and never continue from a half-applied database.
  $before = Get-MigrationState $ReadRunner
  if ($before.State -eq 'applied') { throw "STOP: the two-role migration is ALREADY applied to $Ref (all $(@($before.Present).Count) markers present). It was not applied again and nothing was changed. Continue with the next approved step." }
  if ($before.State -eq 'partial') { throw "STOP: the live database is PARTIALLY migrated. Present: $($before.Present -join '; '). Missing: $($before.Missing -join '; '). Do NOT run the migration again. Nothing was changed. Review it with the rollback plan in docs\USER_MANAGEMENT_SETUP.md first." }
  Write-Host 'Live database is in the original state (no part of the migration is present).' -ForegroundColor Green
  Confirm-Step "About to APPLY $Migration to PRODUCTION project $Ref.`nIt rewrites only user_profiles.role ('employee' -> 'user'), adds columns/functions/policies, and runs in one transaction. It does not modify employees, snacks or snack_records.`nBackup used: $dir`nRollback: database\migrations\2026-11-23-two-role-user-management.rollback.sql" 'APPLY'
  Invoke-Cli db query "--remote=$Ref" --file $Migration
  # Exit code 0 is NOT proof (the CLI also exits 0 when it merely prints help). Only the database state counts.
  Write-Host 'The CLI command finished. Checking that the migration really is in the database...' -ForegroundColor Cyan
  $after = Get-MigrationState $ReadRunner
  if ($after.State -eq 'not-applied') { throw "STOP: the CLI reported success but NOTHING was applied (no migration marker is present). The database is unchanged. This is not done: find out why the command did not run." }
  if ($after.State -eq 'partial') { throw "STOP: the migration is only PARTIALLY applied. Present: $($after.Present -join '; '). Missing: $($after.Missing -join '; '). Do NOT run it again. Review, then use the reviewed rollback (database\migrations\2026-11-23-two-role-user-management.rollback.sql) after approval." }
  Write-Host ("Migration is in the database: all {0} markers present." -f @($after.Present).Count) -ForegroundColor Green
  foreach ($t in $script:BackupTables.Keys) {
    $now = Get-TableCount $ReadRunner $t
    if ($now -ne $live[$t]) { throw "STOP: $t had $($live[$t]) rows before the migration and has $now now. Do not continue. Investigate; restore with scripts\restore-from-backup.ps1 and the rollback script if needed." }
  }
  Write-Host "Row counts identical before and after for all four tables." -ForegroundColor Green
  $pc = Get-CliRow (& $ReadRunner @'
select
  not exists (select 1 from public.user_profiles where role not in ('admin', 'user')) as roles_ok,
  exists (select 1 from public.user_profiles where role = 'admin' and active) as active_admin,
  (to_regprocedure('public.admin_list_users()') is not null
   and to_regprocedure('public.complete_password_change()') is not null
   and to_regprocedure('public.service_register_user(uuid,bigint)') is not null) as new_functions
'@) @('roles_ok', 'active_admin', 'new_functions')
  $bad = @(); foreach ($k in 'roles_ok', 'active_admin', 'new_functions') { if (-not $pc[$k]) { $bad += $k } }
  if ($bad) { throw "POSTCHECK FAILED after the migration was applied ($($bad -join ', ')). Do not continue: review the output, then roll back with database\migrations\2026-11-23-two-role-user-management.rollback.sql if needed." }
  Write-Host 'Post-migration checks passed (roles are admin/user only, an active admin exists, new functions are installed).' -ForegroundColor Green
  Invoke-Sql "select role, count(*) as profiles from public.user_profiles group by role order by role"
  Write-Host "Migration verified. Next: -Stage deploy" -ForegroundColor Green
}

# ---------------------------------------------------------------- deploy
function Stage-Deploy {
  Invoke-Sql "select to_regprocedure('public.admin_list_users()') is not null as migration_applied" | Out-Host
  Confirm-Step "About to deploy the Edge Function 'admin-users' to project $Ref (no database change). It authenticates callers itself, so --no-verify-jwt is used."
  Invoke-Cli functions deploy admin-users --no-verify-jwt --use-api --project-ref $Ref
  Write-Host "Function secrets (names only; SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase, you add none):" -ForegroundColor Cyan
  Invoke-Cli secrets list --project-ref $Ref
  Write-Host "Deployed. Next: -Stage verify" -ForegroundColor Green
}

# ---------------------------------------------------------------- verify
function Stage-Verify {
  $url = "https://$Ref.supabase.co"
  $key = ((Get-Content 'frontend\.env.local' | Where-Object { $_ -match '^VITE_SUPABASE_PUBLISHABLE_KEY=' }) -replace '^[^=]+=', '').Trim()
  function Probe([string]$Name, [string]$Path, [string]$Body, [hashtable]$Headers) {
    try { $r = Invoke-WebRequest -Uri "$url$Path" -Method Post -Body $Body -ContentType 'application/json' -Headers $Headers -UseBasicParsing; "{0}: HTTP {1}" -f $Name, $r.StatusCode }
    catch { $resp = $_.Exception.Response; $text = ''
      if ($resp) { $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd(); "{0}: HTTP {1}  {2}" -f $Name, [int]$resp.StatusCode, $text } else { "{0}: {1}" -f $Name, $_.Exception.Message } }
  }
  Write-Host "Expected: Edge Function 401 'Sign in required.'; admin_list_users 401/403 (NOT 404); complete_password_change 401/403 (NOT 404)." -ForegroundColor Cyan
  Probe 'admin-users (no token)' '/functions/v1/admin-users' '{}' @{}
  Probe 'admin_list_users (anon key)' '/rest/v1/rpc/admin_list_users' '{}' @{ apikey = $key }
  Probe 'complete_password_change (anon key)' '/rest/v1/rpc/complete_password_change' '{}' @{ apikey = $key }
  Probe 'service_register_user (anon key)' '/rest/v1/rpc/service_register_user' '{"p_user_id":"00000000-0000-0000-0000-000000000000","p_employee_id":0}' @{ apikey = $key }
  Write-Host "Now do the manual sign-in checklist in docs\USER_MANAGEMENT_SETUP.md (these probes do not replace it)." -ForegroundColor Yellow
}

switch ($Stage) {
  'check'   { Stage-Check }
  'backup'  { Stage-Backup }
  'migrate' { Stage-Migrate }
  'deploy'  { Stage-Deploy }
  'verify'  { Stage-Verify }
}
