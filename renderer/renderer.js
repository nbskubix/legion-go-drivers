'use strict';

// Category display names (some Lenovo labels are verbose)
const CATEGORY_MAP = {
  'Audio': 'Audio',
  'BIOS/UEFI': 'BIOS / UEFI',
  'Bluetooth and Modem': 'Bluetooth',
  'Camera and Card Reader': 'Camera & Card Reader',
  'Diagnostic': 'Diagnostics',
  'Display and Video Graphics': 'Display & Graphics',
  'Motherboard Devices (Backplanes, core chipset, onboard video, PCIe switches)': 'Chipset',
  'Networking: Wireless LAN': 'Wireless LAN',
  'Power Management': 'Power Management',
  'Software and Utilities': 'Software & Utilities',
  'Tool': 'Tools',
};

// Map a driver title to its category
const TITLE_CATEGORY_PATTERNS = [
  [/audio/i, 'Audio'],
  [/bios/i, 'BIOS/UEFI'],
  [/bluetooth/i, 'Bluetooth and Modem'],
  [/card.?reader|camera/i, 'Camera and Card Reader'],
  [/diagnostic/i, 'Diagnostic'],
  [/graphics|display|video|amd.*driver|radeon/i, 'Display and Video Graphics'],
  [/chipset|amd.*chipset/i, 'Motherboard Devices (Backplanes, core chipset, onboard video, PCIe switches)'],
  [/wlan|wireless|wi-?fi/i, 'Networking: Wireless LAN'],
  [/power|energy|battery/i, 'Power Management'],
  [/space|legion.*app|software/i, 'Software and Utilities'],
];

let allDrivers = [];
let categories = [];
let downloadDir = null;
let isCancelled = false;
let searchQuery = '';
let activeCategories = new Set();
let activePriorities = new Set();
let searchDebounceTimer = null;
const downloadedMap = new Map(); // docId -> { path }

const statusBar = document.getElementById('status-bar');
const driverList = document.getElementById('driver-list');
const toolbar = document.getElementById('toolbar');
const progressPanel = document.getElementById('progress-panel');
const progressItems = document.getElementById('progress-items');
const progressTitle = document.getElementById('progress-title');
const checkAll = document.getElementById('check-all');
const selectedCount = document.getElementById('selected-count');
const folderLabel = document.getElementById('folder-label');
const btnDownloadOnly = document.getElementById('btn-download-only');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const btnClearSearch = document.getElementById('btn-clear-search');
const btnFilters = document.getElementById('btn-filters');
const filterDrawer = document.getElementById('filter-drawer');
const filterBadge = document.getElementById('filter-badge');
const filterMatchCount = document.getElementById('filter-match-count');
const btnClearFilters = document.getElementById('btn-clear-filters');

// Windows-only controls
if (window.api.platform === 'win32') {
  document.getElementById('btn-check-outdated').style.display = 'inline-flex';
}

function setStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = type;
}

async function loadDrivers() {
  driverList.innerHTML = `<div class="state-message"><div class="spinner"></div><p>Fetching latest drivers from Lenovo...</p></div>`;
  toolbar.style.display = 'none';
  setStatus('Connecting to Lenovo support...');

  try {
    const result = await window.api.fetchDrivers();
    allDrivers = result.drivers;
    categories = result.categories;
    renderDriverList();
    populateFilterDrawer();
    checkDownloads();
    setStatus(`${allDrivers.length} drivers available · fetched live from Lenovo support`, 'ok');
    searchBar.style.display = 'flex';
    toolbar.style.display = 'flex';
    updateButtons();
  } catch (err) {
    driverList.innerHTML = `<div class="state-message">
      <div class="icon">⚠️</div>
      <h3>Could not load drivers</h3>
      <p>${err.message}</p>
      <button class="btn btn-primary" onclick="loadDrivers()">Retry</button>
    </div>`;
    setStatus('Error loading drivers — check your internet connection', 'error');
  }
}

function inferCategory(driver) {
  for (const [re, cat] of TITLE_CATEGORY_PATTERNS) {
    if (re.test(driver.title)) return cat;
  }
  return 'Software and Utilities';
}

