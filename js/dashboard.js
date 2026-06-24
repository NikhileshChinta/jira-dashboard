/* ─── Configuration ─── */
const PROXY_URL = 'http://localhost:8080';
const PROJECT_KEY = 'Comcards_CrossApp';
const STATUS_MAP = {
  new: ['New', 'To Do', 'Open', 'Backlog', 'Ready for Development'],
  inprogress: ['In Progress', 'In Development', 'In Review', 'Code Review', 'In Testing', 'QA', 'In QA'],
  done: ['Done', 'Closed', 'Resolved', 'Completed', 'Merged']
};
const EXCLUDE_TYPES = ['Epic', 'Capability'];
const STORY_POINTS_FIELD = 'customfield_10016'; // Update this to match your Jira instance

/* ─── State ─── */
let allTickets = [];
let allEpics = [];
let allVersions = [];
let filteredTickets = [];
let activeChartFilter = null;
let charts = {};
let proxyOnline = false;

/* ─── DOM refs ─── */
const $ = id => document.getElementById(id);
const loadingEl = $('loadingOverlay');
const lastUpdated = $('lastUpdated');
const statusDot = $('connectionStatus');
const statusText = $('statusText');

/* ─── Proxy ─── */
async function proxyGet(endpoint) {
  const res = await fetch(`${PROXY_URL}${endpoint}`);
  if (!res.ok) throw new Error(`Proxy error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function checkProxy() {
  try {
    const res = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      proxyOnline = true;
      statusDot.className = 'status-dot online';
      statusText.textContent = 'Proxy Online';
      return true;
    }
  } catch {}
  proxyOnline = false;
  statusDot.className = 'status-dot offline';
  statusText.textContent = 'Proxy Offline';
  return false;
}

/* ─── Modal helpers ─── */
function showLoading() { loadingEl.classList.remove('hidden'); }
function hideLoading() { loadingEl.classList.add('hidden'); }
function flashMsg(msg, isError) {
  const el = $('refreshMsg');
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

/* ─── Data fetching ─── */
async function loadAllData() {
  showLoading();
  try {
    if (!proxyOnline && !(await checkProxy())) {
      tryFallback();
      return;
    }

    const res = await fetch(`${PROXY_URL}/api/refresh-all?project=${PROJECT_KEY}`);
    if (!res.ok) throw new Error(`Proxy error ${res.status}`);
    const data = await res.json();

    allVersions = (data.versions || []).filter(v => v.name && v.name.startsWith('2026'));
    allEpics = data.epics || [];
    allTickets = data.tickets || [];

    lastUpdated.textContent = `Last updated: ${new Date().toLocaleString()}`;
    buildDashboard();
    flashMsg(`Loaded ${allTickets.length} tickets (live)`);
  } catch (err) {
    flashMsg(`Live fetch failed: ${err.message}`, true);
    tryFallback();
  }
  hideLoading();
}

function tryFallback() {
  if (window.CACHED_DATA && window.CACHED_DATA.tickets && window.CACHED_DATA.tickets.length > 0) {
    allVersions = (window.CACHED_DATA.versions || []).filter(v => v.name && v.name.startsWith('2026'));
    allEpics = window.CACHED_DATA.epics || [];
    allTickets = window.CACHED_DATA.tickets || [];
    const fetched = window.CACHED_DATA.fetchedAt ? new Date(window.CACHED_DATA.fetchedAt).toLocaleString() : 'unknown';
    lastUpdated.textContent = `Cached data from: ${fetched}`;
    buildDashboard();
    flashMsg(`Loaded ${allTickets.length} tickets (cached)`);
  } else {
    flashMsg('Proxy offline and no cached data found.', true);
  }
}

/* ─── Extract custom field values ─── */
function getField(issue, fieldId) {
  const v = issue.fields[fieldId];
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v.value) return v.value;
  if (v.name) return v.name;
  if (v.displayName) return v.displayName;
  if (Array.isArray(v)) return v.map(x => x.value || x.name || x.displayName || String(x)).join(', ');
  return String(v);
}

function getEpicKey(issue) {
  const epicField = issue.fields.customfield_10014;
  if (typeof epicField === 'string' && epicField) return epicField;
  if (epicField && epicField.key) return epicField.key;
  const parent = issue.fields.parent;
  if (parent && parent.key) return parent.key;
  return null;
}

function getFixVersions(issue) {
  return (issue.fields.fixVersions || []).map(v => v.name);
}

function getStatus(issue) {
  return issue.fields.status ? issue.fields.status.name : 'Unknown';
}

function getStatusCategory(issue) {
  const s = getStatus(issue).toLowerCase();
  for (const [cat, names] of Object.entries(STATUS_MAP)) {
    if (names.some(n => s.includes(n.toLowerCase()))) return cat;
  }
  return 'other';
}

function getMonth(d) {
  if (!d) return null;
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/* ─── Build filter options ─── */
function buildFilters() {
  const epicMap = {};
  allEpics.forEach(e => { epicMap[e.key] = e.fields.summary || e.key; });

  const epics = new Set();
  const types = new Set();
  const arts = new Set();
  const teams = new Set();

  allTickets.forEach(t => {
    const ek = getEpicKey(t);
    if (ek) {
      const label = epicMap[ek] ? `${ek}::${epicMap[ek]}` : `${ek}::${ek}`;
      epics.add(label);
    }
    const type = t.fields.issuetype ? t.fields.issuetype.name : null;
    if (type) types.add(type);
    const art = getField(t, window.ART_FIELD || 'customfield_10001');
    if (art) arts.add(art);
    const team = getField(t, window.TEAM_FIELD || 'customfield_10002');
    if (team) teams.add(team);
  });

  populateSelect('filterFixVersion', allVersions.map(v => v.name), true);
  populateSelect('filterEpic', [...epics].sort().map(e => {
    const [k, s] = e.split('::');
    return { value: k, label: `${k}: ${s}` };
  }));
  populateSelect('filterType', [...types].sort(), true);
  populateSelect('filterArt', [...arts].sort(), true);
  populateSelect('filterTeam', [...teams].sort(), true);
}

function populateSelect(id, items, isDropdown) {
  const sel = $(id);
  sel.innerHTML = '';
  if (isDropdown) {
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All';
    sel.appendChild(all);
  }
  items.forEach(item => {
    const opt = document.createElement('option');
    if (typeof item === 'object') {
      opt.value = item.value;
      opt.textContent = item.label;
    } else {
      opt.value = item;
      opt.textContent = item;
    }
    sel.appendChild(opt);
  });
}

/* ─── Filtering ─── */
function getSelected(id) {
  const sel = $(id);
  if (!sel.multiple) {
    const val = sel.value;
    return val ? [val] : [];
  }
  return Array.from(sel.selectedOptions).map(o => o.value);
}

function applyFilters() {
  const fixVersions = getSelected('filterFixVersion');
  const epics = getSelected('filterEpic');
  const types = getSelected('filterType');
  const arts = getSelected('filterArt');
  const teams = getSelected('filterTeam');

  filteredTickets = allTickets.filter(t => {
    if (fixVersions.length > 0) {
      const tVersions = getFixVersions(t);
      if (!tVersions.some(v => fixVersions.includes(v))) return false;
    }
    if (epics.length > 0) {
      const ek = getEpicKey(t);
      if (!ek || !epics.includes(ek)) return false;
    }
    if (types.length > 0) {
      const type = t.fields.issuetype ? t.fields.issuetype.name : '';
      if (!types.includes(type)) return false;
    }
    if (arts.length > 0) {
      const art = getField(t, window.ART_FIELD || 'customfield_10001');
      if (!art || !arts.includes(art)) return false;
    }
    if (teams.length > 0) {
      const team = getField(t, window.TEAM_FIELD || 'customfield_10002');
      if (!team || !teams.includes(team)) return false;
    }
    return true;
  });

  if (activeChartFilter) {
    const { type, value } = activeChartFilter;
    filteredTickets = filteredTickets.filter(t => {
      if (type === 'status') return getStatus(t) === value;
      if (type === 'type') return (t.fields.issuetype ? t.fields.issuetype.name : '') === value;
      return true;
    });
  }

  renderStats();
  renderCharts();
  renderTable();
}

/* ─── Stats ─── */
function renderStats() {
  let total = filteredTickets.length;
  let newCount = 0, inProgCount = 0, doneCount = 0, otherCount = 0;
  const statusCounts = {};

  filteredTickets.forEach(t => {
    const s = getStatus(t);
    statusCounts[s] = (statusCounts[s] || 0) + 1;
    const cat = getStatusCategory(t);
    if (cat === 'new') newCount++;
    else if (cat === 'inprogress') inProgCount++;
    else if (cat === 'done') doneCount++;
    else otherCount++;
  });

  $('statTotal').textContent = total;
  $('statNew').textContent = newCount;
  $('statInProgress').textContent = inProgCount;
  $('statDone').textContent = doneCount;

  // Other statuses
  const dynamicEl = $('dynamicStats');
  dynamicEl.innerHTML = '';
  const known = ['new', 'inprogress', 'done'];
  Object.entries(statusCounts).forEach(([status, count]) => {
    const cat = known.includes(getStatusCategory({ fields: { status: { name: status } } })) ? null : status;
    if (cat && status !== 'New' && status !== 'To Do' && status !== 'Open' &&
        !status.toLowerCase().includes('progress') && !status.toLowerCase().includes('develop') &&
        !status.toLowerCase().includes('review') && !status.toLowerCase().includes('test') &&
        !status.toLowerCase().includes('qa') && !status.toLowerCase().includes('done') &&
        !status.toLowerCase().includes('closed') && !status.toLowerCase().includes('resolved') &&
        !status.toLowerCase().includes('complete') && !status.toLowerCase().includes('merged')) {
      const div = document.createElement('div');
      div.className = 'stat-card';
      div.dataset.status = 'other';
      div.innerHTML = `<div class="stat-value" style="color:var(--pink)">${count}</div><div class="stat-label">${status}</div>`;
      div.onclick = () => toggleChartFilter('status', status);
      dynamicEl.appendChild(div);
    }
  });
}

/* ─── Charts ─── */
function renderCharts() {
  if (charts.pie) charts.pie.destroy();
  if (charts.donut) charts.donut.destroy();
  if (charts.bar) charts.bar.destroy();
  if (charts.typeBar) charts.typeBar.destroy();
  if (charts.line) charts.line.destroy();

  renderPieChart();
  renderDonutChart();
  renderBarChart();
  renderTypeBarChart();
  renderLineChart();
}

function getColors(count) {
  const palette = ['#6c5ce7','#a29bfe','#00cec9','#fdcb6e','#e17055','#74b9ff','#fd79a8','#55efc4','#f8a5c2','#81ecec'];
  return Array.from({ length: count }, (_, i) => palette[i % palette.length]);
}

function renderPieChart() {
  const statusCounts = {};
  filteredTickets.forEach(t => {
    const s = getStatusCategory(t);
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  const labels = Object.keys(statusCounts);
  const data = Object.values(statusCounts);
  const colors = labels.map(l => {
    if (l === 'new') return '#74b9ff';
    if (l === 'inprogress') return '#fdcb6e';
    if (l === 'done') return '#00cec9';
    return '#fd79a8';
  });

  charts.pie = new Chart($('chartPie'), {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'var(--bg)', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8b8fa3', font: { size: 10 } } },
        title: { display: true, text: 'By Status Category', color: '#e2e4f0', font: { size: 12 } }
      },
      onClick: (e, els) => {
        if (els.length > 0) {
          const i = els[0].index;
          toggleChartFilter('statusCategory', labels[i]);
        }
      }
    }
  });
}

function renderDonutChart() {
  const typeCounts = {};
  filteredTickets.forEach(t => {
    const type = t.fields.issuetype ? t.fields.issuetype.name : 'Unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });
  const labels = Object.keys(typeCounts);
  const data = Object.values(typeCounts);
  const colors = getColors(labels.length);

  charts.donut = new Chart($('chartDonut'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'var(--bg)', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8b8fa3', font: { size: 10 } } },
        title: { display: true, text: 'By Type', color: '#e2e4f0', font: { size: 12 } }
      },
      onClick: (e, els) => {
        if (els.length > 0) { toggleChartFilter('type', labels[els[0].index]); }
      }
    }
  });
}

function renderBarChart() {
  const statusCounts = {};
  filteredTickets.forEach(t => {
    const s = getStatus(t);
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  const labels = Object.keys(statusCounts).sort();
  const data = labels.map(l => statusCounts[l]);
  const colors = getColors(labels.length);

  charts.bar = new Chart($('chartBar'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Tickets', data, backgroundColor: colors, borderColor: colors.map(() => 'transparent'), borderWidth: 0, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: 'By Status', color: '#e2e4f0', font: { size: 12 } }
      },
      scales: {
        x: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(42,46,69,.3)' } },
        y: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(42,46,69,.3)' }, beginAtZero: true }
      },
      onClick: (e, els) => {
        if (els.length > 0) { toggleChartFilter('status', labels[els[0].index]); }
      }
    }
  });
}

function renderTypeBarChart() {
  const typeCounts = {};
  filteredTickets.forEach(t => {
    const type = t.fields.issuetype ? t.fields.issuetype.name : 'Unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });
  const labels = Object.keys(typeCounts).sort();
  const data = labels.map(l => typeCounts[l]);
  const colors = getColors(labels.length);

  charts.typeBar = new Chart($('chartTypeBar'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Tickets', data, backgroundColor: colors, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        title: { display: true, text: 'By Type (Horizontal)', color: '#e2e4f0', font: { size: 12 } }
      },
      scales: {
        x: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(42,46,69,.3)' }, beginAtZero: true },
        y: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(42,46,69,.3)' } }
      },
      onClick: (e, els) => {
        if (els.length > 0) { toggleChartFilter('type', labels[els[0].index]); }
      }
    }
  });
}

function renderLineChart() {
  const monthData = {};
  filteredTickets.forEach(t => {
    const createdMonth = getMonth(t.fields.created);
    const resolvedMonth = getMonth(t.fields.resolutiondate);
    const cat = getStatusCategory(t);

    if (createdMonth) {
      if (!monthData[createdMonth]) monthData[createdMonth] = { created: 0, resolved: 0, inprogress: 0, cumOpen: 0 };
      monthData[createdMonth].created++;
    }
    if (resolvedMonth) {
      if (!monthData[resolvedMonth]) monthData[resolvedMonth] = { created: 0, resolved: 0, inprogress: 0, cumOpen: 0 };
      monthData[resolvedMonth].resolved++;
    }
  });

  // Cumulative
  let runningOpen = 0;
  const sortedMonths = Object.keys(monthData).sort();
  sortedMonths.forEach(m => {
    runningOpen += (monthData[m].created || 0) - (monthData[m].resolved || 0);
    monthData[m].cumOpen = runningOpen;
  });

  // In progress per month (by creation month)
  filteredTickets.forEach(t => {
    const cm = getMonth(t.fields.created);
    if (cm && monthData[cm]) {
      const cat = getStatusCategory(t);
      monthData[cm].inprogress += (cat === 'inprogress' || cat === 'new') ? 1 : 0;
    }
  });

  const labels = sortedMonths.length > 0 ? sortedMonths : ['2026-01'];
  const createdData = labels.map(m => monthData[m]?.created || 0);
  const resolvedData = labels.map(m => monthData[m]?.resolved || 0);
  const inProgData = labels.map(m => monthData[m]?.inprogress || 0);
  const cumData = labels.map(m => monthData[m]?.cumOpen || 0);

  charts.line = new Chart($('chartLine'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Created', data: createdData, borderColor: '#74b9ff', backgroundColor: 'rgba(116,185,255,.1)', fill: true, tension: .4, pointRadius: 3 },
        { label: 'In Progress', data: inProgData, borderColor: '#fdcb6e', backgroundColor: 'rgba(253,203,110,.1)', fill: true, tension: .4, pointRadius: 3 },
        { label: 'Resolved', data: resolvedData, borderColor: '#00cec9', backgroundColor: 'rgba(0,206,201,.1)', fill: true, tension: .4, pointRadius: 3 },
        { label: 'Open (Cumulative)', data: cumData, borderColor: '#6c5ce7', backgroundColor: 'transparent', borderDash: [5, 5], tension: .4, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: 'Monthly Project Progress', color: '#e2e4f0', font: { size: 14 } },
        legend: { position: 'bottom', labels: { color: '#8b8fa3', font: { size: 10 } } }
      },
      scales: {
        x: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(42,46,69,.3)' } },
        y: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(42,46,69,.3)' }, beginAtZero: true }
      }
    }
  });
}

/* ─── Chart filter toggle ─── */
function toggleChartFilter(type, value) {
  if (activeChartFilter && activeChartFilter.type === type && activeChartFilter.value === value) {
    activeChartFilter = null;
  } else {
    activeChartFilter = { type, value };
  }
  applyFilters();
}

/* ─── Table ─── */
function renderTable() {
  const excluded = EXCLUDE_TYPES;
  const tableTickets = filteredTickets.filter(t => {
    const type = t.fields.issuetype ? t.fields.issuetype.name : '';
    return !excluded.includes(type);
  });

  const cols = ['Ticket ID', 'Assignee Name', 'Ticket Name', 'Story Points', 'Status', 'Created Date', 'End Date'];
  const thead = document.querySelector('#ticketsTable thead tr');
  thead.innerHTML = cols.map(c => `<th data-col="${c.toLowerCase().replace(/\s+/g, '')}">${c} <i class="fas fa-sort"></i></th>`).join('');

  const tbody = document.querySelector('#ticketsTable tbody');
  tbody.innerHTML = tableTickets.map(t => {
    const key = t.key;
    const assignee = t.fields.assignee ? t.fields.assignee.displayName : 'Unassigned';
    const summary = t.fields.summary || '';
    const sp = t.fields[STORY_POINTS_FIELD];
    const storyPoints = sp != null ? sp : '';
    const status = getStatus(t);
    const created = t.fields.created ? new Date(t.fields.created).toLocaleDateString() : '';
    const endDate = t.fields.resolutiondate
      ? new Date(t.fields.resolutiondate).toLocaleDateString()
      : t.fields.duedate
        ? new Date(t.fields.duedate).toLocaleDateString()
        : '';

    return `<tr>
      <td><a href="${key.startsWith('http') ? key : `https://${PROJECT_KEY}.atlassian.net/browse/${key}`}" target="_blank">${key}</a></td>
      <td>${escapeHtml(assignee)}</td>
      <td>${escapeHtml(summary)}</td>
      <td>${storyPoints}</td>
      <td>${status}</td>
      <td>${created}</td>
      <td>${endDate}</td>
    </tr>`;
  }).join('');

  $('tableCount').textContent = `${tableTickets.length} tickets`;

  // Sort
  document.querySelectorAll('#ticketsTable th').forEach(th => {
    th.onclick = () => sortTable(th.dataset.col);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let sortDir = {};
function sortTable(col) {
  sortDir[col] = !(sortDir[col]);
  const dir = sortDir[col] ? 1 : -1;
  const tbody = document.querySelector('#ticketsTable tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const colIdx = Array.from(document.querySelector('#ticketsTable thead tr').children).findIndex(th => th.dataset.col === col);
  if (colIdx < 0) return;

  rows.sort((a, b) => {
    const va = a.children[colIdx]?.textContent.trim() || '';
    const vb = b.children[colIdx]?.textContent.trim() || '';
    const na = parseFloat(va), nb = parseFloat(vb);
    if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    return va.localeCompare(vb) * dir;
  });
  rows.forEach(r => tbody.appendChild(r));
}

/* ─── Search ─── */
$('tableSearch').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('#ticketsTable tbody tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

/* ─── Filter events ─── */
document.querySelectorAll('.sidebar select').forEach(sel => {
  sel.addEventListener('change', () => {
    activeChartFilter = null;
    applyFilters();
  });
});

$('clearFiltersBtn').onclick = () => {
  document.querySelectorAll('.sidebar select').forEach(s => {
    if (s.multiple) {
      s.selectedIndex = -1;
    } else {
      s.value = '';
    }
  });
  activeChartFilter = null;
  applyFilters();
};

$('refreshBtn').onclick = loadAllData;

/* ─── Open jira link ─── */
document.querySelector('#ticketsTable tbody').addEventListener('click', e => {
  const link = e.target.closest('a');
  if (link) return;
  const row = e.target.closest('tr');
  if (row) {
    document.querySelectorAll('#ticketsTable tbody tr.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  }
});

/* ─── Init ─── */
async function init() {
  await checkProxy();
  if (proxyOnline) {
    await loadAllData();
  }
}

init();
