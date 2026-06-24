const PROXY_URL = 'http://localhost:8080';
const PROJECT_KEY = 'Comcards_CrossApp';
const STATUS_MAP = {
  new: ['New', 'To Do', 'Open', 'Backlog', 'Ready for Development'],
  inprogress: ['In Progress', 'In Development', 'In Review', 'Code Review', 'In Testing', 'QA', 'In QA'],
  done: ['Done', 'Closed', 'Resolved', 'Completed', 'Merged']
};
const EXCLUDE_TYPES = ['Epic', 'Capability'];
const STORY_POINTS_FIELD = 'customfield_10016';

let allTickets = [];
let allEpics = [];
let allVersions = [];
let filteredTickets = [];
let activeChartFilter = null;
let charts = {};
let proxyOnline = false;

let currentPage = 0;
let pageSize = 50;
let epicItems = [];
let pendingEpics = new Set();

const $ = id => document.getElementById(id);
const loadingEl = $('loadingOverlay');
const lastUpdated = $('lastUpdated');
const statusDot = $('connectionStatus');
const statusText = $('statusText');

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

function showLoading() { loadingEl.classList.remove('hidden'); }
function hideLoading() { loadingEl.classList.add('hidden'); }
function flashMsg(msg, isError) {
  const el = $('refreshMsg');
  el.textContent = msg;
  el.style.color = isError ? '#e74c3c' : '#27ae60';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function loadAllData() {
  showLoading();
  try {
    if (!proxyOnline && !(await checkProxy())) { tryFallback(); return; }
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

function buildFilters() {
  const epicMap = {};
  allEpics.forEach(e => { epicMap[e.key] = e.fields.summary || e.key; });
  epicItems = allEpics.filter(e => e.key).map(e => ({ key: e.key, summary: e.fields.summary || e.key }));
  const epics = new Set(), types = new Set(), arts = new Set(), teams = new Set();
  allTickets.forEach(t => {
    const ek = getEpicKey(t);
    if (ek) { const label = epicMap[ek] ? `${ek}::${epicMap[ek]}` : `${ek}::${ek}`; epics.add(label); }
    const type = t.fields.issuetype ? t.fields.issuetype.name : null;
    if (type) types.add(type);
    const art = getField(t, window.ART_FIELD || 'customfield_10001');
    if (art) arts.add(art);
    const team = getField(t, window.TEAM_FIELD || 'customfield_10002');
    if (team) teams.add(team);
  });
  populateSelect('filterFixVersion', allVersions.map(v => v.name), true);
  populateSelect('filterEpic', epicItems.map(e => ({ value: e.key, label: `${e.key}: ${e.summary}` })), false);
  populateSelect('filterType', [...types].sort(), true);
  populateSelect('filterArt', [...arts].sort(), true);
  populateSelect('filterTeam', [...teams].sort(), true);
  updateEpicLabel();
}

function populateSelect(id, items, isDropdown) {
  const sel = $(id);
  sel.innerHTML = '';
  if (isDropdown) {
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'All'; sel.appendChild(all);
  }
  items.forEach(item => {
    const opt = document.createElement('option');
    if (typeof item === 'object') { opt.value = item.value; opt.textContent = item.label; }
    else { opt.value = item; opt.textContent = item; }
    sel.appendChild(opt);
  });
}

function getSelected(id) {
  const sel = $(id);
  if (!sel.multiple) { const val = sel.value; return val ? [val] : []; }
  return Array.from(sel.selectedOptions).map(o => o.value);
}

function applyFilters() {
  const fixVersions = getSelected('filterFixVersion');
  const epics = getSelected('filterEpic');
  const types = getSelected('filterType');
  const arts = getSelected('filterArt');
  const teams = getSelected('filterTeam');
  filteredTickets = allTickets.filter(t => {
    if (fixVersions.length > 0) { const tv = getFixVersions(t); if (!tv.some(v => fixVersions.includes(v))) return false; }
    if (epics.length > 0) { const ek = getEpicKey(t); if (!ek || !epics.includes(ek)) return false; }
    if (types.length > 0) { const type = t.fields.issuetype ? t.fields.issuetype.name : ''; if (!types.includes(type)) return false; }
    if (arts.length > 0) { const art = getField(t, window.ART_FIELD || 'customfield_10001'); if (!art || !arts.includes(art)) return false; }
    if (teams.length > 0) { const team = getField(t, window.TEAM_FIELD || 'customfield_10002'); if (!team || !teams.includes(team)) return false; }
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
  renderStatusMatrix();
  renderCharts();
  currentPage = 0;
  renderTable();
}

function renderStats() {
  let newCount = 0, inProgCount = 0, doneCount = 0;
  filteredTickets.forEach(t => {
    const cat = getStatusCategory(t);
    if (cat === 'new') newCount++;
    else if (cat === 'inprogress') inProgCount++;
    else if (cat === 'done') doneCount++;
  });
  $('statTotal').textContent = filteredTickets.length;
  $('statNew').textContent = newCount;
  $('statInProgress').textContent = inProgCount;
  $('statDone').textContent = doneCount;
}

function renderStatusMatrix() {
  const counts = {};
  filteredTickets.forEach(t => {
    const s = getStatus(t);
    counts[s] = (counts[s] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const el = $('statusMatrix');
  el.innerHTML = entries.map(([status, count]) =>
    `<div class="status-matrix-item"><span class="sm-label">${status}</span><span class="sm-value">${count}</span></div>`
  ).join('');
}

function renderCharts() {
  if (charts.bar) charts.bar.destroy();
  if (charts.donut) charts.donut.destroy();
  if (charts.pie) charts.pie.destroy();
  if (charts.line) charts.line.destroy();
  renderBarChart();
  renderDonutChart();
  renderPieChart();
  renderLineChart();
}

const CHART_COLORS = ['#0066cc','#3498db','#9b59b6','#e74c3c','#e67e22','#f39c12','#27ae60','#1abc9c','#e84393','#95a5a6'];

function getColors(count) {
  return Array.from({ length: count }, (_, i) => CHART_COLORS[i % CHART_COLORS.length]);
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
    data: { labels, datasets: [{ label: 'Tickets', data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#7f8c8d', font: { size: 11 } }, grid: { color: 'rgba(209,216,224,.4)' } },
        y: { ticks: { color: '#7f8c8d', font: { size: 11 } }, grid: { color: 'rgba(209,216,224,.4)' }, beginAtZero: true }
      },
      onClick: (e, els) => { if (els.length > 0) toggleChartFilter('status', labels[els[0].index]); }
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
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7f8c8d', font: { size: 11 }, boxWidth: 12, padding: 12 } }
      },
      onClick: (e, els) => { if (els.length > 0) toggleChartFilter('type', labels[els[0].index]); }
    }
  });
}

function renderPieChart() {
  const dataMap = {};
  filteredTickets.forEach(t => {
    const sp = t.fields[STORY_POINTS_FIELD];
    const range = sp == null ? 'Unestimated' : sp <= 3 ? '≤ 3' : sp <= 8 ? '4-8' : sp <= 13 ? '9-13' : '> 13';
    dataMap[range] = (dataMap[range] || 0) + 1;
  });
  const labels = Object.keys(dataMap);
  const data = Object.values(dataMap);
  const colors = getColors(labels.length);
  charts.pie = new Chart($('chartPie'), {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7f8c8d', font: { size: 11 }, boxWidth: 12, padding: 12 } }
      }
    }
  });
}

function renderLineChart() {
  const monthData = {};
  filteredTickets.forEach(t => {
    const createdMonth = getMonth(t.fields.created);
    const resolvedMonth = getMonth(t.fields.resolutiondate);
    if (createdMonth) {
      if (!monthData[createdMonth]) monthData[createdMonth] = { created: 0, resolved: 0, cumOpen: 0 };
      monthData[createdMonth].created++;
    }
    if (resolvedMonth) {
      if (!monthData[resolvedMonth]) monthData[resolvedMonth] = { created: 0, resolved: 0, cumOpen: 0 };
      monthData[resolvedMonth].resolved++;
    }
  });
  let runningOpen = 0;
  const sortedMonths = Object.keys(monthData).sort();
  sortedMonths.forEach(m => {
    runningOpen += (monthData[m].created || 0) - (monthData[m].resolved || 0);
    monthData[m].cumOpen = runningOpen;
  });
  const labels = sortedMonths.length > 0 ? sortedMonths : ['2026-01'];
  const createdData = labels.map(m => monthData[m]?.created || 0);
  const resolvedData = labels.map(m => monthData[m]?.resolved || 0);
  const cumData = labels.map(m => monthData[m]?.cumOpen || 0);
  charts.line = new Chart($('chartLine'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Created', data: createdData, borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,.08)', fill: true, tension: .4, pointRadius: 3 },
        { label: 'Resolved', data: resolvedData, borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.08)', fill: true, tension: .4, pointRadius: 3 },
        { label: 'Open (Cumulative)', data: cumData, borderColor: '#e74c3c', backgroundColor: 'transparent', borderDash: [5, 5], tension: .4, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7f8c8d', font: { size: 11 }, boxWidth: 12, padding: 12 } }
      },
      scales: {
        x: { ticks: { color: '#7f8c8d', font: { size: 11 } }, grid: { color: 'rgba(209,216,224,.4)' } },
        y: { ticks: { color: '#7f8c8d', font: { size: 11 } }, grid: { color: 'rgba(209,216,224,.4)' }, beginAtZero: true }
      }
    }
  });
}

function toggleChartFilter(type, value) {
  if (activeChartFilter && activeChartFilter.type === type && activeChartFilter.value === value) {
    activeChartFilter = null;
  } else {
    activeChartFilter = { type, value };
  }
  applyFilters();
}

/* ─── Epic Modal ─── */
function updateEpicLabel() {
  const sel = $('filterEpic');
  const selected = Array.from(sel.selectedOptions).map(o => o.value);
  $('epicSelectedLabel').textContent = selected.length === 0 ? 'All' : `${selected.length} selected`;
}

function openEpicModal() {
  const sel = $('filterEpic');
  pendingEpics = new Set(Array.from(sel.selectedOptions).map(o => o.value));
  renderEpicList('');
  $('epicSearch').value = '';
  $('epicModal').classList.remove('hidden');
  $('epicSearch').focus();
}

function closeEpicModal() {
  $('epicModal').classList.add('hidden');
}

function renderEpicList(query) {
  const q = query.toLowerCase();
  const filtered = epicItems.filter(e =>
    e.key.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q)
  );
  const el = $('epicList');
  if (filtered.length === 0) {
    el.innerHTML = '<div class="no-results">No epics found</div>';
    return;
  }
  el.innerHTML = filtered.map(e => {
    const checked = pendingEpics.has(e.key) ? 'checked' : '';
    return `<label>
      <input type="checkbox" value="${e.key}" ${checked}>
      <span class="epic-key">${e.key}</span>
      <span class="epic-summary">${escapeHtml(e.summary)}</span>
    </label>`;
  }).join('');
  el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) pendingEpics.add(cb.value);
      else pendingEpics.delete(cb.value);
    };
  });
}