function renderDriverList() {
  // Group drivers by category
  const grouped = {};
  for (const cat of categories) grouped[cat] = [];
  for (const driver of allDrivers) {
    const cat = inferCategory(driver);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(driver);
  }

  driverList.innerHTML = '';
  for (const [cat, drivers] of Object.entries(grouped)) {
    if (drivers.length === 0) continue;
    const displayName = CATEGORY_MAP[cat] || cat;
    const section = document.createElement('div');
    section.className = 'category-section';
    section.innerHTML = `
      <div class="category-header" data-cat="${escHtml(cat)}">
        <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        <span class="category-title">${escHtml(displayName)}</span>
        <span class="category-count">${drivers.length}</span>
      </div>
      <div class="category-body" data-cat-body="${escHtml(cat)}"></div>
    `;
    const body = section.querySelector('.category-body');
    for (const driver of drivers) {
      driver._category = cat;
      body.appendChild(makeDriverRow(driver, cat));
    }
    section.querySelector('.category-header').addEventListener('click', toggleCategory);
    driverList.appendChild(section);
  }
}

function makeDriverRow(driver, category = '') {
  const wrap = document.createElement('div');
  wrap.className = 'driver-wrap';
  wrap.dataset.docId = driver.docId;
  wrap.dataset.category = category;
  wrap.dataset.priority = driver.priority || '';

  const badgeClass = driver.priority === 'Critical' ? 'badge-critical' : 'badge-recommended';
  const version = driver.file?.version || '—';
  const size = driver.file?.size || '';
  const date = driver.file?.date || '';
  const lenovoUrl = `https://support.lenovo.com/us/en/downloads/${encodeURIComponent(driver.docId)}`;

  // Main collapsed row
  const row = document.createElement('div');
  row.className = 'driver-row';
  row.innerHTML = `
    <div class="driver-check">
      <input type="checkbox" data-doc-id="${escHtml(driver.docId)}" />
    </div>
    <div class="driver-info">
      <div class="driver-title" title="${escHtml(driver.title)}">${escHtml(driver.title)}</div>
      <div class="driver-meta">
        <span>v${escHtml(version)}</span>
        ${size ? `<span>${escHtml(size)}</span>` : ''}
        ${date ? `<span>${escHtml(date)}</span>` : ''}
      </div>
    </div>
    <div class="driver-status">
      <div class="driver-downloaded-state"></div>
      <span class="badge ${badgeClass}">${escHtml(driver.priority)}</span>
      <button class="btn-lenovo-link" data-url="${escHtml(lenovoUrl)}" title="View on Lenovo support">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </button>
      <button class="btn-expand" title="Show version history" aria-expanded="false">
        <svg class="expand-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    </div>
  `;

  // Expanded version panel (hidden by default)
  const panel = document.createElement('div');
  panel.className = 'driver-version-panel collapsed';
  panel.innerHTML = `
    <div class="version-current">
      <div class="version-label">Latest</div>
      ${makeVersionEntry(driver.file, true)}
    </div>
    <div class="older-versions-section">
      <button class="btn-older-toggle">
        <svg class="expand-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        Older versions
      </button>
      <div class="older-versions-body collapsed" data-loaded="false"></div>
    </div>
  `;

  // Wire up expand/collapse for the main panel
  const expandBtn = row.querySelector('.btn-expand');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.classList.toggle('collapsed') === false;
    expandBtn.setAttribute('aria-expanded', open);
    expandBtn.querySelector('.expand-chevron').style.transform = open ? 'rotate(180deg)' : '';
  });

  // Wire up older versions lazy load
  const olderToggle = panel.querySelector('.btn-older-toggle');
  const olderBody = panel.querySelector('.older-versions-body');
  olderToggle.addEventListener('click', async () => {
    const open = olderBody.classList.toggle('collapsed') === false;
    olderToggle.querySelector('.expand-chevron').style.transform = open ? 'rotate(180deg)' : '';

    if (open && olderBody.dataset.loaded === 'false') {
      olderBody.dataset.loaded = 'loading';
      olderBody.innerHTML = `<div class="version-loading"><div class="spinner"></div> Loading...</div>`;
      try {
        const { older } = await window.api.fetchDriverVersions(driver.docId);
        olderBody.dataset.loaded = 'true';
        if (older.length === 0) {
          olderBody.innerHTML = `<div class="version-empty">No older versions available</div>`;
        } else {
          olderBody.innerHTML = older.map(v => makeVersionEntry(v.file, false, v.docId)).join('');
        }
      } catch {
        olderBody.dataset.loaded = 'false';
        olderBody.innerHTML = `<div class="version-empty version-error">Failed to load — click to retry</div>`;
        olderBody.querySelector('.version-error').addEventListener('click', () => {
          olderBody.dataset.loaded = 'false';
          olderToggle.click();
        });
      }
    }
  });

  row.querySelector('input[type=checkbox]').addEventListener('change', onCheckChange);
  row.querySelector('.btn-lenovo-link').addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.openExternal(e.currentTarget.dataset.url);
  });

  wrap.appendChild(row);
  wrap.appendChild(panel);
  return wrap;
}

