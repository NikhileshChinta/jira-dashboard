param(
    [string]$JiraBaseUrl = $env:JIRA_BASE_URL,
    [string]$JiraPat = $env:JIRA_PAT,
    [string]$ProjectKey = $env:JIRA_PROJECT_KEY,
    [int]$PageSize = 100,
    [int]$ParallelBatch = 10
)

if (-not $JiraBaseUrl -or -not $JiraPat -or -not $ProjectKey) {
    Write-Host "ERROR: Set JIRA_BASE_URL, JIRA_PAT, and JIRA_PROJECT_KEY env vars." -ForegroundColor Red
    exit 1
}

$headers = @{ "Authorization" = "Bearer $JiraPat"; "Accept" = "application/json" }
$baseUrl = $JiraBaseUrl.TrimEnd('/')
$fields = "key,summary,status,assignee,created,resolutiondate,duedate,fixVersions,issuetype,priority,parent,customfield_10014,customfield_10001,customfield_10002,customfield_10016"

$repoRoot = Split-Path $PSScriptRoot -Parent
$cacheFile = Join-Path $repoRoot "data" "data.js"

function Save-Cache {
    param($versions, $epics, $tickets)
    $dir = Split-Path $cacheFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $data = @{ versions = $versions; epics = $epics; tickets = $tickets; fetchedAt = (Get-Date -Format "o") }
    $json = $data | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($cacheFile, "var CACHED_DATA = $json;", [System.Text.Encoding]::UTF8)
    Write-Host "Saved $($tickets.Count) tickets to $cacheFile" -ForegroundColor Cyan
}

function Fetch-AllPages {
    param($Jql, $Fields)
    $encodedJql = [Uri]::EscapeDataString($Jql)
    $firstUrl = "$baseUrl/rest/api/3/search?jql=$encodedJql&fields=key&maxResults=1"
    try { $first = Invoke-RestMethod -Uri $firstUrl -Headers $headers -Method Get -TimeoutSec 30 }
    catch { Write-Host "ERROR: $_" -ForegroundColor Red; return @() }
    $total = $first.total
    if ($total -eq 0) { return @() }
    $totalPages = [math]::Ceiling($total / $PageSize)
    $allIssues = @()
    for ($batchStart = 0; $batchStart -lt $totalPages; $batchStart += $ParallelBatch) {
        $batchEnd = [math]::Min($batchStart + $ParallelBatch - 1, $totalPages - 1)
        $runspaces = @()
        for ($p = $batchStart; $p -le $batchEnd; $p++) {
            $startAt = $p * $PageSize
            $url = "$baseUrl/rest/api/3/search?jql=$([Uri]::EscapeDataString($Jql))&fields=$Fields&startAt=$startAt&maxResults=$PageSize"
            $ps = [powershell]::Create()
            $ps.AddScript({ param($u, $h) $r = Invoke-RestMethod -Uri $u -Headers $h -Method Get -TimeoutSec 120; return @{ issues = $r.issues; error = $null } }) | Out-Null
            $ps.AddParameters(@($url, $headers)) | Out-Null
            $runspaces += @{ Handle = $ps.BeginInvoke(); PS = $ps; Page = $p }
        }
        foreach ($rs in $runspaces) {
            try { $result = $rs.PS.EndInvoke($rs.Handle); if ($result.issues) { $allIssues += $result.issues } }
            catch { Write-Host "  ERROR page $($rs.Page): $_" -ForegroundColor Red }
            $rs.PS.Dispose()
        }
        Write-Host "  $($allIssues.Count)/$total issues" -ForegroundColor DarkGray
    }
    return $allIssues
}

Write-Host "--- Fetching data for $ProjectKey ---" -ForegroundColor Yellow

# Versions
Write-Host "[1/3] Versions..." -ForegroundColor Yellow
$allV = Invoke-RestMethod -Uri "$baseUrl/rest/api/3/project/$ProjectKey/versions" -Headers $headers -Method Get -TimeoutSec 30
$versions = $allV | Where-Object { $_.name -and $_.name.StartsWith('2026') }
Write-Host "  $($versions.Count) versions" -ForegroundColor Green

# Epics
Write-Host "[2/3] Epics..." -ForegroundColor Yellow
$epics = Fetch-AllPages -Jql "project=$ProjectKey AND issuetype=Epic ORDER BY created DESC" -Fields "id,key,summary,status"
Write-Host "  $($epics.Count) epics" -ForegroundColor Green

# Tickets
Write-Host "[3/3] Tickets..." -ForegroundColor Yellow
$allTickets = @()
$vNames = $versions | ForEach-Object { '"' + $_.name.Replace('"', '\"') + '"' }
if ($vNames) {
    $vList = $vNames -join ','
    $allTickets = Fetch-AllPages -Jql "project=$ProjectKey AND fixVersion in ($vList)" -Fields $fields
}
Write-Host "  $($allTickets.Count) tickets" -ForegroundColor Green

Save-Cache -versions $versions -epics $epics -tickets $allTickets
Write-Host "--- Done ---" -ForegroundColor Green
