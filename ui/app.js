import { formatHomeStarbaseOption, isRoundTripReachable, rankMiningDestinations } from '../dist/src/automation-options.js';
import { automationDraftsEqual, formatMiningProgress } from '../dist/src/automation-ui.js';
import { FLEET_COLUMNS, describeFleetShips, getFleetOwnership, normalizeVisibleColumns } from '../dist/src/fleet-view.js';
import { formatLocalHhmm } from '../dist/src/copper-estimate.js';

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
let miningLoopPlans = new Map();
let pendingStopFleet;

function short(value) {
  return value ? `${value.slice(0, 7)}…${value.slice(-5)}` : '—';
}

function renderAtlasKitStatus(status) {
  $('atlas-kit-version').textContent = `Bundled version: ${status?.bundled || 'unknown'}`;
  const element = $('atlas-kit-status');
  if (status?.current === true) {
    element.textContent = `Current npm next release (${status.latest})`;
    element.className = 'form-state success';
  } else if (status?.current === false) {
    element.textContent = `Update available: ${status.latest}. Build, test, and deploy a new AEPA release.`;
    element.className = 'form-state warning';
  } else {
    element.textContent = `Latest version could not be checked${status?.error ? `: ${status.error}` : ''}`;
    element.className = 'form-state warning';
  }
}

async function copyAddress(button, value) {
  if (!value) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = original; }, 1_200);
}

function renderFleetAddress(cell, value) {
  const line = document.createElement('div');
  line.className = 'address-line';
  const text = document.createElement('span');
  text.className = 'copyable-address';
  text.textContent = value;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-address';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', `Copy fleet address ${value}`);
  copy.onclick = (event) => { event.stopPropagation(); void copyAddress(copy, value); };
  line.append(text, copy);
  cell.className = 'address';
  cell.append(line);
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
      } else if (column.id === 'address') {
        renderFleetAddress(cell, value);
      } else {
        cell.textContent = value;
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
  const plans = payload?.copperLoops ?? (payload?.copperLoop ? [payload.copperLoop] : []);
  if (plans.length) miningLoopPlans = new Map(plans.map((plan) => [plan.fleetAddress, plan]));
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
  return assignments.map((record) => {
    const value = record.pendingAssignment || record;
    const { fleetAddress, assignment, homeSystemAddress, resourceId, resourceIds, destinationAddress, travelMode } = value;
    return { fleetAddress, assignment, homeSystemAddress, resourceId, resourceIds: resourceIds ?? [resourceId], destinationAddress, travelMode };
  });
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

let activePage = 'fleets';
let pendingNavigation;

function hasUnsavedAutomationChanges() {
  const rows = [...document.querySelectorAll('.automation-fleet-row')];
  return rows.length > 0 && !automationDraftsEqual(rows.map(readAutomationRow), savedDrafts());
}

function requestNavigation(navigate) {
  if (activePage === 'automation' && hasUnsavedAutomationChanges()) {
    pendingNavigation = navigate;
    $('save-and-leave').disabled = $('save-assignment').disabled;
    $('unsaved-dialog').showModal();
    return;
  }
  navigate();
}

function setActivePage(page) {
  activePage = page;
  const automation = page === 'automation';
  const fleets = page === 'fleets';
  const activity = page === 'activity';
  $('fleets-page').hidden = !fleets;
  $('automation-page').hidden = !automation;
  $('activity-page').hidden = !activity;
  $('fleet-column-picker').hidden = !fleets;
  for (const [name, control] of [['fleets', $('show-fleets')], ['automation', $('show-automation')], ['activity', $('show-activity')]]) {
    control.classList.toggle('active', page === name);
    control.toggleAttribute('aria-current', page === name);
  }
  $('page-title').textContent = automation ? 'Automation' : activity ? 'Activity' : 'Fleet Control';
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
    if (option.title) element.title = option.title;
    element.disabled = !!option.disabled;
    select.append(element);
  }
  if (preferredValue != null && options.some((option) => String(option.value) === String(preferredValue))) select.value = String(preferredValue);
}

