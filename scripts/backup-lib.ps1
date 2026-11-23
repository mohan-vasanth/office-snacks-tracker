<#
  Shared backup/verification helpers for deploy-two-role.ps1 and restore-from-backup.ps1 (dot-sourced).
  No network access and no database access happen here: the caller passes a -Runner scriptblock that takes a SQL
  string and returns the Supabase CLI's text output. Targets Windows PowerShell 5.1.
#>
Set-StrictMode -Version 2.0

# Tables that are backed up, and the unique key used for stable paging and duplicate detection.
$script:BackupTables = [ordered]@{ employees = 'id'; snacks = 'id'; snack_records = 'id'; user_profiles = 'user_id' }
$script:ExportPageSize = 500

function Assert-WindowsPowerShell {
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    throw "Run this with Windows PowerShell 5.1 (the 'powershell' command, not 'pwsh'): powershell -ExecutionPolicy Bypass -File <script>"
  }
}
function Get-Utf8NoBom { New-Object System.Text.UTF8Encoding($false) }
# JavaScriptSerializer returns Dictionary<string,object>, whose Contains() is only reachable through IDictionary.
function Test-JsonKey($Dict, [string]$Key) { return ([System.Collections.IDictionary]$Dict).Contains($Key) }

# JavaScriptSerializer: no 2 MB limit (unlike ConvertFrom-Json in 5.1) and no date-string conversion.
function ConvertFrom-JsonText([string]$Text) {
  Assert-WindowsPowerShell
  Add-Type -AssemblyName System.Web.Extensions
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = [int]::MaxValue
  $ser.RecursionLimit = 200
  $parsed = $ser.DeserializeObject($Text)
  return , $parsed   # the comma stops PowerShell unrolling a JSON array into its elements (0- and 1-element arrays!)
}

# Finds the first object (anywhere in the parsed output) that has all the required property names.
function Find-JsonObject($Node, [string[]]$Required, [int]$Depth = 0) {
  if ($null -eq $Node -or $Depth -gt 12 -or $Node -is [string]) { return $null }
  if ($Node -is [System.Collections.IDictionary]) {
    $hasAll = $true
    foreach ($k in $Required) { if (-not (Test-JsonKey $Node $k)) { $hasAll = $false; break } }
    if ($hasAll) { return $Node }
    foreach ($v in $Node.Values) { $f = Find-JsonObject $v $Required ($Depth + 1); if ($null -ne $f) { return $f } }
    return $null
  }
  if ($Node -is [System.Collections.IEnumerable]) {
    foreach ($v in $Node) { $f = Find-JsonObject $v $Required ($Depth + 1); if ($null -ne $f) { return $f } }
  }
  return $null
}

# Reads one result row from the CLI's output without depending on its exact wrapper format.
function Get-CliRow([string]$Text, [string[]]$Required) {
  $candidates = New-Object System.Collections.Generic.List[string]
  $candidates.Add($Text)
  $first = $Text.IndexOfAny([char[]]'{['); $last = $Text.LastIndexOfAny([char[]]'}]')
  if ($first -ge 0 -and $last -gt $first) { $candidates.Add($Text.Substring($first, $last - $first + 1)) }
  foreach ($line in ($Text -split "`r?`n")) { if ($line.Trim().Length -gt 1) { $candidates.Add($line.Trim()) } }
  foreach ($c in $candidates) {
    try { $parsed = ConvertFrom-JsonText $c } catch { continue }
    $row = Find-JsonObject $parsed $Required
    if ($null -ne $row) { return $row }
  }
  $preview = ($Text.Substring(0, [Math]::Min(160, $Text.Length))) -replace '\s+', ' '
  throw "Could not read the expected result ($($Required -join ', ')) from the Supabase CLI output. Output began: $preview"
}

function Get-TableCount([scriptblock]$Runner, [string]$Table) {
  if (-not $script:BackupTables.Contains($Table)) { throw "Unknown table '$Table'." }
  $row = Get-CliRow (& $Runner "select count(*)::int as n from public.$Table") @('n')
  return [int]$row['n']
}