function applyEpicSelection() {
  const sel = $('filterEpic');
  Array.from(sel.options).forEach(opt => {
    opt.selected = pendingEpics.has(opt.value);
  });
  updateEpicLabel();
  closeEpicModal();
  activeChartFilter = null;
  applyFilters();
}

function clearEpicSelection() {
  pendingEpics.clear();
  const el = $('epicList');
  el.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
}

function renderTable() {
  const excluded = EXCLUDE_TYPES;
  const tableTickets = filteredTickets.filter(t => {
    const type = t.fields.issuetype ? t.fields.issuetype.name : '';
    return !excluded.includes(type);
  });

  const cols = ['Ticket ID', 'Assignee Name', 'Ticket Name', 'Story Points', 'Status', 'Created Date', 'End Date'];
  const thead = document.querySelector('#ticketsTable thead tr');
  thead.innerHTML = cols.map(c => `<th data-col="${c.toLowerCase().replace(/\s+/g, '')}">${c} <i class="fas fa-sort"></i></th>`).join('');

  const totalPages = Math.ceil(tableTickets.length / pageSize) || 1;
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  const start = currentPage * pageSize;
  const pageTickets = tableTickets.slice(start, start + pageSize);

  const tbody = document.querySelector('#ticketsTable tbody');
  tbody.innerHTML = pageTickets.map(t => {
    const key = t.key;
    const assignee = t.fields.assignee ? t.fields.assignee.displayName : 'Unassigned';
    const summary = t.fields.summary || '';
    const sp = t.fields[STORY_POINTS_FIELD];
    const storyPoints = sp != null ? sp : '';
    const status = getStatus(t);
    const createdRaw = t.fields.created || '';
    const created = createdRaw ? new Date(createdRaw).toLocaleDateString() : '';
    const resolutionRaw = t.fields.resolutiondate || '';
    const dueRaw = t.fields.duedate || '';
    const endRaw = resolutionRaw || dueRaw;
    const endDate = endRaw ? new Date(endRaw).toLocaleDateString() : '';
    return `<tr>
      <td data-sort="${key}"><a href="${key.startsWith('http') ? key : `https://${PROJECT_KEY}.atlassian.net/browse/${key}`}" target="_blank">${key}</a></td>
      <td data-sort="${escapeHtml(assignee.toLowerCase())}">${escapeHtml(assignee)}</td>
      <td data-sort="${escapeHtml(summary.toLowerCase())}">${escapeHtml(summary)}</td>
      <td data-sort="${storyPoints !== '' ? storyPoints : '-1'}">${storyPoints}</td>
      <td data-sort="${status.toLowerCase()}">${status}</td>
      <td data-sort="${createdRaw}">${created}</td>
      <td data-sort="${endRaw}">${endDate}</td>
    </tr>`;
  }).join('');

  $('tableStatus').textContent = `${tableTickets.length} issues`;
  renderPagination(tableTickets.length);

  document.querySelectorAll('#ticketsTable th').forEach(th => {
    th.onclick = () => sortTable(th.dataset.col);
  });
}

function renderPagination(totalItems) {
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  $('pageInfo').textContent = `${totalItems > 0 ? currentPage * pageSize + 1 : 0}-${Math.min((currentPage + 1) * pageSize, totalItems)} of ${totalItems}`;
  $('pagePrev').disabled = currentPage <= 0;
  $('pageNext').disabled = currentPage >= totalPages - 1;

  const pageNumEl = $('pageNumbers');
  let html = '';
  const maxVisible = 5;
  let startP = Math.max(0, currentPage - Math.floor(maxVisible / 2));
  let endP = Math.min(totalPages, startP + maxVisible);
  if (endP - startP < maxVisible) startP = Math.max(0, endP - maxVisible);
  for (let i = startP; i < endP; i++) {
    html += `<button class="page-btn${i === currentPage ? ' active' : ''}" data-page="${i}">${i + 1}</button>`;
  }
  pageNumEl.innerHTML = html;

  pageNumEl.querySelectorAll('.page-btn').forEach(btn => {
    btn.onclick = () => { currentPage = parseInt(btn.dataset.page); renderTable(); };
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
    const va = a.children[colIdx]?.getAttribute('data-sort') || a.children[colIdx]?.textContent.trim() || '';
    const vb = b.children[colIdx]?.getAttribute('data-sort') || b.children[colIdx]?.textContent.trim() || '';
    const na = parseFloat(va), nb = parseFloat(vb);
    if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    const da = new Date(va), db = new Date(vb);
    if (!isNaN(da.getTime()) && !isNaN(db.getTime())) return (da - db) * dir;
    return va.localeCompare(vb) * dir;
  });
  rows.forEach(r => tbody.appendChild(r));
  document.querySelectorAll('#ticketsTable th').forEach(th => {
    const icon = th.querySelector('i');
    if (th.dataset.col === col) { icon.className = dir === 1 ? 'fas fa-sort-up' : 'fas fa-sort-down'; }
    else { icon.className = 'fas fa-sort'; }
  });
}

$('tableSearch').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('#ticketsTable tbody tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

$('pagePrev').onclick = () => { if (currentPage > 0) { currentPage--; renderTable(); } };
$('pageNext').onclick = () => {
  const total = filteredTickets.filter(t => { const type = t.fields.issuetype ? t.fields.issuetype.name : ''; return !EXCLUDE_TYPES.includes(type); }).length;
  if ((currentPage + 1) * pageSize < total) { currentPage++; renderTable(); }
};
$('pageSizeSelect').onchange = function() {
  pageSize = parseInt(this.value);
  currentPage = 0;
  renderTable();
};

document.querySelectorAll('.sidebar select').forEach(sel => {
  if (sel.id !== 'filterEpic') {
    sel.addEventListener('change', () => { activeChartFilter = null; applyFilters(); });
  }
});

$('epicFilterBtn').onclick = openEpicModal;
$('epicModalClose').onclick = closeEpicModal;
$('epicApplyBtn').onclick = applyEpicSelection;
$('epicClearBtn').onclick = clearEpicSelection;
$('epicSearch').oninput = function() { renderEpicList(this.value); };
$('epicModal').onclick = function(e) { if (e.target === this) closeEpicModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEpicModal(); });

$('clearFiltersBtn').onclick = () => {
  document.querySelectorAll('.sidebar select').forEach(s => {
    if (s.multiple) s.selectedIndex = -1;
    else s.value = '';
  });
  updateEpicLabel();
  activeChartFilter = null;
  applyFilters();
};

$('refreshBtn').onclick = loadAllData;

document.querySelector('#ticketsTable tbody').addEventListener('click', e => {
  const link = e.target.closest('a');
  if (link) return;
  const row = e.target.closest('tr');
  if (row) {
    document.querySelectorAll('#ticketsTable tbody tr.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  }
});

function buildDashboard() {
  buildFilters();
  applyFilters();
}

async function init() {
  await checkProxy();
  await loadAllData();
}

init();
