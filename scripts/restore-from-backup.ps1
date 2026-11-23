<#
  Generates restore SQL from a VERIFIED local backup folder. It does NOT connect to Supabase and does NOT run anything:
  you review the generated .sql files and run them yourself (SQL Editor, or
  npx supabase db query --remote=<ref> --file <file>).

    powershell -ExecutionPolicy Bypass -File .\scripts\restore-from-backup.ps1 -BackupDir .\backups\20261123T101500Z-atmmjqwrqeidlqozuuje

  What the generated SQL does (each file is one transaction):
    employees, snacks, snack_records : INSERT ... ON CONFLICT (id) DO NOTHING. Only re-creates rows that are MISSING, with
                                       their original ids. Existing rows are never updated or deleted. Identity sequences are advanced.
    user_profiles                    : upsert of role + employee_id for each original profile (this is the only table the
                                       migration changes). It refuses to run while the new role constraint is still installed:
                                       run database\migrations\2026-11-23-two-role-user-management.rollback.sql first.
  Restore order if rows were lost: employees, snacks, snack_records (foreign keys), then user_profiles if needed.
#>
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [string]$Ref = 'atmmjqwrqeidlqozuuje',
  [ValidateSet('all', 'employees', 'snacks', 'snack_records', 'user_profiles')][string]$Table = 'all'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-lib.ps1')
Assert-WindowsPowerShell

$BackupDir = (Resolve-Path -LiteralPath $BackupDir).Path
# Full re-verification (manifest, project, SHA-256, parse, counts). No age limit: restores may use old backups.
$manifest = Test-BackupFolder -Dir $BackupDir -Ref $Ref
Write-Host "Backup verified: taken $($manifest['createdUtc']) for project $Ref." -ForegroundColor Green

$outDir = Join-Path $BackupDir 'restore-sql'
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-DollarTag([string]$Body) {
  $i = 0
  do { $tag = '$bk' + $i + '$'; $i++ } while ($Body.Contains($tag))
  return $tag
}

$wanted = if ($Table -eq 'all') { @($script:BackupTables.Keys) } else { @($Table) }
$order = 0
foreach ($t in $wanted) {
  $order++
  $key = $script:BackupTables[$t]
  $doc = ConvertFrom-JsonText ([IO.File]::ReadAllText((Join-Path $BackupDir ([string]$manifest['tables'][$t]['file'])), (Get-Utf8NoBom)))
  $count = @($doc['rows']).Count
  # Re-extract the raw rows array text exactly as written (avoids any re-serialisation).
  $raw = [IO.File]::ReadAllText((Join-Path $BackupDir ([string]$manifest['tables'][$t]['file'])), (Get-Utf8NoBom))
  $start = $raw.IndexOf('"rows":[') + 7
  $rowsJson = $raw.Substring($start, $raw.Length - $start - 1)   # up to the closing } of the document
  $tag = New-DollarTag $rowsJson
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("-- Restore of public.$t from backup taken $($manifest['createdUtc']) (project $Ref): $count rows.")
  [void]$sb.AppendLine("-- Review before running. Contains business data: keep private, do not commit.")
  [void]$sb.AppendLine('BEGIN;')
  if ($count -gt 0) {
    if ($t -eq 'user_profiles') {
      [void]$sb.AppendLine("DO ${tag}BEGIN")
      [void]$sb.AppendLine("  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_profile_role') THEN")
      [void]$sb.AppendLine("    RAISE EXCEPTION 'Run database/migrations/2026-11-23-two-role-user-management.rollback.sql first: backed-up roles use the old names.';")
      [void]$sb.AppendLine("  END IF;")
      [void]$sb.AppendLine("END${tag};")
      [void]$sb.AppendLine("INSERT INTO public.user_profiles (user_id, role, employee_id)")
      [void]$sb.AppendLine("SELECT user_id, role, employee_id FROM jsonb_populate_recordset(NULL::public.user_profiles, ${tag}$rowsJson${tag}::jsonb)")
      [void]$sb.AppendLine("ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, employee_id = EXCLUDED.employee_id;")
    } else {
      [void]$sb.AppendLine("INSERT INTO public.$t OVERRIDING SYSTEM VALUE")
      [void]$sb.AppendLine("SELECT * FROM jsonb_populate_recordset(NULL::public.$t, ${tag}$rowsJson${tag}::jsonb)")
      [void]$sb.AppendLine("ON CONFLICT ($key) DO NOTHING;")
      [void]$sb.AppendLine("SELECT setval(pg_get_serial_sequence('public.$t', '$key'), GREATEST((SELECT COALESCE(MAX($key), 1) FROM public.$t), 1));")
    }
  } else {
    [void]$sb.AppendLine("-- The backup holds no rows for this table; nothing to restore.")
  }
  [void]$sb.AppendLine('COMMIT;')
  $file = Join-Path $outDir ("{0}-{1}.sql" -f $order.ToString('00'), $t)
  [IO.File]::WriteAllText($file, $sb.ToString(), (Get-Utf8NoBom))
  Write-Host ("wrote {0} ({1} rows)" -f $file, $count)
}
Write-Host "`nNothing was executed. Review the files, then run them in order against the project you intend to restore:" -ForegroundColor Yellow
Write-Host "  npx supabase db query --remote=$Ref --file <file>    (or paste into the SQL Editor)"