# Exports a whole table in stable key order, page by page. Throws unless every page is internally consistent and the
# exported total equals the database row count both BEFORE and AFTER the export (detects truncation and concurrent writes).
function Invoke-TableExport([scriptblock]$Runner, [string]$Table) {
  if (-not $script:BackupTables.Contains($Table)) { throw "Unknown table '$Table'." }
  $key = $script:BackupTables[$Table]
  $page = $script:ExportPageSize
  $before = Get-TableCount $Runner $Table
  $parts = New-Object System.Collections.Generic.List[string]
  $total = 0; $offset = 0
  while ($true) {
    $sql = "select count(*)::int as n, coalesce(json_agg(t)::text, '[]') as payload from (select * from public.$Table order by $key limit $page offset $offset) t"
    $row = Get-CliRow (& $Runner $sql) @('n', 'payload')
    $n = [int]$row['n']
    $payload = ([string]$row['payload']).Trim()
    if (-not ($payload.StartsWith('[') -and $payload.EndsWith(']'))) { throw "$Table export page at offset $offset is not a JSON array." }
    $items = ConvertFrom-JsonText $payload
    $actual = @($items).Count
    if ($actual -ne $n) { throw "$Table export page at offset ${offset}: the database reported $n rows but the payload holds $actual." }
    if ($n -gt 0) { $parts.Add($payload.Substring(1, $payload.Length - 2).Trim()) }
    $total += $n; $offset += $page
    if ($n -lt $page) { break }
    if ($offset -gt 50000000) { throw "$Table export did not terminate." }
  }
  $after = Get-TableCount $Runner $Table
  if ($before -ne $total -or $after -ne $total) {
    throw "$Table export is NOT trustworthy: exported $total rows, database had $before before and $after after. Data changed during the export or the export was incomplete. Re-run the backup."
  }
  return [pscustomobject]@{ Table = $Table; Key = $key; RowCount = $total; CountBefore = $before; CountAfter = $after; Body = ($parts -join ',') }
}

function Write-TableBackupFile([string]$Dir, $Export, [string]$Ref, [string]$CreatedUtc) {
  $meta = [ordered]@{ table = $Export.Table; key = $Export.Key; project = $Ref; createdUtc = $CreatedUtc; rowCount = $Export.RowCount }
  $text = '{"meta":' + (ConvertTo-Json -InputObject $meta -Compress) + ',"rows":[' + $Export.Body + ']}'
  $path = Join-Path $Dir ($Export.Table + '.json')
  if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing backup file $path" }
  [IO.File]::WriteAllText($path, $text, (Get-Utf8NoBom))
  return $path
}

# Re-reads a table backup from disk, parses it, and checks it against the expected row count.
function Test-TableBackupFile([string]$Path, [string]$Table, [string]$Ref, [int]$ExpectedCount) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Backup file is missing: $Path" }
  $text = [IO.File]::ReadAllText($Path, (Get-Utf8NoBom))
  try { $doc = ConvertFrom-JsonText $text } catch { throw "$Table backup is not valid JSON: $($_.Exception.Message)" }
  if (-not ($doc -is [System.Collections.IDictionary]) -or -not (Test-JsonKey $doc 'meta') -or -not (Test-JsonKey $doc 'rows')) { throw "$Table backup has no meta/rows sections." }
  $meta = $doc['meta']; $rows = @($doc['rows'])
  if ([string]$meta['table'] -cne $Table) { throw "$Table backup is labelled '$($meta['table'])'." }
  if ([string]$meta['project'] -cne $Ref) { throw "$Table backup belongs to project '$($meta['project'])', expected '$Ref'." }
  if ([int]$meta['rowCount'] -ne $rows.Count) { throw "$Table backup is incomplete: header says $($meta['rowCount']) rows, file holds $($rows.Count)." }
  if ($rows.Count -ne $ExpectedCount) { throw "$Table backup holds $($rows.Count) rows but $ExpectedCount were expected." }
  $key = $script:BackupTables[$Table]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($r in $rows) {
    if (-not ($r -is [System.Collections.IDictionary]) -or -not (Test-JsonKey $r $key) -or $null -eq $r[$key]) { throw "$Table backup contains a row without its key '$key'." }
    if (-not $seen.Add([string]$r[$key])) { throw "$Table backup contains a duplicate $key '$($r[$key])'." }
  }
  return $rows.Count
}

