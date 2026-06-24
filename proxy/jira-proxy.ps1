param(
    [int]$Port = 8080,
    [string]$ConfigPath = "config.json"
)

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.JiraBaseUrl -or $config.JiraBaseUrl -eq "https://your-domain.atlassian.net") {
    Write-Host "ERROR: Update config.json with your Jira base URL and PAT token first." -ForegroundColor Red
    exit 1
}

$baseUrl = $config.JiraBaseUrl.TrimEnd('/')
$pat = $config.JiraPat
$global:pageSize = 100
$global:parallelBatch = 10
$script:cacheDir = Join-Path (Split-Path $PSScriptRoot -Parent) "data"
$script:cacheFile = Join-Path $script:cacheDir "data.js"
$script:fields = "key,summary,status,assignee,created,resolutiondate,duedate,fixVersions,issuetype,priority,parent,customfield_10014,customfield_10001,customfield_10002,customfield_10016"

$headers = @{
    "Authorization" = "Bearer $pat"
    "Accept" = "application/json"
}

# ─── Helpers ───

function Save-Cache {
    param($versions, $epics, $tickets)
    if (-not (Test-Path $script:cacheDir)) { New-Item -ItemType Directory -Path $script:cacheDir -Force | Out-Null }
    $data = @{ versions = $versions; epics = $epics; tickets = $tickets; fetchedAt = (Get-Date -Format "o") }
    $json = $data | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($script:cacheFile, "var CACHED_DATA = $json;", [System.Text.Encoding]::UTF8)
    Write-Host "Cache saved ($($script:cacheFile))" -ForegroundColor Cyan
}

function Write-Response {
    param($res, $data, $statusCode = 200)
    $res.StatusCode = $statusCode
    $res.ContentType = "application/json"
    $json = $data | ConvertTo-Json -Depth 10 -Compress
    $buffer = [Text.Encoding]::UTF8.GetBytes($json)
    $res.OutputStream.Write($buffer, 0, $buffer.Length)
    $res.Close()
}

# ─── Parallel page fetcher ───

function Fetch-AllPages {
    param($Jql, $Fields, $Headers)

    # First, get total count
    $firstUrl = "$baseUrl/rest/api/3/search?jql=$([Uri]::EscapeDataString($Jql))&fields=key&maxResults=1"
    $first = Invoke-RestMethod -Uri $firstUrl -Headers $Headers -Method Get
    $total = $first.total
    Write-Host "  Total issues to fetch: $total" -ForegroundColor DarkGray

    if ($total -eq 0) { return @() }

    $pageSize = $global:pageSize
    $totalPages = [math]::Ceiling($total / $pageSize)
    $allIssues = @()
    $completed = 0
    $lock = [System.Threading.Mutex]::new()

    for ($batchStart = 0; $batchStart -lt $totalPages; $batchStart += $global:parallelBatch) {
        $batchEnd = [math]::Min($batchStart + $global:parallelBatch - 1, $totalPages - 1)
        $runspaces = @()

        for ($p = $batchStart; $p -le $batchEnd; $p++) {
            $startAt = $p * $pageSize
            $url = "$baseUrl/rest/api/3/search?jql=$([Uri]::EscapeDataString($Jql))&fields=$Fields&startAt=$startAt&maxResults=$pageSize"

            $ps = [powershell]::Create()
            $ps.AddScript({
                param($u, $h)
                $r = Invoke-RestMethod -Uri $u -Headers $h -Method Get -TimeoutSec 120
                return @{ issues = $r.issues; error = $null }
            }) | Out-Null
            $ps.AddParameters(@($url, $Headers)) | Out-Null
            $handle = $ps.BeginInvoke()
            $runspaces += @{ Handle = $handle; PS = $ps; Page = $p }
        }

        foreach ($rs in $runspaces) {
            try {
                $result = $rs.PS.EndInvoke($rs.Handle)
                if ($result.issues) { $allIssues += $result.issues }
            } catch {
                Write-Host "  ERROR page $($rs.Page): $($_.Exception.Message)" -ForegroundColor Red
            }
            $rs.PS.Dispose()
            $completed++
        }

        Write-Host "  Progress: $completed/$totalPages pages ($($allIssues.Count) issues)" -ForegroundColor DarkGray
    }

    return $allIssues
}

# ─── Main ───

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }

