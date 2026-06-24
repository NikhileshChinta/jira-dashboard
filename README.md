# Jira Dashboard — Comcards_CrossApp

An interactive Jira dashboard with filters, charts, and a data table, powered by a local PowerShell proxy.

## Architecture

```
GitHub Pages (static)        Your Machine (local)
┌──────────────────┐         ┌──────────────────┐
│  index.html       │  ───→  │  jira-proxy.ps1   │  ───→  Jira Cloud API
│  css/style.css    │  fetch  │  (http://localhost │         (REST API)
│  js/dashboard.js  │  ←───  │   :8080)          │  ←───
└──────────────────┘         └──────────────────┘
```

The frontend is hosted on GitHub Pages. The PowerShell proxy runs locally on your machine and forwards requests to Jira (avoids CORS issues and keeps your PAT secure).

## Setup

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

- `JiraBaseUrl` — Your Jira Cloud URL
- `JiraPat` — Your [Jira API token](https://id.atlassian.com/manage/api-tokens)
- `ArtCustomFieldId` — Custom field ID for Agile Release Train (find via `/api/fields` endpoint)
- `ScrumTeamCustomFieldId` — Custom field ID for Scrum Team

### 2. Start the proxy

```powershell
cd proxy
.\jira-proxy.ps1
```

The proxy starts on `http://localhost:8080`.

### 3. Open the dashboard

Open `https://YOUR_USERNAME.github.io/jira-dashboard/` (GitHub Pages) or `index.html` locally.

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