# A small query (policies + function definitions) kept for reference. Validated like the data, but not restored.
function Invoke-ReferenceExport([scriptblock]$Runner) {
  $sql = @"
select count(*)::int as n, coalesce(json_agg(t)::text, '[]') as payload from (
  select 'policy' as kind, tablename || '.' || policyname as name, permissive || ' ' || cmd || ' USING ' || coalesce(qual, '') || ' CHECK ' || coalesce(with_check, '') as definition from pg_policies where schemaname = 'public'
  union all
  select 'function', p.proname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('current_office_role', 'current_office_employee_id', 'delete_employee_permanently', 'delete_snack_permanently')
) t
"@
  $row = Get-CliRow (& $Runner $sql) @('n', 'payload')
  $payload = ([string]$row['payload']).Trim()
  $items = ConvertFrom-JsonText $payload
  if (@($items).Count -ne [int]$row['n'] -or [int]$row['n'] -lt 1) { throw 'Schema reference export is empty or inconsistent.' }
  return $payload
}

function Get-FileSha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}

# Verifies a finished backup folder from disk: manifest, project, age, per-file size + SHA-256, full re-parse, row counts.
# -MaxAgeHours 0 disables the age check (used for restores). -LiveCounts (table -> count) must equal the manifest when given.
function Test-BackupFolder([string]$Dir, [string]$Ref, [double]$MaxAgeHours = 0, [hashtable]$LiveCounts = $null) {
  $manifestPath = Join-Path $Dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "No manifest.json in $Dir (the backup never completed)." }
  try { $m = ConvertFrom-JsonText ([IO.File]::ReadAllText($manifestPath, (Get-Utf8NoBom))) } catch { throw "manifest.json is not valid JSON." }
  if ([string]$m['status'] -cne 'verified') { throw "Backup status is '$($m['status'])', not 'verified'." }
  if ([string]$m['projectRef'] -cne $Ref) { throw "Backup is for project '$($m['projectRef'])', expected '$Ref'." }
  $created = [datetime]::ParseExact([string]$m['createdUtc'], 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  $ageHours = ([datetime]::UtcNow - $created.ToUniversalTime()).TotalHours
  if ($MaxAgeHours -gt 0 -and $ageHours -gt $MaxAgeHours) { throw ("Backup is {0:N1} hours old (limit {1} h). Take a fresh backup." -f $ageHours, $MaxAgeHours) }
  if ($ageHours -lt -0.1) { throw 'Backup timestamp is in the future.' }
  foreach ($table in $script:BackupTables.Keys) {
    if (-not (Test-JsonKey $m['tables'] $table)) { throw "Manifest has no entry for $table." }
    $entry = $m['tables'][$table]
    $path = Join-Path $Dir ([string]$entry['file'])
    if (-not (Test-Path -LiteralPath $path)) { throw "Backup file missing: $path" }
    if ((Get-Item -LiteralPath $path).Length -ne [long]$entry['bytes']) { throw "$table backup size changed since it was written." }
    if ((Get-FileSha256 $path) -cne [string]$entry['sha256']) { throw "$table backup content changed since it was written (SHA-256 mismatch)." }
    [void](Test-TableBackupFile -Path $path -Table $table -Ref $Ref -ExpectedCount ([int]$entry['rowCount']))
    if ($null -ne $LiveCounts) {
      if (-not $LiveCounts.ContainsKey($table) -or [int]$LiveCounts[$table] -ne [int]$entry['rowCount']) {
        throw "$table now has $($LiveCounts[$table]) rows in the database but the backup has $($entry['rowCount']). Data changed since the backup; take a fresh backup."
      }
    }
  }
  $refEntry = $m['reference']   # NB: not $ref - PowerShell names are case-insensitive and would clobber the [string]$Ref parameter
  $refPath = Join-Path $Dir ([string]$refEntry['file'])
  if (-not (Test-Path -LiteralPath $refPath) -or (Get-FileSha256 $refPath) -cne [string]$refEntry['sha256']) { throw 'Schema reference file is missing or changed.' }
  return $m
}