function makeVersionEntry(file, isLatest, docId = null) {
  if (!file) return '';
  const lenovoUrl = docId ? `https://support.lenovo.com/us/en/downloads/${encodeURIComponent(docId)}` : null;
  return `
    <div class="version-entry">
      <div class="version-entry-main">
        <span class="version-num">v${escHtml(file.version || '—')}</span>
        ${file.size ? `<span class="version-meta">${escHtml(file.size)}</span>` : ''}
        ${file.date ? `<span class="version-meta">${escHtml(file.date)}</span>` : ''}
        ${lenovoUrl ? `
          <a class="version-lenovo-link" data-url="${escHtml(lenovoUrl)}" title="View on Lenovo support" role="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>` : ''}
      </div>
      ${file.sha256 ? `<div class="version-hash" title="SHA256: ${escHtml(file.sha256)}">SHA256: ${escHtml(file.sha256.slice(0, 16))}…</div>` : ''}
    </div>
  `;
}

function toggleCategory(e) {
  const header = e.currentTarget;
  const cat = header.dataset.cat;
  const body = driverList.querySelector(`[data-cat-body="${CSS.escape(cat)}"]`);
  header.classList.toggle('collapsed');
  body.classList.toggle('collapsed');
}

function onCheckChange() {
  updateSelectAll();
  updateButtons();
}

function visibleCheckboxes() {
  return [...document.querySelectorAll('.driver-wrap:not([hidden]) .driver-check input')];
}

function updateSelectAll() {
  const all = visibleCheckboxes();
  const checked = all.filter(c => c.checked);
  checkAll.checked = all.length > 0 && checked.length === all.length;
  checkAll.indeterminate = checked.length > 0 && checked.length < all.length;
  selectedCount.textContent = checked.length > 0 ? `${checked.length} selected` : '0 selected';
}

function updateButtons() {
  const anyChecked = document.querySelector('.driver-check input:checked') !== null;
  const hasFolder = downloadDir !== null;
  btnDownloadOnly.disabled = !anyChecked || !hasFolder;
}

function getSelectedDrivers() {
  const docIds = new Set(
    [...document.querySelectorAll('.driver-check input:checked')].map(el => el.dataset.docId)
  );
  return allDrivers.filter(d => docIds.has(d.docId));
}

checkAll.addEventListener('change', () => {
  visibleCheckboxes().forEach(cb => { cb.checked = checkAll.checked; });
  updateSelectAll();
  updateButtons();
});

// Event delegation for dynamically-inserted older-version Lenovo links
driverList.addEventListener('click', (e) => {
  const link = e.target.closest('.version-lenovo-link');
  if (link) {
    e.stopPropagation();
    window.api.openExternal(link.dataset.url);
  }
});

// ── Wi-Fi driver extraction ───────────────────────────────────────────────────

async function extractWifiDriver(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Choosing folder…';

  const destDir = await window.api.chooseDownloadDir();
  if (!destDir) {
    btn.disabled = false;
    btn.textContent = original;
    return;
  }

  btn.textContent = 'Extracting…';
  try {
    const result = await window.api.extractWifiDriver(destDir);
    btn.textContent = 'Extracted ✓';
    btn.classList.add('btn-extracted');
    setTimeout(() => {
      window.api.openFolder(destDir);
    }, 400);
    // Brief success state, then reset
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
      btn.classList.remove('btn-extracted');
    }, 4000);
  } catch (err) {
    btn.textContent = 'Failed — see console';
    btn.disabled = false;
    console.error(err);
    setTimeout(() => { btn.textContent = original; }, 3000);
  }
}

document.getElementById('btn-wifi-extract').addEventListener('click', e => extractWifiDriver(e.currentTarget));

// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', loadDrivers);

document.getElementById('btn-folder').addEventListener('click', async () => {
  const dir = await window.api.chooseDownloadDir();
  if (dir) {
    applyDownloadDir(dir);
    window.api.saveSettings({ downloadDir: dir });
  }
});

btnDownloadOnly.addEventListener('click', () => startProcess('download'));

document.getElementById('btn-cancel').addEventListener('click', () => { isCancelled = true; });
document.getElementById('btn-done').addEventListener('click', closeProgressPanel);
document.getElementById('btn-open-folder').addEventListener('click', () => {
  if (downloadDir) window.api.openFolder(downloadDir);
});

async function startProcess(mode) {
  const selected = getSelectedDrivers();
  if (selected.length === 0 || !downloadDir) return;

  isCancelled = false;
  progressItems.innerHTML = '';
  progressPanel.style.display = 'flex';
  progressTitle.textContent = 'Downloading drivers...';
  document.getElementById('btn-open-folder').style.display = 'none';
  document.getElementById('btn-done').style.display = 'none';

  // Build progress item UI
  const itemEls = {};
  for (const driver of selected) {
    const el = makeProgressItem(driver);
    progressItems.appendChild(el);
    itemEls[driver.docId] = el;
  }

  // Listen for real-time progress from main process
  window.api.onDownloadProgress(({ docId, percent, status, algorithm }) => {
    const el = itemEls[docId];
    if (!el) return;
    const fill = el.querySelector('.progress-bar-fill');
    const state = el.querySelector('.progress-item-state');
    fill.style.width = (percent ?? 0) + '%';

    if (status === 'verifying') {
      state.textContent = `Verifying (${algorithm})…`;
      state.className = 'progress-item-state state-verifying';
    } else if (status === 'verified') {
      fill.classList.add('done');
      state.textContent = `Verified ✓ ${algorithm}`;
      state.className = 'progress-item-state state-done';
    } else if (status === 'cached') {
      fill.classList.add('done');
      state.textContent = algorithm ? `Already verified ✓ ${algorithm}` : 'Already downloaded ✓';
      state.className = 'progress-item-state state-done';
    } else if (status === 'done') {
      fill.classList.add('done');
      state.textContent = 'Downloaded ✓';
      state.className = 'progress-item-state state-done';
    } else {
      state.textContent = `${percent}%`;
      state.className = 'progress-item-state state-downloading';
    }
  });

  let errors = 0;
  for (const driver of selected) {
    if (isCancelled) break;
    const el = itemEls[driver.docId];
    const state = el.querySelector('.progress-item-state');
    const fill = el.querySelector('.progress-bar-fill');

    try {
      // Download
      setState(state, fill, 'Downloading…', 'state-downloading', 0);
      const dlResult = await window.api.downloadDriver({
        docId: driver.docId,
        url: driver.file.url,
        destDir: downloadDir,
        sha256: driver.file.sha256 || null,
        sha1: driver.file.sha1 || null,
        md5: driver.file.md5 || null,
        categoryName: CATEGORY_MAP[driver._category] || driver._category || 'Other',
        driverName: driver.file.name || '',
        version: driver.file.version || '',
      });

      // Progress events drove the UI to verified/done state — nothing to set here
    } catch (err) {
      errors++;
      setState(state, fill, `Error: ${err.message}`, 'state-error', 100);
      fill.classList.add('error');
    }
  }

  window.api.removeDownloadProgressListener();

  if (isCancelled) {
    progressTitle.textContent = 'Cancelled.';
  } else if (errors > 0) {
    progressTitle.textContent = `Done — ${errors} error(s). Check items above.`;
  } else {
    progressTitle.textContent = 'Download complete!';
  }

  document.getElementById('btn-open-folder').style.display = 'inline-flex';
  document.getElementById('btn-done').style.display = 'inline-flex';
  document.getElementById('btn-cancel').style.display = 'none';
}

function setState(stateEl, fillEl, text, cls, percent) {
  stateEl.textContent = text;
  stateEl.className = `progress-item-state ${cls}`;
  if (percent !== undefined) fillEl.style.width = percent + '%';
}

function makeProgressItem(driver) {
  const el = document.createElement('div');
  el.className = 'progress-item';
  el.innerHTML = `
    <div class="progress-item-header">
      <span class="progress-item-title" title="${escHtml(driver.title)}">${escHtml(driver.title)}</span>
      <span class="progress-item-state state-pending">Waiting…</span>
    </div>
    <div class="progress-bar-track"><div class="progress-bar-fill" style="width:0%"></div></div>
  `;
  return el;
}

function closeProgressPanel() {
  progressPanel.style.display = 'none';
  document.getElementById('btn-cancel').style.display = 'inline-flex';
  document.getElementById('btn-done').style.display = 'none';
  checkDownloads();
}

// ── Filter & search ──────────────────────────────────────────────────────────

function populateFilterDrawer() {
  const catContainer = document.getElementById('filter-chips-category');
  const priContainer = document.getElementById('filter-chips-priority');
  catContainer.innerHTML = '';
  priContainer.innerHTML = '';

  // Collect categories that have at least one driver
  const usedCategories = [...new Set(
    allDrivers.map(d => {
      const wrap = document.querySelector(`[data-doc-id="${CSS.escape(d.docId)}"]`);
      return wrap?.dataset.category || '';
    }).filter(Boolean)
  )];

  for (const cat of usedCategories) {
    const displayName = CATEGORY_MAP[cat] || cat;
    catContainer.appendChild(makeFilterChip(displayName, cat, 'category'));
  }

  const usedPriorities = [...new Set(allDrivers.map(d => d.priority).filter(Boolean))];
  for (const pri of usedPriorities) {
    priContainer.appendChild(makeFilterChip(pri, pri, 'priority'));
  }
}

function makeFilterChip(label, value, group) {
  const chip = document.createElement('button');
  chip.className = 'filter-chip';
  chip.textContent = label;
  chip.dataset.value = value;
  chip.dataset.group = group;
  chip.addEventListener('click', () => {
    const isActive = chip.classList.toggle('active');
    if (group === 'category') {
      isActive ? activeCategories.add(value) : activeCategories.delete(value);
    } else {
      isActive ? activePriorities.add(value) : activePriorities.delete(value);
    }
    updateFilterBadge();
    applyFilters();
  });
  return chip;
}

function updateFilterBadge() {
  const count = activeCategories.size + activePriorities.size;
  if (count > 0) {
    filterBadge.textContent = count;
    filterBadge.style.display = 'inline-flex';
    btnFilters.classList.add('filters-active');
  } else {
    filterBadge.style.display = 'none';
    btnFilters.classList.remove('filters-active');
  }
}

function applyFilters() {
  const query = searchQuery.toLowerCase();
  let visibleCount = 0;

  document.querySelectorAll('.driver-wrap').forEach(wrap => {
    const title = wrap.querySelector('.driver-title')?.textContent.toLowerCase() || '';
    const cat = wrap.dataset.category || '';
    const pri = wrap.dataset.priority || '';

    const matchesSearch = !query || title.includes(query);
    const matchesCategory = activeCategories.size === 0 || activeCategories.has(cat);
    const matchesPriority = activePriorities.size === 0 || activePriorities.has(pri);

    const visible = matchesSearch && matchesCategory && matchesPriority;
    wrap.hidden = !visible;
    if (visible) visibleCount++;
  });

  // Show/hide category sections based on whether any children are visible
  document.querySelectorAll('.category-section').forEach(section => {
    const hasVisible = section.querySelector('.driver-wrap:not([hidden])') !== null;
    section.hidden = !hasVisible;
  });

  // Update match count label
  const hasFilter = query || activeCategories.size > 0 || activePriorities.size > 0;
  filterMatchCount.textContent = hasFilter ? `${visibleCount} of ${allDrivers.length} drivers` : '';

  updateSelectAll();
  updateButtons();
}

// Search input events
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  btnClearSearch.style.display = searchInput.value ? 'inline-flex' : 'none';
  searchDebounceTimer = setTimeout(() => {
    searchQuery = searchInput.value.trim();
    applyFilters();
  }, 150);
});

btnClearSearch.addEventListener('click', () => {
  searchInput.value = '';
  searchInput.focus();
  btnClearSearch.style.display = 'none';
  searchQuery = '';
  applyFilters();
});

// Filter drawer toggle
btnFilters.addEventListener('click', () => {
  const isOpen = filterDrawer.style.display !== 'none';
  filterDrawer.style.display = isOpen ? 'none' : 'flex';
  btnFilters.classList.toggle('drawer-open', !isOpen);
});

// Clear all filters
btnClearFilters.addEventListener('click', () => {
  activeCategories.clear();
  activePriorities.clear();
  document.querySelectorAll('.filter-chip.active').forEach(c => c.classList.remove('active'));
  updateFilterBadge();
  applyFilters();
});

// ─────────────────────────────────────────────────────────────────────────────

// ── Downloaded state ─────────────────────────────────────────────────────────

async function checkDownloads() {
  if (!downloadDir || allDrivers.length === 0) return;

  const driverMeta = allDrivers.map(d => ({
    docId: d.docId,
    categoryName: CATEGORY_MAP[d._category] || d._category || 'Other',
    driverName: d.file?.name || '',
    version: d.file?.version || '',
    url: d.file?.url || '',
  }));

  const results = await window.api.checkDownloads({ downloadDir, drivers: driverMeta });

  downloadedMap.clear();
  for (const [docId, info] of Object.entries(results)) {
    if (info.exists) downloadedMap.set(docId, info);
  }

  for (const driver of allDrivers) {
    updateDownloadedUI(driver.docId, downloadedMap.get(driver.docId) || null);
  }

  updateSelectAll();
  updateButtons();
}

function updateDownloadedUI(docId, info) {
  const wrap = document.querySelector(`.driver-wrap[data-doc-id="${CSS.escape(docId)}"]`);
  if (!wrap) return;
  const stateEl = wrap.querySelector('.driver-downloaded-state');
  const checkbox = wrap.querySelector('.driver-check input');
  if (info) {
    checkbox.checked = true;
    stateEl.innerHTML = `
      <div class="downloaded-tag">
        <span class="downloaded-dot"></span>
        Downloaded
        <button class="btn-delete-driver" title="Delete file">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>`;
    stateEl.querySelector('.btn-delete-driver').addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteConfirm(stateEl, docId, info.path);
    });
  } else {
    checkbox.checked = false;
    stateEl.innerHTML = '';
  }
}

function showDeleteConfirm(stateEl, docId, filePath) {
  stateEl.innerHTML = `
    <div class="downloaded-tag confirming">
      Delete file?
      <button class="btn-delete-confirm" title="Confirm delete">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
      <button class="btn-delete-cancel" title="Cancel">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;

  stateEl.querySelector('.btn-delete-confirm').addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.api.deleteDownload(filePath);
    if (result.success) {
      downloadedMap.delete(docId);
      updateDownloadedUI(docId, null);
      updateSelectAll();
      updateButtons();
    } else {
      stateEl.innerHTML = `<div class="downloaded-tag error-tag">Delete failed</div>`;
      setTimeout(() => updateDownloadedUI(docId, downloadedMap.get(docId) || null), 2000);
    }
  });

  stateEl.querySelector('.btn-delete-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    updateDownloadedUI(docId, downloadedMap.get(docId) || null);
  });
}

