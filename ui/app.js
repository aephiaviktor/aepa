import { formatRegionCode, rankMiningDestinations } from '../dist/src/automation-options.js';
import { FLEET_COLUMNS, describeFleetShips, getFleetOwnership, normalizeVisibleColumns } from '../dist/src/fleet-view.js';
import { estimateCurrentCopper, formatLocalHhmm } from '../dist/src/copper-estimate.js';

const $ = (id) => document.getElementById(id);
const FLEET_COLUMNS_KEY = 'aepa.fleetColumns.v1';
const AUTOMATION_DRAFT_KEY = 'aepa.automationDrafts.v2';
let settings;
let signerStatus;
let loadedFleets = [];
let automationCatalog;
let automationCatalogLoad;
let automationRuntime;
let lastFleetSnapshotKey;
let lastCopperLoopPlan;

function short(value) {
  return value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '—';
}

function readVisibleColumns() {
  try { return normalizeVisibleColumns(JSON.parse(localStorage.getItem(FLEET_COLUMNS_KEY))); }
  catch { return normalizeVisibleColumns(null); }
}

let visibleColumns = readVisibleColumns();

function renderFleets(fleets) {
  loadedFleets = fleets;
  $('fleet-count').textContent = String(fleets.length);
  $('fleet-head').replaceChildren();
  for (const column of FLEET_COLUMNS.filter(({ id }) => visibleColumns.includes(id))) {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = column.label;
    $('fleet-head').append(header);
  }
  $('fleet-rows').replaceChildren();
  if (!fleets.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = Math.max(visibleColumns.length, 1);
    cell.className = 'empty';
    cell.textContent = 'No fleets loaded for this Player Profile.';
    row.append(cell);
    $('fleet-rows').append(row);
    $('last-update').textContent = 'No fleet snapshot';
    return;
  }
  for (const fleet of fleets) {
    const row = document.createElement('tr');
    const ownership = getFleetOwnership(fleet.snapshot, settings.playerProfile);
    const values = {
      fleet: fleet.name,
      state: fleet.state,
      ships: describeFleetShips(fleet.snapshot),
      ownership,
      address: fleet.address,
      updated: new Date(fleet.updatedAt).toLocaleString(),
    };
    for (const column of FLEET_COLUMNS.filter(({ id }) => visibleColumns.includes(id))) {
      const cell = document.createElement('td');
      const value = values[column.id];
      if (column.id === 'state' || column.id === 'ownership') {
        const pill = document.createElement('span');
        pill.className = `state-pill${column.id === 'ownership' && value === 'Managed' ? ' warning' : ''}`;
        const mining = column.id === 'state' ? miningPillContent(value, fleet.address) : null;
        pill.textContent = mining ? mining.label : value;
        if (mining) {
          pill.dataset.miningPill = 'true';
          pill.dataset.fleetAddress = fleet.address;
          bindMiningPill(pill);
        }
        cell.append(pill);
      } else {
        cell.textContent = column.id === 'address' ? short(value) : value;
        if (column.id === 'address') { cell.className = 'address'; cell.title = value; }
        if (column.id === 'ships') { cell.className = 'ships'; cell.title = value; }
      }
      row.append(cell);
    }
    $('fleet-rows').append(row);
  }
  $('last-update').textContent = `Snapshot ${new Date(fleets[0].updatedAt).toLocaleString()}`;
}