# Newest folder under $Root that carries a manifest (folders still named *-INCOMPLETE are ignored).
function Find-LatestBackupFolder([string]$Root, [string]$Ref) {
  if (-not (Test-Path -LiteralPath $Root)) { throw "No backups folder ($Root). Run -Stage backup first." }
  $dirs = Get-ChildItem -LiteralPath $Root -Directory | Where-Object { $_.Name -like "*-$Ref" -and (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json')) } | Sort-Object Name -Descending
  if (-not $dirs) { throw "No completed backup for $Ref under $Root. Run -Stage backup first." }
  return $dirs[0].FullName
}

# Builds a complete backup in "<Root>\<UTC stamp>-<Ref>-INCOMPLETE", verifies every file from disk, writes manifest.json
# LAST, then renames the folder to its final name. Any failure throws and leaves the -INCOMPLETE folder behind
# (never accepted by Find-LatestBackupFolder). Never overwrites or reuses an earlier backup. Read-only against the database.
function New-VerifiedBackup([scriptblock]$Runner, [string]$Root, [string]$Ref, [datetime]$Now = [datetime]::UtcNow) {
  New-Item -ItemType Directory -Force $Root | Out-Null
  $stamp = $Now.ToString('yyyyMMddTHHmmssZ')
  $createdUtc = $Now.ToString('o')
  $final = Join-Path $Root "$stamp-$Ref"
  $work = "$final-INCOMPLETE"
  if ((Test-Path -LiteralPath $final) -or (Test-Path -LiteralPath $work)) { throw "Backup folder $final already exists; wait a second and retry." }
  New-Item -ItemType Directory $work | Out-Null
  Write-Host "Backing up project $Ref (read-only) into $final ..." -ForegroundColor Cyan

  $tables = [ordered]@{}
  foreach ($t in $script:BackupTables.Keys) {
    Write-Host "  exporting $t ..." -NoNewline
    $export = Invoke-TableExport -Runner $Runner -Table $t
    $path = Write-TableBackupFile -Dir $work -Export $export -Ref $Ref -CreatedUtc $createdUtc
    [void](Test-TableBackupFile -Path $path -Table $t -Ref $Ref -ExpectedCount $export.RowCount)   # re-read from disk and parse
    $tables[$t] = [ordered]@{ file = "$t.json"; rowCount = $export.RowCount; dbCountBefore = $export.CountBefore; dbCountAfter = $export.CountAfter; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileSha256 $path) }
    Write-Host (" {0} rows, {1:N0} bytes, verified" -f $export.RowCount, $tables[$t].bytes) -ForegroundColor Green
  }
  Write-Host "  exporting schema reference (policies, helper functions) ..." -NoNewline
  $refPayload = Invoke-ReferenceExport -Runner $Runner
  $refPath = Join-Path $work 'schema-reference.json'
  [IO.File]::WriteAllText($refPath, $refPayload, (Get-Utf8NoBom))
  Write-Host ' ok' -ForegroundColor Green

  $manifest = [ordered]@{
    schemaVersion = 1; status = 'verified'; projectRef = $Ref; createdUtc = $createdUtc
    machine = $env:COMPUTERNAME; tool = 'backup-lib.ps1'; tables = $tables
    reference = [ordered]@{ file = 'schema-reference.json'; bytes = (Get-Item -LiteralPath $refPath).Length; sha256 = (Get-FileSha256 $refPath) }
  }
  [IO.File]::WriteAllText((Join-Path $work 'manifest.json'), (ConvertTo-Json -InputObject $manifest -Depth 6), (Get-Utf8NoBom))
  Rename-Item -LiteralPath $work -NewName (Split-Path $final -Leaf)
  return $final
}

# Runs ONE read-only query through the Supabase CLI and returns its stdout (JSON).
#  * The SQL goes through --file, never as a command-line argument. On Windows "npx" is a .cmd shim and cmd.exe cuts a
#    command line at the first newline, so any multi-line SQL passed as an argument reaches Postgres truncated
#    (proven: "select 1<newline>as n" came back without its alias, and "...from (<newline>select 2) t" gave 42601 syntax error
#    at end of input). A file keeps the SQL byte-for-byte.
#  * stdout (the result) is kept apart from stderr (the "Target: project ... (ref)" banner); a banner can never corrupt data.
#  * Fails on a non-zero exit code, and refuses to continue if the CLI says it targeted another project than $Ref.
function Invoke-SupabaseReadQuery([string]$Ref, [string]$Sql) {
  $sqlFile = Join-Path ([IO.Path]::GetTempPath()) ('sb-readonly-' + [guid]::NewGuid().ToString('N') + '.sql')
  $errFile = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($sqlFile, $Sql, (Get-Utf8NoBom))
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = (& npx --yes supabase db query "--remote=$Ref" --read-only --output-format json --file $sqlFile 2>$errFile | Out-String)
    $code = $LASTEXITCODE
    $err = [IO.File]::ReadAllText($errFile)
  } finally {
    $ErrorActionPreference = $prev
    Remove-Item -LiteralPath $sqlFile, $errFile -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { throw ("Supabase query failed (exit {0}): {1} {2}" -f $code, $err.Trim(), $out.Substring(0, [Math]::Min(300, $out.Length))) }
  if ($err -match 'Target:' -and $err -notmatch [regex]::Escape("($Ref)")) { throw "STOP: the Supabase CLI targeted a different project than $Ref. Banner: $($err.Trim())" }
  return $out
}

# Returns the result rows of a CLI query as an array of dictionaries. It understands every shape the CLI produces:
#   normal terminal (CLI 3.3.0, --output-format json):  [ { "col": value, ... }, ... ]           (no rows: [])
#   AI-agent session / older CLI:                        { "boundary": "...", "rows": [ ... ], "warning": "..." }
#   the same wrapper nested deeper:                       { "_tag": "Success", "data": { "rows": [ ... ] } }
# An empty result, malformed JSON, or "rows" that are not objects are NEVER reported as success.
function Get-CliRows([string]$Text) {
  $candidates = New-Object System.Collections.Generic.List[string]
  $candidates.Add($Text)
  $first = $Text.IndexOfAny([char[]]'{['); $last = $Text.LastIndexOfAny([char[]]'}]')
  if ($first -ge 0 -and $last -gt $first) { $candidates.Add($Text.Substring($first, $last - $first + 1)) }
  foreach ($line in ($Text -split "`r?`n")) { if ($line.Trim().Length -gt 1) { $candidates.Add($line.Trim()) } }
  $sawEmpty = $false
  foreach ($c in $candidates) {
    try { $parsed = ConvertFrom-JsonText $c } catch { continue }
    $rows = $null
    if ($parsed -is [System.Collections.IEnumerable] -and $parsed -isnot [string] -and $parsed -isnot [System.Collections.IDictionary]) {
      $rows = @($parsed)                                  # direct array: checked first, so a COLUMN named "rows" is never mistaken for a wrapper
    } else {
      $wrapper = Find-JsonObject $parsed @('rows')
      if ($null -ne $wrapper -and $wrapper['rows'] -is [System.Collections.IEnumerable] -and $wrapper['rows'] -isnot [string]) { $rows = @($wrapper['rows']) }
    }
    if ($null -eq $rows) { continue }
    if ($rows.Count -eq 0) { $sawEmpty = $true; continue }
    if (@($rows | Where-Object { $_ -isnot [System.Collections.IDictionary] }).Count -eq 0) { return , $rows }
  }
  if ($sawEmpty) { throw 'The CLI returned no rows (an empty result is not accepted).' }
  $preview = ($Text.Substring(0, [Math]::Min(160, $Text.Length))) -replace '\s+', ' '
  throw "Could not read result rows from the Supabase CLI output (expected a JSON array of rows, or an object with a rows array). Output began: $preview"
}

# Prints the rows of a CLI result as "column=value, ..." lines.
function Show-QueryRows([string]$Text) {
  foreach ($r in (Get-CliRows $Text)) { Write-Host ('  ' + ((@($r.Keys) | ForEach-Object { "$_=$($r[$_])" }) -join ', ')) }
}

# ---------------------------------------------------------------- migration state (read-only)
# One plain SELECT (the CLI refuses DO blocks under --read-only). Each column is a marker that exists ONLY after
# database/migrations/2026-11-23-two-role-user-management.sql has been applied. Exit codes and row counts prove nothing about a
# migration: only these markers do.
$script:MigrationStateSql = @'
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'user_profiles' and column_name in ('active', 'created_at', 'must_change_password', 'password_snapshot'))::int as new_columns,
  exists (select 1 from pg_constraint where conrelid = 'public.user_profiles'::regclass and conname = 'chk_user_profile_role') as role_check,
  (to_regclass('public.uk_user_profiles_user_employee') is not null) as unique_index,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_list_users', 'service_register_user', 'service_flag_password_reset', 'complete_password_change', 'snack_record_user_guard'))::int as new_functions,
  exists (select 1 from pg_trigger where tgname = 'trg_snack_record_user_guard' and not tgisinternal) as guard_trigger,
  coalesce((select prosrc ilike '%must_change_password%' from pg_proc where pronamespace = 'public'::regnamespace and proname = 'current_office_role' limit 1), false) as role_function_updated,
  exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'office_records_update_guard' and qual not ilike '%current_office_employee_id%') as records_update_admin_only