// ── Check Outdated ───────────────────────────────────────────────────────────

const STATUS_LABEL = {
  'up-to-date':   'Up to date',
  'outdated':     'Update available',
  'newer':        'Newer installed',
  'not-detected': 'Not detected',
  'unknown':      'Unknown',
};

document.getElementById('btn-check-outdated').addEventListener('click', openOutdatedPanel);
document.getElementById('btn-outdated-close').addEventListener('click', closeOutdatedPanel);

async function openOutdatedPanel() {
  const panel     = document.getElementById('outdated-panel');
  const body      = document.getElementById('outdated-body');
  const title     = document.getElementById('outdated-title');
  const footer    = document.getElementById('outdated-footer');
  const summary   = document.getElementById('outdated-summary');
  const btnSelect = document.getElementById('btn-select-outdated');

  panel.style.display = 'flex';
  footer.style.display = 'none';
  btnSelect.style.display = 'none';
  title.textContent = 'Checking installed versions…';
  body.innerHTML = `<div class="outdated-loading"><div class="spinner"></div>Running version check — this takes a few seconds…</div>`;

  const driverMeta = allDrivers.map(d => ({
    docId: d.docId,
    title: d.title,
    name: d.file?.name || '',
    version: d.file?.version || '',
  }));

  let results;
  try {
    results = await window.api.checkOutdated({ drivers: driverMeta });
  } catch (err) {
    body.innerHTML = `<div class="outdated-error">⚠ ${escHtml(err.message)}</div>`;
    title.textContent = 'Check failed';
    footer.style.display = 'flex';
    summary.textContent = '';
    return;
  }

  body.innerHTML = '';
  let outdatedCount = 0;
  const outdatedDocIds = [];

  for (const r of results) {
    if (r.status === 'outdated') { outdatedCount++; outdatedDocIds.push(r.docId); }
    const row = document.createElement('div');
    row.className = 'outdated-row';
    row.innerHTML = `
      <div class="outdated-driver-name" title="${escHtml(r.title)}">${escHtml(r.title)}</div>
      <div class="outdated-versions">
        <div class="outdated-ver-col">
          <div class="outdated-ver-label">Installed</div>
          <div class="outdated-ver-value ${r.installedVersion ? '' : 'muted'}">${escHtml(r.installedVersion || 'Not detected')}</div>
        </div>
        <div class="outdated-arrow">→</div>
        <div class="outdated-ver-col">
          <div class="outdated-ver-label">Available</div>
          <div class="outdated-ver-value">${escHtml(r.lenovoVersion || '—')}</div>
        </div>
      </div>
      <span class="badge badge-${escHtml(r.status)}">${escHtml(STATUS_LABEL[r.status] || r.status)}</span>
    `;
    body.appendChild(row);
  }

  title.textContent = 'Installed vs Available';
  footer.style.display = 'flex';

  if (outdatedCount > 0) {
    summary.textContent = `${outdatedCount} driver${outdatedCount > 1 ? 's' : ''} can be updated`;
    btnSelect.style.display = 'inline-flex';
    btnSelect.onclick = () => {
      // Pre-select outdated drivers in the main list
      document.querySelectorAll('.driver-check input').forEach(cb => {
        cb.checked = outdatedDocIds.includes(cb.dataset.docId);
      });
      updateSelectAll();
      updateButtons();
      closeOutdatedPanel();
    };
  } else {
    summary.textContent = 'All detected drivers are up to date';
  }
}