function snapshotAge(value) {
  if (!value) return 'unknown age';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m old`;
  return `${Math.floor(seconds / 3_600)}h old`;
}

let lastFleetSnapshot;

function friendlySyncError(raw) {
  const message = String(raw || '');
  if (/character account was not found/.test(message)) {
    return 'The character account was not found (z.ink game state unavailable). Will retry automatically.';
  }
  return `Reconnecting… last error: ${message.slice(0, 120)}. Will retry automatically.`;
}

function renderFleetSnapshot(snapshot) {
  lastFleetSnapshot = snapshot;
  const key = JSON.stringify([snapshot.sync, snapshot.fleets.map((fleet) => [fleet.address, fleet.updatedAt])]);
  if (key !== lastFleetSnapshotKey) {
    renderFleets(snapshot.fleets);
    lastFleetSnapshotKey = key;
  }
  const { sync, payload } = snapshot;
  const age = snapshotAge(sync.lastSucceededAt || snapshot.fleets[0]?.updatedAt);
  $('fleet-sync-status').title = '';
  if (sync.status === 'ready') {
    $('rpc-status').textContent = 'Connected';
    $('fleet-sync-status').textContent = `Synced · ${age}${sync.chainSlot ? ` · slot ${sync.chainSlot}` : ''}`;
  } else if (sync.status === 'refreshing') {
    $('rpc-status').textContent = 'Reading C4 accounts…';
    $('fleet-sync-status').textContent = snapshot.fleets.length ? `Cached snapshot · ${age} · refreshing…` : 'Loading from C4…';
  } else if (sync.status === 'error') {
    $('rpc-status').textContent = 'Reconnecting… using last-good SQLite data';
    $('fleet-sync-status').textContent = `Cached snapshot · ${age} · retrying automatically`;
    $('fleet-sync-status').title = sync.lastError || '';
  } else {
    $('rpc-status').textContent = 'Connecting automatically…';
    $('fleet-sync-status').textContent = snapshot.fleets.length ? `Cached snapshot · ${age} · refresh pending` : 'Waiting for first on-chain sync';
  }
  if (payload?.characterAddress) {
    $('character').textContent = `Character ${short(payload.characterAddress)}`;
    $('character').title = payload.characterAddress;
  }
  if (payload?.copperLoop) lastCopperLoopPlan = payload.copperLoop;
  // Always try to load the automation catalog when missing: the catalog layer
  // serves the cached SQLite snapshot when the live z.ink read is unavailable,
  // so the Automation page stays populated during outages instead of a dead
  // "Connect to load…" message.
  if (!automationCatalog) void ensureAutomationCatalog().catch(() => undefined);
}

async function ensureAutomationCatalog(force = false) {
  if (automationCatalogLoad) return automationCatalogLoad;
  if (automationCatalog && !force) return automationCatalog;
  $('automation-empty').textContent = "Reconnecting… loading from cache or C4…";
  automationCatalogLoad = window.aepa.loadAutomationCatalog().then((catalog) => {
    renderAutomationCatalog(catalog);
    return catalog;
  }).catch((error) => {
    $('automation-empty').textContent = friendlySyncError(error?.message || error);
    throw error;
  }).finally(() => { automationCatalogLoad = undefined; });
  return automationCatalogLoad;
}

function initializeColumnSelector() {
  for (const input of document.querySelectorAll('#fleet-column-selector input[type="checkbox"]')) {
    input.checked = visibleColumns.includes(input.value);
    input.addEventListener('change', () => {
      visibleColumns = normalizeVisibleColumns([...document.querySelectorAll('#fleet-column-selector input:checked')].map((item) => item.value));
      localStorage.setItem(FLEET_COLUMNS_KEY, JSON.stringify(visibleColumns));
      renderFleets(loadedFleets);
    });
  }
}

function setStatusOpen(open) {
  $('status-panel').hidden = !open;
  $('app-shell').classList.toggle('status-open', open);
  $('show-status').classList.toggle('active', open);
  $('show-status').toggleAttribute('aria-current', open);
  if (open) renderStatusPanel();
}

function renderStatusPanel() {
  const host = $('status-fleets');
  if (!$('status-panel') || $('status-panel').hidden) return;
  host.replaceChildren();
  const fleets = lastFleetSnapshot?.fleets ?? [];
  if (!fleets.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No fleets loaded yet.';
    host.append(empty);
    return;
  }
  for (const fleet of fleets) {
    const row = document.createElement('div');
    row.className = 'status-fleet';
    const name = document.createElement('strong');
    name.textContent = fleet.name;
    const pill = document.createElement('span');
    pill.className = 'state-pill';
    const mining = miningPillContent(fleet.state, fleet.address);
    pill.textContent = mining ? mining.label : fleet.state;
    if (mining) {
      pill.dataset.miningPill = 'true';
      pill.dataset.fleetAddress = fleet.address;
      bindMiningPill(pill);
    }
    // Status bar is fleet data only: name + state pill, no activity/error text.
    row.append(name, pill);
    host.append(row);
  }
}

function savedDrafts() {
  const assignments = automationRuntime?.assignments ?? (automationRuntime?.assignment ? [automationRuntime.assignment] : []);
  return assignments.map(({ fleetAddress, assignment, homeSystemAddress, resourceId, destinationAddress, travelMode }) => ({
    fleetAddress, assignment, homeSystemAddress, resourceId, destinationAddress, travelMode,
  }));
}

function readAutomationDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(AUTOMATION_DRAFT_KEY));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function writeAutomationDrafts() {
  const drafts = [...document.querySelectorAll('.automation-fleet-row')].map(readAutomationRow);
  localStorage.setItem(AUTOMATION_DRAFT_KEY, JSON.stringify(drafts));
  return drafts;
}

function restoreSavedAssignment() {
  const drafts = savedDrafts();
  localStorage.setItem(AUTOMATION_DRAFT_KEY, JSON.stringify(drafts));
  renderAutomationRows(drafts.length ? drafts : [{}]);
}

function showSettings(open) { $('settings-overlay').hidden = !open; }

function setActivePage(page) {
  const automation = page === 'automation';
  $('fleets-page').hidden = automation;
  $('automation-page').hidden = !automation;
  $('fleet-column-picker').hidden = automation;
  $('show-fleets').classList.toggle('active', !automation);
  $('show-automation').classList.toggle('active', automation);
  $('show-fleets').toggleAttribute('aria-current', !automation);
  $('show-automation').toggleAttribute('aria-current', automation);
  $('page-title').textContent = automation ? 'Automation' : 'Fleet Control';
}

function renderSignerStatus(status) {
  signerStatus = status;
  const authorized = status?.configured && status.authorizedForProfile && !status.error;
  $('signer-status').textContent = authorized
    ? `Signer ${short(status.publicKey)} — C4 authority verified; DPAPI encrypted`
    : status?.error || 'No signer configured; no RPC writes';
  $('signer-status').title = status?.publicKey || '';
  $('signer-settings-status').textContent = authorized
    ? `Stored securely — ${short(status.publicKey)} matches the active C4 authority`
    : status?.error || 'No signer configured';
  $('store-signer').textContent = status?.configured ? 'Replace signer securely' : 'Store signer securely';
  $('remove-signer').disabled = !status?.configured;
  if (automationRuntime) renderAutomationState(automationRuntime);
}

function replaceSelectOptions(select, options, preferredValue) {
  select.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option');
    element.value = String(option.value);
    element.textContent = option.label;
    select.append(element);
  }
  if (preferredValue != null && options.some((option) => String(option.value) === String(preferredValue))) select.value = String(preferredValue);
}

function readAutomationRow(row) {
  return {
    fleetAddress: row.querySelector('[data-field="fleet"]').value,
    assignment: row.querySelector('[data-field="assignment"]').value,
    homeSystemAddress: row.querySelector('[data-field="home"]').value,
    resourceId: Number(row.querySelector('[data-field="resource"]').value),
    destinationAddress: row.querySelector('[data-field="destination"]').value,
    travelMode: row.querySelector('[data-field="travel"]').value,
  };
}

function availableFleetOptions(row, preferredValue) {
  const used = new Set([...document.querySelectorAll('.automation-fleet-row')]
    .filter((candidate) => candidate !== row)
    .map((candidate) => candidate.querySelector('[data-field="fleet"]').value));
  return automationCatalog.fleets
    .filter((fleet) => fleet.address === preferredValue || !used.has(fleet.address))
    .map((fleet) => ({ value: fleet.address, label: `${fleet.name} | ${fleet.state}` }));
}

function refreshAutomationRow(row, preferredDestination, preferredTravelMode) {
  const draft = readAutomationRow(row);
  const home = automationCatalog.homeStarbases.find((candidate) => candidate.systemAddress === draft.homeSystemAddress);
  const destinations = home && Number.isSafeInteger(draft.resourceId)
    ? rankMiningDestinations({ faction: automationCatalog.faction, resourceId: draft.resourceId, home: home.coordinates, destinations: automationCatalog.destinations })
    : [];
  const destination = row.querySelector('[data-field="destination"]');
  replaceSelectOptions(destination, destinations.map((value) => ({ value: value.address, label: value.label })), preferredDestination);
  const selected = destinations.find((value) => value.address === destination.value);
  const travel = row.querySelector('[data-field="travel"]');
  travel.options[0].textContent = selected?.distance === 0 ? 'Not required (same system)' : 'Auto';
  travel.disabled = selected?.distance === 0;
  if (selected?.distance === 0) travel.value = 'auto';
  else if (preferredTravelMode && [...travel.options].some((option) => option.value === preferredTravelMode)) travel.value = preferredTravelMode;
  writeAutomationDrafts();
  updateAssignmentControls();
}

function createAutomationRow(draft = {}) {
  const row = document.createElement('div');
  row.className = 'automation-fleet-row';
  row.innerHTML = `<div class="field-grid compact-field-grid">
    <label>Fleet<select data-field="fleet"></select></label>
    <label>Assignment<select data-field="assignment"><option value="mining">Mining</option></select></label>
    <label>Home Starbase<select data-field="home"></select></label>
    <label>Resource<select data-field="resource"></select></label>
    <label class="destination-field">Mining Destination<small>Region | System | Asteroid belt | Distance</small><select data-field="destination"></select></label>
    <label>Travel<select data-field="travel"><option value="auto">Auto</option><option value="warp">Warp</option><option value="subwarp">Subwarp</option></select></label>
    <button class="remove-fleet icon" type="button" aria-label="Remove fleet assignment">×</button>
  </div>`;
  const fleet = row.querySelector('[data-field="fleet"]');
  replaceSelectOptions(fleet, availableFleetOptions(row, draft.fleetAddress), draft.fleetAddress);
  replaceSelectOptions(row.querySelector('[data-field="home"]'), automationCatalog.homeStarbases.map((home) => ({ value: home.systemAddress, label: `${formatRegionCode(home.regionOwner, home.regionId)} | ${home.systemName}` })), draft.homeSystemAddress);
  replaceSelectOptions(row.querySelector('[data-field="resource"]'), automationCatalog.resources.map((resource) => ({ value: resource.id, label: resource.name })), draft.resourceId ?? automationCatalog.resources.find((resource) => resource.name === 'Copper Ore')?.id);
  row.querySelector('[data-field="assignment"]').value = draft.assignment || 'mining';
  for (const select of row.querySelectorAll('select')) select.addEventListener('change', () => {
    if (select.dataset.field === 'fleet') renderAutomationRows(writeAutomationDrafts());
    else refreshAutomationRow(row, row.querySelector('[data-field="destination"]').value, row.querySelector('[data-field="travel"]').value);
  });
  row.querySelector('.remove-fleet').onclick = () => {
    row.remove();
    renderAutomationRows(writeAutomationDrafts());
  };
  refreshAutomationRow(row, draft.destinationAddress, draft.travelMode);
  const persisted = (automationRuntime?.assignments ?? []).find((assignment) => assignment.fleetAddress === fleet.value);
  if (persisted?.enabled || persisted?.status === 'paused') {
    for (const select of row.querySelectorAll('select')) select.disabled = true;
    row.querySelector('.remove-fleet').disabled = true;
    row.classList.add('locked');
  }
  return row;
}

function renderAutomationRows(drafts) {
  const host = $('automation-rows');
  host.replaceChildren();
  const source = drafts.length ? drafts : [{}];
  for (const draft of source) host.append(createAutomationRow(draft));
  const rows = [...host.querySelectorAll('.automation-fleet-row')];
  for (const row of rows) row.querySelector('.remove-fleet').hidden = rows.length === 1;
  $('add-fleet').disabled = rows.length >= automationCatalog.fleets.length;
  writeAutomationDrafts();
  updateAssignmentControls();
}

function renderAutomationIssues(state) {
  const assignments = state?.assignments ?? (state?.assignment ? [state.assignment] : []);
  const issues = assignments.filter((assignment) => assignment.status === 'paused' || assignment.lastError);
  $('automation-issues').hidden = issues.length === 0;
  $('automation-issue-list').replaceChildren(...issues.map((assignment) => {
    const item = document.createElement('div');
    item.className = 'automation-issue';
    const name = document.createElement('strong'); name.textContent = assignment.fleetName;
    const detail = document.createElement('span'); detail.textContent = assignment.lastError || `Automation is ${assignment.status}`;
    item.append(name, detail);
    return item;
  }));
}

function updateAssignmentControls() {
  const assignments = automationRuntime?.assignments ?? [];
  const rows = [...document.querySelectorAll('.automation-fleet-row')];
  $('save-assignment').disabled = rows.length === 0 || rows.some((row) => !row.querySelector('[data-field="destination"]').value);
  $('automation-mode').textContent = assignments.some((assignment) => assignment.enabled) ? `LIVE — ${assignments.filter((assignment) => assignment.enabled).length} running` : assignments.some((assignment) => assignment.status === 'paused') ? 'Attention required' : 'Disabled';
}

function renderAutomationState(state) {
  automationRuntime = state;
  renderAutomationIssues(state);
  updateAssignmentControls();
}

function renderAutomationCatalog(catalog) {
  automationCatalog = catalog;
  const drafts = savedDrafts();
  renderAutomationRows(drafts.length ? drafts : (readAutomationDrafts().length ? readAutomationDrafts() : [{}]));
  $('automation-empty').hidden = true;
  $('automation-config').hidden = false;
}

let miningTooltip;
let miningTooltipAnchor;
let miningTooltipShownValue;

function ensureMiningTooltip() {
  if (!miningTooltip) {
    miningTooltip = document.createElement('div');
    miningTooltip.className = 'mining-tooltip';
    miningTooltip.hidden = true;
    document.body.append(miningTooltip);
  }
  return miningTooltip;
}

function positionMiningTooltip(anchor) {
  const tip = ensureMiningTooltip();
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(tip.offsetWidth || 240, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = rect.bottom + 6;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function showMiningTooltip(anchor, title) {
  const tip = ensureMiningTooltip();
  miningTooltipAnchor = anchor;
  miningTooltipShownValue = title;
  tip.textContent = title;
  positionMiningTooltip(anchor);
  tip.hidden = false;
}

function hideMiningTooltip() {
  if (!miningTooltip) return;
  miningTooltip.hidden = true;
  miningTooltipAnchor = undefined;
  miningTooltipShownValue = undefined;
}

function bindMiningPill(pill) {
  pill.addEventListener('mouseenter', () => {
    const content = miningPillContent('mining', pill.dataset.fleetAddress);
    if (!content?.title) return;
    showMiningTooltip(pill, content.title);
  });
  pill.addEventListener('mouseleave', hideMiningTooltip);
  pill.addEventListener('blur', hideMiningTooltip);
}

function miningPillContent(state, fleetAddress) {
  if (state !== 'mining') return null;
  const assignment = (automationRuntime?.assignments ?? []).find((candidate) => candidate.fleetAddress === fleetAddress) ?? automationRuntime?.assignment;
  const stop = assignment?.targetStopAtUnixSeconds;
  const plan = lastCopperLoopPlan;
  if (!stop) return { label: 'mining', title: '' };
  const label = `Mining ${formatLocalHhmm(BigInt(stop))}`;
  // Linear estimate holds only when cargo is the limiting event; otherwise keep
  // the pill without a counter rather than show a wrong number.
  if (!plan || plan.fleet !== assignment?.fleetName || plan.limitingEvent !== 'cargo') return { label, title: '' };
  const current = estimateCurrentCopper({
    nowUnixSeconds: BigInt(Math.floor(Date.now() / 1_000)),
    targetStopAtUnixSeconds: BigInt(stop),
    targetMiningSeconds: BigInt(plan.targetMiningSeconds),
    expectedCopperRaw: BigInt(plan.expectedCopperRaw),
  });
  return { label, title: `Estimated ${plan.resource}: ${current}/${plan.expectedCopperRaw}` };
}

function applyMiningPills() {
  for (const pill of document.querySelectorAll('.state-pill[data-mining-pill]')) {
    const content = miningPillContent('mining', pill.dataset.fleetAddress);
    if (!content) continue;
    if (pill.textContent !== content.label) pill.textContent = content.label;
  }
  // While the tooltip is shown (mouse over a mining pill), refresh its live
  // estimate in place instead of touching the native OS tooltip, which on
  // Windows rebuilds on every title change and causes "Keine Rückmeldung".
  if (miningTooltipAnchor) {
    const content = miningPillContent('mining', miningTooltipAnchor.dataset.fleetAddress);
    if (!content?.title) {
      hideMiningTooltip();
    } else if (content.title !== miningTooltipShownValue) {
      miningTooltipShownValue = content.title;
      miningTooltip.textContent = content.title;
      positionMiningTooltip(miningTooltipAnchor);
    }
  }
}

async function boot() {
  const [bootstrap, loadedSettings, fleetSnapshot, automation] = await Promise.all([window.aepa.bootstrap(), window.aepa.getSettings(), window.aepa.getFleetSnapshot(), window.aepa.getAutomationState()]);
  settings = loadedSettings;
  $('version').textContent = `v${bootstrap.version}`;
  $('network').textContent = bootstrap.network.label;
  renderSignerStatus(bootstrap.signer);
  $('rpc-url').value = settings.rpcUrl;
  $('player-profile').value = settings.playerProfile;
  $('refresh-interval').value = String(settings.refreshIntervalSeconds);
  $('profile-status').textContent = settings.playerProfile ? short(settings.playerProfile) : 'Not configured';
  $('profile-status').title = settings.playerProfile;
  initializeColumnSelector();
  renderFleetSnapshot(fleetSnapshot);
  renderAutomationState(automation);
}

$('open-settings').onclick = () => showSettings(true);
$('show-status').onclick = () => setStatusOpen($('status-panel').hidden);
$('close-status').onclick = () => setStatusOpen(false);
$('show-fleets').onclick = () => setActivePage('fleets');
$('show-automation').onclick = () => setActivePage('automation');
$('add-fleet').onclick = () => {
  const drafts = writeAutomationDrafts();
  const used = new Set(drafts.map((draft) => draft.fleetAddress));
  const next = automationCatalog.fleets.find((fleet) => !used.has(fleet.address));
  if (next) renderAutomationRows([...drafts, { fleetAddress: next.address }]);
};
$('save-assignment').onclick = async () => {
  const button = $('save-assignment');
  button.disabled = true;
  try {
    const drafts = writeAutomationDrafts();
    const state = await window.aepa.saveAutomationAssignment(drafts);
    renderAutomationState(state);
    renderAutomationRows(savedDrafts());
  } catch (error) {
    $('automation-issues').hidden = false;
    const item = document.createElement('div');
    item.className = 'automation-issue';
    item.textContent = `Save blocked — ${error.message || String(error)}`;
    $('automation-issue-list').replaceChildren(item);
  } finally {
    updateAssignmentControls();
  }
};
$('cancel-assignment').onclick = restoreSavedAssignment;
$('close-settings').onclick = () => showSettings(false);
$('settings-overlay').onclick = (event) => { if (event.target === $('settings-overlay')) showSettings(false); };
$('store-signer').onclick = async () => {
  const button = $('store-signer');
  const input = $('c4-signer-secret');
  if (!settings.playerProfile || $('player-profile').value.trim() !== settings.playerProfile) {
    $('signer-settings-status').textContent = 'Save the C4 Player Profile before storing its signer';
    return;
  }
  if (!input.value.trim()) {
    $('signer-settings-status').textContent = 'Enter the 32- or 64-byte secret-key JSON';
    return;
  }
  const plaintext = input.value;
  input.value = '';
  button.disabled = true;
  $('signer-settings-status').textContent = 'Validating against the live C4 profile and encrypting…';
  try {
    renderSignerStatus(await window.aepa.saveSigner(plaintext, signerStatus?.configured === true));
  } catch (error) {
    $('signer-settings-status').textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
};
$('remove-signer').onclick = async () => {
  if (!window.confirm('Remove the DPAPI-encrypted C4 signer from AEPA? This does not affect the wallet itself.')) return;
  const button = $('remove-signer');
  button.disabled = true;
  try {
    renderSignerStatus(await window.aepa.removeSigner());
    renderAutomationState(await window.aepa.getAutomationState());
    $('c4-signer-secret').value = '';
  } catch (error) {
    $('signer-settings-status').textContent = error.message || String(error);
  } finally {
    button.disabled = !signerStatus?.configured;
  }
};
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  $('save-state').textContent = 'Saving…';
  try {
    settings = await window.aepa.saveSettings({ network: 'zink-ptr', rpcUrl: $('rpc-url').value, playerProfile: $('player-profile').value, refreshIntervalSeconds: Number($('refresh-interval').value) });
    $('profile-status').textContent = settings.playerProfile ? short(settings.playerProfile) : 'Not configured';
    $('profile-status').title = settings.playerProfile;
    $('character').textContent = 'Character —';
    renderSignerStatus((await window.aepa.bootstrap()).signer);
    $('save-state').textContent = 'Saved locally in SQLite';
    setTimeout(() => showSettings(false), 350);
  } catch (error) { $('save-state').textContent = error.message || String(error); }
};
$('clear-game-cache').onclick = async () => {
  if (!window.confirm('Clear all cached game data (fleets, catalog, saved assignment, activity)? Settings and the encrypted signer are kept. A DB backup is saved first in AEPA-rollbacks.')) return;
  const button = $('clear-game-cache');
  button.disabled = true;
  $('save-state').textContent = 'Backing up and clearing cached game data…';
  try {
    await window.aepa.clearGameCache();
    automationCatalog = undefined;
    automationRuntime = undefined;
    lastCopperLoopPlan = undefined;
    lastFleetSnapshot = undefined;
    lastFleetSnapshotKey = undefined;
    renderStatusPanel();
    renderFleetSnapshot(await window.aepa.getFleetSnapshot());
    renderAutomationState(await window.aepa.getAutomationState());
    $('save-state').textContent = 'Cached game data cleared — fresh start; AEPA re-syncs on its own.';
    setTimeout(() => showSettings(false), 1_200);
  } catch (error) {
    $('save-state').textContent = `Clear failed — ${error.message || String(error)}`;
  } finally {
    button.disabled = false;
  }
};

setInterval(async () => {
  try {
    const [fleetSnapshot, automation] = await Promise.all([window.aepa.getFleetSnapshot(), window.aepa.getAutomationState()]);
    renderFleetSnapshot(fleetSnapshot);
    renderAutomationState(automation);
    renderStatusPanel();
  } catch { /* The next explicit action or poll will surface IPC failures. */ }
}, 5_000);

// Realtime pill: local 1s linear estimate from the durable plan, zero RPC and
// zero IPC churn. The 60s fleet snapshot remains the authoritative correction.
setInterval(applyMiningPills, 1_000);

boot().catch((error) => { $('rpc-status').textContent = `Startup failed: ${error.message || error}`; });
