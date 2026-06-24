# Jira Dashboard — Comcards_CrossApp

An interactive Jira dashboard with filters, charts, and a data table — live on GitHub Pages.

## Architecture Overview

There are **two modes** for getting data into the dashboard:

### Mode 1: Live Proxy (for local use)
```
Browser ──→ Proxy (your machine) ──→ Jira Cloud API
```
A PowerShell script (`jira-proxy.ps1`) runs on your local machine. The browser calls `localhost:8080`, the proxy forwards to Jira. This avoids browser CORS restrictions and keeps your PAT on your machine.

### Mode 2: Automated refresh (for GitHub Pages visitors)
```
GitHub Actions (every 30 min) ──→ Jira API directly ──→ commits data/data.js
                                                              ↓
GitHub Pages serves index.html ←── data/data.js (static cache)
```
This mode uses a **separate script** (`fetch-data.ps1`) that calls the Jira API **directly** — no proxy needed. It runs in GitHub's infrastructure (or any server) and saves the result to `data/data.js`, which GitHub Pages serves as a static file.

### Why no proxy is needed for Mode 2

- `fetch-data.ps1` is a **server-to-server** script, not a browser application
- Server-to-server API calls have no CORS restrictions
- The PAT is injected securely via GitHub Secrets, never exposed to the browser
- The browser only reads the final cached JSON — no live API calls at all

### Why a backend API can't run on GitHub Pages

GitHub Pages is **static hosting only** — HTML, CSS, JS. It cannot run Python, Node.js, PowerShell, or any server-side code. To host a live backend API (e.g. Flask, FastAPI, Express), you would need a server or serverless platform (internal Citi server, AWS Lambda, Cloudflare Workers, etc.).

### Comparison

| Approach | Real-time data | Needs server | Setup effort |
|---|---|---|---|
| Local proxy | ✅ Yes | Your machine only | 5 min |
| GH Actions + static cache | ⏱️ 30-min delay | No server needed | 10 min |
| Custom backend API | ✅ Yes | Yes (any cloud/internal server) | Varies |

### Caching

The proxy automatically saves fetched data to `data/data.js` after a successful refresh. This file serves as a fallback:

- **Proxy online** → Dashboard loads live data from Jira
- **Proxy offline** → Dashboard falls back to `data/data.js` (served from GitHub Pages)
- **Run the proxy** → It updates `data/data.js` automatically

To keep the GitHub Pages fallback up to date, commit and push `data/data.js` after running the proxy:

```bash
git add data/data.js
git commit -m "update cached data"
git push
```

## Automated Data Refresh

The repo includes two approaches to keep `data/data.js` current without manual intervention.

### Option A: GitHub Actions (if enabled)

A workflow at `.github/workflows/refresh-data.yml` fetches Jira data and commits the updated `data/data.js` automatically.

**Setup:**

1. Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**
2. Add these secrets:

| Secret | Value |
|---|---|
| `JIRA_BASE_URL` | `https://your-domain.atlassian.net` |
| `JIRA_PAT` | Your Jira API token |

3. The workflow runs **every 30 minutes** automatically
4. To trigger manually: **Actions → Refresh Jira Data → Run workflow**

The workflow uses `proxy/fetch-data.ps1` — a standalone script that fetches data directly without starting an HTTP proxy.

### Option B: Any scheduler (Jenkins, cron, Task Scheduler, etc.)

Run `proxy/fetch-data.ps1` on any machine with PowerShell and git access:

```bash
export JIRA_BASE_URL="https://your-domain.atlassian.net"
export JIRA_PAT="your-api-token"
export JIRA_PROJECT_KEY="Comcards_CrossApp"
pwsh proxy/fetch-data.ps1
git add data/data.js && git commit -m "update cache" && git push
```

On Windows Task Scheduler, use:
```powershell
$env:JIRA_BASE_URL="https://your-domain.atlassian.net"
$env:JIRA_PAT="your-api-token"
$env:JIRA_PROJECT_KEY="Comcards_CrossApp"
pwsh proxy/fetch-data.ps1
git add data/data.js
git commit -m "update cache"
git push
```

## Setup

### Prerequisites
- PowerShell 5.1+ (Windows) or PowerShell Core 7+ (macOS/Linux)
- A [Jira API token](https://id.atlassian.com/manage/api-tokens)
- Your Jira Cloud URL (e.g. `https://your-domain.atlassian.net`)

### 1. Configure the proxy

Edit `proxy/config.json`:

```json
{
  "JiraBaseUrl": "https://your-domain.atlassian.net",
  "JiraPat": "your-personal-access-token",
  "ProxyPort": 8080,
  "ArtCustomFieldId": "customfield_10001",
  "ScrumTeamCustomFieldId": "customfield_10002"
}
```

| Field | Description |
|---|---|
| `JiraBaseUrl` | Your Jira Cloud URL (e.g. `https://company.atlassian.net`) |
| `JiraPat` | Jira API token — create one at https://id.atlassian.com/manage/api-tokens |
| `ProxyPort` | Port for the local proxy (default `8080`) |
| `ArtCustomFieldId` | Custom field ID for Agile Release Train (see below) |
| `ScrumTeamCustomFieldId` | Custom field ID for Scrum Team (see below) |

### 2. Start the proxy

Open a terminal and run:

```powershell
cd proxy
.\jira-proxy.ps1
```

You should see:
```
Jira Proxy running on http://localhost:8080
Press Ctrl+C to stop
```

The proxy:
- Listens on `http://localhost:8080`
- Forwards requests from the dashboard to Jira Cloud API
- Handles pagination automatically (fetches all pages)
- Returns JSON responses to the frontend

**Troubleshooting:**
- If you get a permission error on Windows, run PowerShell as Administrator and try `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` first
- If the port is in use, change `ProxyPort` in `config.json` and update `PROXY_URL` in `js/dashboard.js`
- On macOS, install PowerShell Core: `brew install powershell`

### 3. Open the dashboard

- **GitHub Pages**: https://nikhileshchinta.github.io/jira-dashboard/
- **Locally**: Open `index.html` directly in your browser (proxy must be running)

The dashboard will connect to the proxy and display a green "Proxy Online" status. If it shows "Proxy Offline", make sure the proxy is running.

## Features

| Feature | Description |
|---|---|
| **Filters** | Fix Version/s, Epic, Type, ART, Scrum Team |
| **Stats Cards** | Total, New, In Progress, Done + dynamic statuses |
| **Charts** | Pie (by status category), Donut (by type), Bar (by status), Horizontal Bar (by type), Line (monthly progress) |
| **Cross-filtering** | Click a filter → updates all charts + table. Click a chart segment → filters table |
| **Table** | All tickets (except Epic/Capability), sortable columns, search |
| **Refresh** | Re-fetches all data from Jira |

## Custom field IDs

ART and Scrum Team use Jira custom fields. To find yours:

```powershell
# Start the proxy, then:
curl http://localhost:8080/api/fields | ConvertFrom-Json | Select-Object -ExpandProperty fields | Where-Object name -like "*ART*" | Select-Object id, name
curl http://localhost:8080/api/fields | ConvertFrom-Json | Select-Object -ExpandProperty fields | Where-Object name -like "*Team*" | Select-Object id, name
```

Update `config.json` with the correct IDs.
