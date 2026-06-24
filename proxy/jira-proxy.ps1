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

$headers = @{
    "Authorization" = "Bearer $pat"
    "Accept" = "application/json"
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
    $statusCode = 200

    try {
        $result = $null
        switch -Wildcard ($path) {
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
                Write-Host "Fetched $($allIssues.Count) issues" -ForegroundColor Green
            }
            "/api/versions" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' query parameter" }
                $url = "$baseUrl/rest/api/3/project/$projectKey/versions"
                Write-Host "GET $url" -ForegroundColor DarkGray
                $versions = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                $result = @{ versions = $versions }
                Write-Host "Fetched $($versions.Count) versions" -ForegroundColor Green
            }
            "/api/project" {
                $projectKey = $req.QueryString["project"]
                if (-not $projectKey) { throw "Missing 'project' query parameter" }
                $url = "$baseUrl/rest/api/3/project/$projectKey"
                Write-Host "GET $url" -ForegroundColor DarkGray
                $project = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                $result = @{ project = $project }
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
                Write-Host "Fetched $($allIssues.Count) epics" -ForegroundColor Green
            }
            "/api/fields" {
                $url = "$baseUrl/rest/api/3/field"
                Write-Host "GET $url" -ForegroundColor DarkGray
                $fields = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
                $result = @{ fields = $fields }
            }
            "/api/proxy" {
                $jiraPath = $req.QueryString["path"]
                if (-not $jiraPath) { throw "Missing 'path' query parameter" }
                $queryString = $req.Url.Query
                # Rebuild query without 'path' param
                $queryParts = [System.Web.HttpUtility]::ParseQueryString($queryString)
                $queryParts.Remove("path")
                $remainingQuery = $queryParts.ToString()

                $url = "$baseUrl$jiraPath"
                if ($remainingQuery) { $url += "?$remainingQuery" }
                Write-Host "GET $url" -ForegroundColor DarkGray
                $result = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
            }
            "/health" {
                $result = @{ status = "ok"; timestamp = (Get-Date -Format "o") }
            }
            default {
                $statusCode = 404
                $result = @{ error = "Unknown endpoint: $path" }
            }
        }

        if ($result) {
            $json = $result | ConvertTo-Json -Depth 10 -Compress
            $res.ContentType = "application/json"
            $buffer = [Text.Encoding]::UTF8.GetBytes($json)
            $res.ContentLength64 = $buffer.Length
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } else {
            $statusCode = 204
        }
    } catch {
        $statusCode = 500
        $err = @{ error = $_.Exception.Message }
        $json = $err | ConvertTo-Json -Compress
        $res.ContentType = "application/json"
        $buffer = [Text.Encoding]::UTF8.GetBytes($json)
        $res.ContentLength64 = $buffer.Length
        $res.OutputStream.Write($buffer, 0, $buffer.Length)
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }

    $res.StatusCode = $statusCode
    $res.Close()
}