'@

# 'applied'     = every marker present.
# 'not-applied' = none of the STRUCTURAL markers is present. The 4 new user_profiles columns are deliberately ignored for this decision:
#                 the reviewed rollback keeps them (harmless; dropping them would discard account state), and the migration re-applies
#                 cleanly over them (ADD COLUMN IF NOT EXISTS), so "columns only" is a normal rolled-back database, not a partial one.
# 'partial'     = anything else. Never re-run the migration from a partial state.
function Test-MigrationStateRow($Row) {
  $columns = ([int]$Row['new_columns'] -eq 4)
  $structural = [ordered]@{
    'constraint chk_user_profile_role'            = ([bool]$Row['role_check'])
    'unique index uk_user_profiles_user_employee' = ([bool]$Row['unique_index'])
    'all 5 new functions'                         = ([int]$Row['new_functions'] -eq 5)
    'trigger trg_snack_record_user_guard'         = ([bool]$Row['guard_trigger'])
    'current_office_role() checks the new flags'  = ([bool]$Row['role_function_updated'])
    'office_records_update_guard is admin-only'   = ([bool]$Row['records_update_admin_only'])
  }
  $present = @($structural.Keys | Where-Object { $structural[$_] })
  $missing = @($structural.Keys | Where-Object { -not $structural[$_] })
  if ($columns) { $present = @('user_profiles has all 4 new columns') + $present } else { $missing = @('user_profiles has all 4 new columns') + $missing }
  $someStructural = @($structural.Keys | Where-Object { $structural[$_] }).Count -gt 0
  $state = if ($missing.Count -eq 0) { 'applied' } elseif (-not $someStructural) { 'not-applied' } else { 'partial' }
  return [pscustomobject]@{ State = $state; Present = $present; Missing = $missing; ColumnsLeftBehind = ($columns -and $state -eq 'not-applied') }
}

function Get-MigrationState([scriptblock]$Runner) {
  $row = Get-CliRow (& $Runner $script:MigrationStateSql) @('new_columns', 'role_check', 'unique_index', 'new_functions', 'guard_trigger', 'role_function_updated', 'records_update_admin_only')
  return Test-MigrationStateRow $row
}