Write-Host "Jira Proxy running on http://localhost:$Port" -ForegroundColor Green
Write-Host "Cache: $($script:cacheFile)" -ForegroundColor Cyan
Write-Host "Fields: $($script:fields)" -ForegroundColor DarkGray
Write-Host "Parallel batch: $($global:parallelBatch) pages" -ForegroundColor DarkGray
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $res.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
    $res.Headers.Add("Access-Control-Allow-Headers", "*")

    if ($req.HttpMethod -eq "OPTIONS") { $res.StatusCode = 204; $res.Close(); continue }

    $path = $req.Url.AbsolutePath.TrimEnd('/')

    try {
        switch -Wildcard ($path) {
            "/api/refresh-all" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' query parameter" }
                Write-Host "--- Refresh started: $projectKey ---" -ForegroundColor Yellow

                # 1. Versions
                Write-Host "[1/3] Fetching versions..." -ForegroundColor Yellow
                $vUrl = "$baseUrl/rest/api/3/project/$projectKey/versions"
                $allV = Invoke-RestMethod -Uri $vUrl -Headers $headers -Method Get
                $versions = $allV | Where-Object { $_.name -and $_.name.StartsWith('2026') }
                Write-Host "       $($versions.Count) versions" -ForegroundColor Green

                # 2. Epics
                Write-Host "[2/3] Fetching epics..." -ForegroundColor Yellow
                $eJql = "project=$projectKey AND issuetype=Epic ORDER BY created DESC"
                $epics = Fetch-AllPages -Jql $eJql -Fields "id,key,summary,status" -Headers $headers
                Write-Host "       $($epics.Count) epics" -ForegroundColor Green

                # 3. Tickets with 2026 fix versions
                Write-Host "[3/3] Fetching tickets..." -ForegroundColor Yellow
                $allTickets = @()
                $vNames = $versions | ForEach-Object { '"' + $_.name.Replace('"', '\"') + '"' }
                if ($vNames) {
                    $vList = $vNames -join ','
                    $tJql = "project=$projectKey AND fixVersion in ($vList)"
                    $allTickets = Fetch-AllPages -Jql $tJql -Fields $script:fields -Headers $headers
                }
                Write-Host "       $($allTickets.Count) tickets" -ForegroundColor Green

                # Save & respond
                Save-Cache -versions $versions -epics $epics -tickets $allTickets
                Write-Host "--- Done ---" -ForegroundColor Green

                Write-Response -res $res -data @{
                    tickets  = $allTickets
                    epics    = $epics
                    versions = $versions
                    total    = $allTickets.Count
                }
            }

            "/api/cached" {
                if (Test-Path $script:cacheFile) {
                    $content = [System.IO.File]::ReadAllText($script:cacheFile, [System.Text.Encoding]::UTF8)
                    if ($content -match 'var CACHED_DATA = (.+);$') {
                        $data = $Matches[1] | ConvertFrom-Json
                        Write-Response -res $res -data @{ cached = $data; source = "file" }
                    } else { throw "Invalid cache file" }
                } else {
                    Write-Response -res $res -data @{ cached = $null; source = "none" }
                }
            }

            "/api/search" {
                $jql = $req.QueryString["jql"]
                if (-not $jql) { throw "Missing 'jql' parameter" }
                $fields = $req.QueryString["fields"]
                if (-not $fields) { $fields = $script:fields }
                $issues = Fetch-AllPages -Jql $jql -Fields $fields -Headers $headers
                Write-Response -res $res -data @{ issues = $issues; total = $issues.Count }
            }

            "/api/versions" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' parameter" }
                $v = Invoke-RestMethod -Uri "$baseUrl/rest/api/3/project/$projectKey/versions" -Headers $headers -Method Get
                Write-Response -res $res -data @{ versions = $v }
            }

            "/api/epics" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' parameter" }
                $jql = "project=$projectKey AND issuetype=Epic ORDER BY created DESC"
                $issues = Fetch-AllPages -Jql $jql -Fields "id,key,summary,status" -Headers $headers
                Write-Response -res $res -data @{ issues = $issues; total = $issues.Count }
            }

            "/api/fields" {
                $f = Invoke-RestMethod -Uri "$baseUrl/rest/api/3/field" -Headers $headers -Method Get
                Write-Response -res $res -data @{ fields = $f }
            }

            "/api/proxy" {
                $jiraPath = $req.QueryString["path"]
                if (-not $jiraPath) { throw "Missing 'path' parameter" }
                $qs = $req.Url.Query
                $parts = [System.Web.HttpUtility]::ParseQueryString($qs)
                $parts.Remove("path")
                $remaining = $parts.ToString()
                $url = "$baseUrl$jiraPath"
                if ($remaining) { $url += "?$remaining" }
                $d = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                Write-Response -res $res -data $d
            }

            "/health" {
                Write-Response -res $res -data @{ status = "ok"; timestamp = (Get-Date -Format "o") }
            }

            default {
                Write-Response -res $res -data @{ error = "Unknown: $path" } -statusCode 404
            }
        }
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-Response -res $res -data @{ error = $_.Exception.Message } -statusCode 500
    }
}
