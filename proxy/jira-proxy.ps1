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
$script:cacheDir = Split-Path $PSScriptRoot -Parent
$script:cacheFile = Join-Path $script:cacheDir "data" "data.js"
$script:fetchedVersions = $null
$script:fetchedEpics = $null
$script:fetchedTickets = $null

$headers = @{
    "Authorization" = "Bearer $pat"
    "Accept" = "application/json"
}

function Save-Cache {
    param($versions, $epics, $tickets)
    $cacheDir = Split-Path $script:cacheFile -Parent
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }

    $data = @{
        versions = $versions
        epics    = $epics
        tickets  = $tickets
        fetchedAt = (Get-Date -Format "o")
    }

    $json = $data | ConvertTo-Json -Depth 10
    $jsContent = "var CACHED_DATA = $json;"
    [System.IO.File]::WriteAllText($script:cacheFile, $jsContent, [System.Text.Encoding]::UTF8)
    Write-Host "Cache saved to $($script:cacheFile)" -ForegroundColor Cyan
}

function Write-Response {
    param($res, $data, $statusCode = 200)
    $res.StatusCode = $statusCode
    $res.ContentType = "application/json"
    $json = $data | ConvertTo-Json -Depth 10 -Compress
    $buffer = [Text.Encoding]::UTF8.GetBytes($json)
    $res.ContentLength64 = $buffer.Length
    $res.OutputStream.Write($buffer, 0, $buffer.Length)
    $res.Close()
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
    $listener.Start()
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "Jira Proxy running on http://localhost:$Port" -ForegroundColor Green
Write-Host "Cache file: $($script:cacheFile)" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response

    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $res.Headers.Add("Access-Control-Allow-Headers", "*")

    if ($req.HttpMethod -eq "OPTIONS") {
        $res.StatusCode = 204
        $res.Close()
        continue
    }

    $path = $req.Url.AbsolutePath.TrimEnd('/')

    try {
        $result = $null
        switch -Wildcard ($path) {
            "/api/refresh-all" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' query parameter" }

                Write-Host "--- Refreshing all data for $projectKey ---" -ForegroundColor Yellow

                # Fetch versions
                $vUrl = "$baseUrl/rest/api/3/project/$projectKey/versions"
                Write-Host "GET $vUrl" -ForegroundColor DarkGray
                $versions = (Invoke-RestMethod -Uri $vUrl -Headers $headers -Method Get) | Where-Object { $_.name -and $_.name.StartsWith('2026') } | Sort-Object name -Descending

                # Fetch epics
                $eJql = [System.Web.HttpUtility]::UrlEncode("project=$projectKey AND issuetype=Epic ORDER BY created DESC")
                $allEpics = @()
                $startAt = 0
                do {
                    $eUrl = "$baseUrl/rest/api/3/search?jql=$eJql&fields=id,key,summary,status&startAt=$startAt&maxResults=$global:pageSize"
                    Write-Host "GET $eUrl" -ForegroundColor DarkGray
                    $page = Invoke-RestMethod -Uri $eUrl -Headers $headers -Method Get
                    $allEpics += $page.issues
                    $startAt += $global:pageSize
                } while ($startAt -lt $page.total)

                # Fetch tickets for 2026 versions
                $allTickets = @()
                $vNames = $versions | ForEach-Object { '"' + $_.name.Replace('"', '\"') + '"' }
                if ($vNames) {
                    $vList = $vNames -join ','
                    $tJql = [System.Web.HttpUtility]::UrlEncode("project=$projectKey AND fixVersion in ($vList)")
                    $startAt = 0
                    do {
                        $tUrl = "$baseUrl/rest/api/3/search?jql=$tJql&fields=*all&startAt=$startAt&maxResults=$global:pageSize"
                        Write-Host "GET $tUrl" -ForegroundColor DarkGray
                        $page = Invoke-RestMethod -Uri $tUrl -Headers $headers -Method Get
                        $allTickets += $page.issues
                        $startAt += $global:pageSize
                    } while ($startAt -lt $page.total)
                }

                # Save cache
                Save-Cache -versions $versions -epics $allEpics -tickets $allTickets

                Write-Host "--- Refresh complete: $($allTickets.Count) tickets, $($allEpics.Count) epics, $($versions.Count) versions ---" -ForegroundColor Green

                $result = @{
                    tickets  = $allTickets
                    epics    = $allEpics
                    versions = $versions
                    total    = $allTickets.Count
                }
                Write-Response -res $res -data $result
            }

            "/api/cached" {
                if (Test-Path $script:cacheFile) {
                    $jsContent = [System.IO.File]::ReadAllText($script:cacheFile, [System.Text.Encoding]::UTF8)
                    # Extract JSON from `var CACHED_DATA = ...;`
                    if ($jsContent -match 'var CACHED_DATA = (.+);$') {
                        $json = $Matches[1]
                        $data = $json | ConvertFrom-Json
                        Write-Response -res $res -data @{ cached = $data; source = "file" }
                    } else {
                        throw "Invalid cache file format"
                    }
                } else {
                    $result = @{ cached = $null; source = "none" }
                    Write-Response -res $res -data $result
                }
            }

            "/api/search" {
                $jql = $req.QueryString["jql"]
                if (-not $jql) { throw "Missing 'jql' query parameter" }
                $fields = $req.QueryString["fields"]
                if (-not $fields) { $fields = "*all" }

                $allIssues = @()
                $startAt = 0
                do {
                    $url = "$baseUrl/rest/api/3/search?jql=$([System.Web.HttpUtility]::UrlEncode($jql))&fields=$fields&startAt=$startAt&maxResults=$global:pageSize"
                    Write-Host "GET $url" -ForegroundColor DarkGray
                    $page = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                    $allIssues += $page.issues
                    $startAt += $global:pageSize
                } while ($startAt -lt $page.total)

                $result = @{ issues = $allIssues; total = $allIssues.Count }
                Write-Response -res $res -data $result
            }

            "/api/versions" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' query parameter" }
                $url = "$baseUrl/rest/api/3/project/$projectKey/versions"
                Write-Host "GET $url" -ForegroundColor DarkGray
                $v = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                $result = @{ versions = $v }
                Write-Response -res $res -data $result
            }

            "/api/epics" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' query parameter" }
                $jql = "project=$projectKey AND issuetype=Epic ORDER BY created DESC"
                $allIssues = @()
                $startAt = 0
                do {
                    $url = "$baseUrl/rest/api/3/search?jql=$([System.Web.HttpUtility]::UrlEncode($jql))&fields=id,key,summary,status&startAt=$startAt&maxResults=$global:pageSize"
                    Write-Host "GET $url" -ForegroundColor DarkGray
                    $page = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                    $allIssues += $page.issues
                    $startAt += $global:pageSize
                } while ($startAt -lt $page.total)
                $result = @{ issues = $allIssues; total = $allIssues.Count }
                Write-Response -res $res -data $result
            }

            "/api/fields" {
                $url = "$baseUrl/rest/api/3/field"
                Write-Host "GET $url" -ForegroundColor DarkGray
                $f = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                $result = @{ fields = $f }
                Write-Response -res $res -data $result
            }

            "/api/proxy" {
                $jiraPath = $req.QueryString["path"]
                if (-not $jiraPath) { throw "Missing 'path' query parameter" }
                $queryString = $req.Url.Query
                $queryParts = [System.Web.HttpUtility]::ParseQueryString($queryString)
                $queryParts.Remove("path")
                $remainingQuery = $queryParts.ToString()

                $url = "$baseUrl$jiraPath"
                if ($remainingQuery) { $url += "?$remainingQuery" }
                Write-Host "GET $url" -ForegroundColor DarkGray
                $d = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                Write-Response -res $res -data $d
            }

            "/health" {
                $result = @{ status = "ok"; timestamp = (Get-Date -Format "o") }
                Write-Response -res $res -data $result
            }

            default {
                Write-Response -res $res -data @{ error = "Unknown endpoint: $path" } -statusCode 404
            }
        }
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-Response -res $res -data @{ error = $_.Exception.Message } -statusCode 500
    }
}