function closeOutdatedPanel() {
  document.getElementById('outdated-panel').style.display = 'none';
}

// ── Onboarding ────────────────────────────────────────────────────────────────

function applyDownloadDir(dir) {
  downloadDir = dir;
  const short = dir.length > 35 ? '…' + dir.slice(-32) : dir;
  folderLabel.textContent = short;
  updateButtons();
  checkDownloads();
}

function showOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  const display = document.getElementById('onboarding-folder-display');
  const browse = document.getElementById('onboarding-browse');
  const confirm = document.getElementById('onboarding-confirm');

  overlay.style.display = 'flex';

  const wifiBtn = document.getElementById('onboarding-extract-wifi');
  if (wifiBtn) {
    wifiBtn.addEventListener('click', () => extractWifiDriver(wifiBtn));
  }

  browse.addEventListener('click', async () => {
    const dir = await window.api.chooseDownloadDir();
    if (!dir) return;
    display.textContent = dir.length > 40 ? '…' + dir.slice(-38) : dir;
    display.classList.add('selected');
    confirm.disabled = false;
    confirm.dataset.dir = dir;
  });

  confirm.addEventListener('click', () => {
    const dir = confirm.dataset.dir;
    if (!dir) return;
    applyDownloadDir(dir);
    window.api.saveSettings({ downloadDir: dir });
    overlay.style.display = 'none';
  });
}

async function boot() {
  const settings = await window.api.getSettings();
  if (settings.downloadDir) {
    applyDownloadDir(settings.downloadDir);
  } else {
    showOnboarding();
  }
  loadDrivers();
}

// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

boot();