function readAutomationRow(row) {
  return {
    fleetAddress: row.querySelector('[data-field="fleet"]').value,
    assignment: row.querySelector('[data-field="assignment"]').value,
    homeSystemAddress: row.querySelector('[data-field="home"]').value,
    resourceIds: [...row.querySelectorAll('[data-resource-id]:checked')].map(input => Number(input.dataset.resourceId)).sort((a, b) => a - b),
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

function renderResourcePicker(row, destination, selectedIds = []) {
  const picker = row.querySelector('.resource-picker');
  const available = automationCatalog.resources.filter(resource => destination?.resourceIds.includes(resource.id));
  const selected = selectedIds.filter(id => available.some(resource => resource.id === id));
  const removed = selectedIds.length - selected.length;
  const host = picker.querySelector('.resource-options');
  host.replaceChildren();
  for (const resource of available) {
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox">';
    const input = label.querySelector('input');
    input.dataset.resourceId = String(resource.id);
    input.dataset.available = String(resource.available);
    input.checked = selected.includes(resource.id);
    label.classList.toggle('locked', !resource.available);
    if (!resource.available) {
      label.title = resource.requirement || 'Required research is not unlocked.';
      label.setAttribute('aria-disabled', 'true');
      input.disabled = !input.checked;
    }
    label.append(document.createTextNode(resource.name));
    input.addEventListener('change', () => {
      if (!resource.available && input.checked) input.checked = false;
      updateResourceCounter(row);
      writeAutomationDrafts();
      updateAssignmentControls();
    });
    host.append(label);
  }
  if (removed) {
    const notice = document.createElement('p');
    notice.textContent = `${removed} unavailable resource selection(s) removed. Review before saving.`;
    notice.setAttribute('role', 'status');
    host.prepend(notice);
  }
  updateResourceCounter(row);
}

function updateResourceCounter(row) {
  const picker = row.querySelector('.resource-picker');
  const count = picker.querySelectorAll('input:checked').length;
  picker.querySelector('summary').textContent = `Resources · ${count}/8`;
  for (const input of picker.querySelectorAll('input')) {
    const locked = input.dataset.available === 'false';
    input.disabled = locked ? !input.checked : !input.checked && count >= 8;
  }
}

function refreshAutomationRow(row, preferredDestination, preferredTravelMode) {
  const draft = readAutomationRow(row);
  const home = automationCatalog.homeStarbases.find((candidate) => candidate.systemAddress === draft.homeSystemAddress);
  const travel = row.querySelector('[data-field="travel"]');
  if (preferredTravelMode && [...travel.options].some((option) => option.value === preferredTravelMode)) travel.value = preferredTravelMode;
  const allDestinations = home
    ? rankMiningDestinations({ faction: automationCatalog.faction, home: home.coordinates, destinations: automationCatalog.destinations })
    : [];
  const selectedFleet = automationCatalog.fleets.find((candidate) => candidate.address === draft.fleetAddress);
  const destinations = travel.value === 'auto' || travel.value === 'same-system'
    ? allDestinations.filter((value) => value.systemAddress === home.systemAddress)
    : selectedFleet
      ? allDestinations.filter((value) => value.systemAddress !== home.systemAddress && isRoundTripReachable(travel.value, value.distance, selectedFleet.travel))
      : [];
  const destination = row.querySelector('[data-field="destination"]');
  replaceSelectOptions(destination, destinations.map((value) => ({ value: value.address, label: value.label })), preferredDestination);
  const selected = destinations.find((value) => value.address === destination.value);
  renderResourcePicker(row, selected, row.initialResourceIds ?? draft.resourceIds);
  delete row.initialResourceIds;
  travel.classList.toggle('same-system', travel.value === 'auto' || travel.value === 'same-system');
  writeAutomationDrafts();
  updateAssignmentControls();
}

function createAutomationRow(draft = {}) {
  const row = document.createElement('div');
  row.className = 'automation-fleet-row';
  row.innerHTML = `<div class="field-grid compact-field-grid">
    <select data-field="fleet" aria-label="Fleet"></select>
    <select data-field="assignment" aria-label="Assignment"><option value="mining">Mining</option></select>
    <select data-field="home" aria-label="Home Starbase"></select>
    <select data-field="travel" aria-label="Travel"><option value="auto">Same system</option><option value="subwarp">Subwarp</option><option value="warp">Warp</option><option value="warp-lane">Warp lane</option></select>
    <select class="destination-field" data-field="destination" aria-label="Mining Destination"></select>
    <details data-field="resource" class="resource-picker" aria-label="Resources"><summary>Resources · 0/8</summary><div class="resource-options"></div></details>
    <div class="row-actions"><button class="stop-fleet secondary" type="button">Stop</button><button class="remove-fleet icon" type="button" aria-label="Remove fleet assignment">×</button></div>
  </div>`;
  const fleet = row.querySelector('[data-field="fleet"]');
  replaceSelectOptions(fleet, availableFleetOptions(row, draft.fleetAddress), draft.fleetAddress);
  const selectedFleet = automationCatalog.fleets.find((candidate) => candidate.address === fleet.value);
  replaceSelectOptions(row.querySelector('[data-field="home"]'), selectedFleet
    ? automationCatalog.homeStarbases.map((home) => ({ value: home.systemAddress, ...formatHomeStarbaseOption(home, selectedFleet.location) }))
    : [], draft.homeSystemAddress);
  row.initialResourceIds = draft.resourceIds ?? (draft.resourceId == null ? [] : [draft.resourceId]);
  row.querySelector('[data-field="assignment"]').value = draft.assignment || 'mining';
  for (const select of row.querySelectorAll('select')) select.addEventListener('change', () => {
    if (select.dataset.field === 'fleet') renderAutomationRows(writeAutomationDrafts());
    else refreshAutomationRow(row, row.querySelector('[data-field="destination"]').value, row.querySelector('[data-field="travel"]').value);
  });
  row.querySelector('.remove-fleet').onclick = () => {
    row.remove();
    renderAutomationRows(writeAutomationDrafts());
  };
  row.querySelector('.stop-fleet').onclick = () => {
    const persisted = (automationRuntime?.assignments ?? []).find((assignment) => assignment.fleetAddress === fleet.value);
    if (!persisted?.enabled || persisted.status !== 'running' || persisted.stopMode) return;
    pendingStopFleet = { address: persisted.fleetAddress, name: persisted.fleetName };
    $('stop-title').textContent = `Stop ${persisted.fleetName} Automation?`;
    $('stop-message').textContent = 'Choose when mining should stop. AEPA will then return the fleet home, unload, refill, and disable its assignment.';
    $('stop-unsaved-warning').hidden = !hasUnsavedAutomationChanges();
    $('stop-dialog').showModal();
  };
  refreshAutomationRow(row, draft.destinationAddress, draft.travelMode);
  const persisted = (automationRuntime?.assignments ?? []).find((assignment) => assignment.fleetAddress === fleet.value);
  if (persisted?.pendingAssignment) row.classList.add('pending');
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
  syncPendingRowIndicators();
  updateAssignmentControls();
}

function renderActivityEntries(host, entries) {
  host.replaceChildren(...entries.map((entry) => {
    const item = document.createElement('div');
    const isError = entry.kind === 'paused' || entry.kind === 'disabled' || /blocked|error|failed/i.test(entry.detail);
    item.className = `automation-issue${isError ? ' error' : ''}`;
    const name = document.createElement('strong');
    name.textContent = entry.fleetName || 'System';
    const detail = document.createElement('span');
    const time = entry.occurredAt ? new Date(entry.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    detail.textContent = `${time} · ${entry.action || entry.kind} · ${entry.detail}`;
    item.append(name, detail);
    return item;
  }));
}

function renderAutomationIssues(state) {
  const assignments = state?.assignments ?? (state?.assignment ? [state.assignment] : []);
  const errors = assignments.filter((assignment) => assignment.status === 'paused' || assignment.lastError);
  let capture = document.getElementById('raw-capture-health');
  if (!capture) {
    capture = document.createElement('p');
    capture.id = 'raw-capture-health';
    $('activity-page-list').before(capture);
  }
  const health = state?.captureHealth;
  capture.textContent = health
    ? `Raw transaction capture: ${health.status}. Last stored response: ${health.lastResponseAt ?? 'none this session'}.`
    : 'Raw transaction capture: status unavailable.';
  const archive = state?.archiveHealth;
  capture.textContent += archive
    ? ` Pending evidence: ${archive.pending}; oldest: ${archive.oldestPendingAt ?? 'none'}; unresolved operations: ${archive.unresolvedOperations}. Archive: ${((archive.databaseBytes + archive.walBytes) / 1048576).toFixed(1)} MiB. Free disk: ${archive.freeDiskBytes === null ? 'unknown' : (archive.freeDiskBytes / 1073741824).toFixed(1) + ' GiB'}.`
    : ' Archive statistics unavailable.';
  if (archive?.freeDiskBytes !== null && archive?.freeDiskBytes < 1073741824) {
    capture.textContent += ' WARNING: less than 1 GiB disk space remains; capture may fail. No history is automatically deleted.';
  }
  let recovery = document.getElementById('raw-recovery-operations');
  if (!recovery) {
    recovery = document.createElement('div');
    recovery.id = 'raw-recovery-operations';
    capture.after(recovery);
  }
  recovery.replaceChildren();
  for (const operation of state?.recoveryOperations ?? []) {
    const entry = document.createElement('p');
    entry.textContent = `Unresolved ${operation.scope}: ${operation.signature} — archived evidence: ${operation.evidence}. Still blocked; evidence alone does not authorize retry.`;
    if (operation.evidence === 'finalized-success' || operation.evidence === 'finalized-failure') {
      const recoveryFleet = assignments.find((assignment) => operation.scope === `fleet:${assignment.fleetAddress}`);
      const resumesStop = !!recoveryFleet?.stopMode;
      const button = document.createElement('button');
      button.textContent = 'Check state and clear block';
      button.onclick = async () => {
        const consequence = resumesStop
          ? 'The already-requested safe shutdown will resume after reconciliation.'
          : 'Automation will stay disabled. Enable it separately after reviewing the result.';
        if (!window.confirm(`Check this paused fleet against current chain state and clear its transaction block? ${consequence}`)) return;
        button.disabled = true;
        try { await window.aepa.recoverOperation(operation.id); button.textContent = resumesStop ? 'Reconciled — safe stop resumed' : 'Reconciled — automation disabled'; }
        catch (error) { window.alert(String(error.message ?? error)); button.disabled = false; }
      };
      entry.append(button);
    }
    recovery.append(entry);
  }
  const activity = state?.activity ?? [];
  $('fleet-log-summary').textContent = errors.length ? `${errors.length} fleet issue${errors.length === 1 ? '' : 's'}` : 'No current issues';
  const entries = activity.length ? activity : [{ occurredAt: '', kind: 'waiting', detail: 'No Automation activity recorded yet' }];
  renderActivityEntries($('automation-issue-list'), entries);
  renderActivityEntries($('activity-page-list'), entries);
}

function syncPendingRowIndicators() {
  const assignments = automationRuntime?.assignments ?? [];
  for (const row of document.querySelectorAll('.automation-fleet-row')) {
    const fleetAddress = row.querySelector('[data-field="fleet"]').value;
    const persisted = assignments.find((assignment) => assignment.fleetAddress === fleetAddress);
    row.classList.toggle('pending', !!persisted?.pendingAssignment);
    row.classList.toggle('stopping', !!persisted?.stopMode);
    const stopping = !!persisted?.stopMode;
    for (const select of row.querySelectorAll('select')) select.disabled = stopping;
    updateResourceCounter(row);
    if (stopping) for (const input of row.querySelectorAll('input')) input.disabled = true;
    const stop = row.querySelector('.stop-fleet');
    stop.hidden = !persisted?.enabled && !stopping;
    stop.disabled = stopping || persisted?.status === 'paused';
    stop.textContent = persisted?.stopMode === 'now'
      ? 'Stopping…'
      : persisted?.stopMode === 'end-of-cycle'
        ? 'Stopping after cycle'
        : 'Stop';
    stop.title = persisted?.stopMode === 'end-of-cycle' ? 'Stopping after current cycle' : persisted?.stopMode === 'now' ? 'Stopping now' : '';
    const remove = row.querySelector('.remove-fleet');
    remove.disabled = !!persisted && (persisted.enabled || persisted.status === 'paused' || stopping);
    remove.title = remove.disabled ? 'Stop this fleet safely before removing its assignment.' : '';
  }
}

function updateAssignmentControls() {
  const assignments = automationRuntime?.assignments ?? [];
  const rows = [...document.querySelectorAll('.automation-fleet-row')];
  const drafts = rows.map(readAutomationRow);
  const canSave = rows.length > 0 && rows.every((row) => {
    const checked = [...row.querySelectorAll('[data-resource-id]:checked')];
    return row.querySelector('[data-field="destination"]').value && checked.length > 0 && checked.every(input => input.dataset.available !== 'false');
  });
  const dirty = !automationDraftsEqual(drafts, savedDrafts());
  const save = $('save-assignment');
  save.classList.toggle('dirty', canSave && dirty);
  save.disabled = !canSave || !dirty;
  $('save-and-leave').disabled = save.disabled;
  $('automation-mode').textContent = assignments.some((assignment) => assignment.enabled) ? `LIVE — ${assignments.filter((assignment) => assignment.enabled).length} running` : assignments.some((assignment) => assignment.status === 'paused') ? 'Attention required' : 'Disabled';
}

function renderAutomationState(state) {
  automationRuntime = state;
  renderAutomationIssues(state);
  syncPendingRowIndicators();
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
  const plan = miningLoopPlans.get(fleetAddress);
  if (!stop) return { label: 'mining', title: '' };
  const label = `Mining ${formatLocalHhmm(BigInt(stop))}`;
  if (!plan || plan.fleet !== assignment?.fleetName || !plan.expectedResources?.length) return { label, title: '' };
  const title = formatMiningProgress({
    targetStopAtUnixSeconds: BigInt(stop),
    targetMiningSeconds: BigInt(plan.targetMiningSeconds),
    expectedResources: plan.expectedResources.map((resource) => ({ name: resource.name, expectedRaw: BigInt(resource.expectedRaw) })),
  }, BigInt(Math.floor(Date.now() / 1_000)));
  return { label, title };
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
  renderAtlasKitStatus(bootstrap.atlasKit);
  renderSignerStatus(bootstrap.signer);
  $('rpc-url').value = settings.rpcUrl;
  $('player-profile').value = settings.playerProfile;
  $('refresh-interval').value = String(settings.refreshIntervalSeconds);
  $('profile-status').textContent = settings.playerProfile || 'Not configured';
  $('profile-status').title = settings.playerProfile;
  $('copy-profile-address').disabled = !settings.playerProfile;
  initializeColumnSelector();
  renderFleetSnapshot(fleetSnapshot);
  renderAutomationState(automation);
}

$('open-settings').onclick = () => requestNavigation(() => showSettings(true));
$('show-status').onclick = () => setStatusOpen($('status-panel').hidden);
$('close-status').onclick = () => setStatusOpen(false);
$('show-fleets').onclick = () => requestNavigation(() => setActivePage('fleets'));
$('show-automation').onclick = () => setActivePage('automation');
$('show-activity').onclick = () => requestNavigation(() => setActivePage('activity'));
$('copy-profile-address').onclick = () => void copyAddress($('copy-profile-address'), settings?.playerProfile);
$('add-fleet').onclick = () => {
  const drafts = writeAutomationDrafts();
  const used = new Set(drafts.map((draft) => draft.fleetAddress));
  const next = automationCatalog.fleets.find((fleet) => !used.has(fleet.address));
  if (next) renderAutomationRows([...drafts, { fleetAddress: next.address }]);
};
async function saveAutomationChanges() {
  const button = $('save-assignment');
  button.disabled = true;
  try {
    const drafts = writeAutomationDrafts();
    const state = await window.aepa.saveAutomationAssignment(drafts);
    renderAutomationState(state);
    renderAutomationRows(savedDrafts());
    return true;
  } catch (error) {
    try { renderAutomationState(await window.aepa.getAutomationState()); } catch {}
    const item = document.createElement('div');
    item.className = 'automation-issue error';
    item.textContent = `Save blocked — ${error.message || String(error)}`;
    $('automation-issue-list').prepend(item);
    return false;
  } finally {
    updateAssignmentControls();
  }
}

async function requestFleetStop(mode) {
  if (!pendingStopFleet) return;
  const buttons = [$('stop-now'), $('stop-end-cycle'), $('cancel-stop')];
  for (const button of buttons) button.disabled = true;
  try {
    const state = await window.aepa.requestAutomationStop(pendingStopFleet.address, mode);
    pendingStopFleet = undefined;
    $('stop-dialog').close();
    renderAutomationState(state);
    renderAutomationRows(savedDrafts());
  } catch (error) {
    $('stop-message').textContent = `Stop blocked — ${error.message || String(error)}`;
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

$('save-assignment').onclick = () => void saveAutomationChanges();
$('cancel-assignment').onclick = restoreSavedAssignment;
$('cancel-stop').onclick = () => { pendingStopFleet = undefined; $('stop-dialog').close(); };
$('stop-now').onclick = () => void requestFleetStop('now');
$('stop-end-cycle').onclick = () => void requestFleetStop('end-of-cycle');
$('keep-editing').onclick = () => { pendingNavigation = undefined; $('unsaved-dialog').close(); };
$('discard-and-leave').onclick = () => {
  const navigate = pendingNavigation;
  pendingNavigation = undefined;
  restoreSavedAssignment();
  $('unsaved-dialog').close();
  navigate?.();
};
$('save-and-leave').onclick = async () => {
  const navigate = pendingNavigation;
  if (!await saveAutomationChanges()) return;
  pendingNavigation = undefined;
  $('unsaved-dialog').close();
  navigate?.();
};
window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedAutomationChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});
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
    $('profile-status').textContent = settings.playerProfile || 'Not configured';
    $('profile-status').title = settings.playerProfile;
    $('copy-profile-address').disabled = !settings.playerProfile;
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
    miningLoopPlans = new Map();
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
