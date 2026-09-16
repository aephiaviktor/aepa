import { formatRegionCode, rankMiningDestinations } from '../dist/src/automation-options.js';
import { FLEET_COLUMNS, describeFleetShips, getFleetOwnership, normalizeVisibleColumns } from '../dist/src/fleet-view.js';
import { estimateCurrentCopper, formatLocalHhmm } from '../dist/src/copper-estimate.js';

const $ = (id) => document.getElementById(id);
const FLEET_COLUMNS_KEY = 'aepa.fleetColumns.v1';
const AUTOMATION_DRAFT_KEY = 'aepa.automationDraft.v1';
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
        const mining = column.id === 'state' ? miningPillContent(value) : null;
        pill.textContent = mining ? mining.label : value;
        if (mining) {
          pill.title = mining.title;
          pill.dataset.miningPill = 'true';
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
    $('rpc-status').textContent = 'Refresh failed; using last-good SQLite data';
    $('fleet-sync-status').textContent = `Cached snapshot · ${age} · refresh failed`;
    $('fleet-sync-status').title = sync.lastError || '';
  } else {
    $('rpc-status').textContent = 'Connecting automatically…';
    $('fleet-sync-status').textContent = snapshot.fleets.length ? `Cached snapshot · ${age} · refresh pending` : 'Waiting for first on-chain sync';
  }
  if (payload?.characterAddress) {
    $('character').textContent = `Character ${short(payload.characterAddress)}`;
    $('character').title = payload.characterAddress;
  }
  if (payload?.copperLoop) renderCopperLoop(payload.copperLoop);
  if (sync.status === 'ready' && !automationCatalog) void ensureAutomationCatalog().catch(() => undefined);
}

async function ensureAutomationCatalog(force = false) {
  if (automationCatalogLoad) return automationCatalogLoad;
  if (automationCatalog && !force) return automationCatalog;
  $('automation-empty').textContent = 'Loading faction systems and asteroid belts…';
  automationCatalogLoad = window.aepa.loadAutomationCatalog().then((catalog) => {
    renderAutomationCatalog(catalog);
    return catalog;
  }).catch((error) => {
    $('automation-empty').textContent = `Automation catalog blocked — ${error.message || String(error)}`;
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
    const mining = miningPillContent(fleet.state);
    pill.textContent = mining ? mining.label : fleet.state;
    if (mining) {
      pill.title = mining.title;
      pill.dataset.miningPill = 'true';
    }
    const info = document.createElement('span');
    info.className = 'status-info';
    const latest = automationRuntime?.activity?.[0];
    const age = snapshotAge(lastFleetSnapshot?.sync?.lastSucceededAt || fleet.updatedAt);
    // While mining, the "Mining remains active until …" waiting line is
    // redundant: the pill already shows the target stop time locally.
    const waitingLineHidden = mining !== null && latest?.kind === 'waiting' && /Mining remains active until/.test(latest.detail ?? '');
    info.textContent = waitingLineHidden
      ? `${fleet.state} · updated ${age} · ${new Date(fleet.updatedAt).toLocaleTimeString()}`
      : latest ? `${latest.kind.toUpperCase()} · ${latest.detail}` : `${fleet.state} · updated ${age} · ${new Date(fleet.updatedAt).toLocaleTimeString()}`;
    row.append(name, pill, info);
    host.append(row);
  }
}

function restoreSavedAssignment() {
  const saved = automationRuntime?.assignment;
  if (saved) {
    localStorage.setItem(AUTOMATION_DRAFT_KEY, JSON.stringify({
      fleetAddress: saved.fleetAddress,
      assignment: saved.assignment,
      homeSystemAddress: saved.homeSystemAddress,
      resourceId: saved.resourceId,
      destinationAddress: saved.destinationAddress,
      travelMode: saved.travelMode,
    }));
    if (automationCatalog) renderAutomationCatalog(automationCatalog);
    $('configuration-detail').textContent = 'Reverted to the previously saved assignments.';
  } else {
    localStorage.removeItem(AUTOMATION_DRAFT_KEY);
    if (automationCatalog) renderAutomationCatalog(automationCatalog);
    $('configuration-detail').textContent = 'No saved assignment to restore yet.';
  }
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

function formatDuration(seconds) {
  const value = Number(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function replaceSelectOptions(select, options, preferredValue) {
  select.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option');
    element.value = String(option.value);
    element.textContent = option.label;
    select.append(element);
  }
  if (preferredValue && options.some((option) => String(option.value) === String(preferredValue))) select.value = String(preferredValue);
}

function readAutomationDraft() {
  try { return JSON.parse(localStorage.getItem(AUTOMATION_DRAFT_KEY)) || {}; }
  catch { return {}; }
}

function renderAutomationState(state) {
  automationRuntime = state;
  const assignment = state?.assignment;
  const running = assignment?.enabled && assignment.status === 'running';
  $('automatic-status').textContent = assignment ? (running ? 'Running — LIVE sends enabled' : assignment.status) : 'Disabled — no saved assignment';
  $('automatic-detail').textContent = assignment?.lastError
    || (assignment ? `${assignment.fleetName} / ${assignment.homeSystemName} / ${assignment.destinationName} / ${assignment.resourceName}` : 'Save the proven MF-01 / Eternity / Ioki / Copper assignment before enabling.');
  const reconciliationRequired = assignment?.status === 'paused';
  $('clear-pause').hidden = state?.clearablePause !== true;
  $('pause-automation').disabled = !running;
  $('save-assignment').disabled = running || reconciliationRequired || !$('automation-destination').value;
  $('automation-mode').textContent = running ? 'LIVE — running' : assignment?.status === 'paused' ? 'Paused' : 'Disabled';
  const latest = state?.activity?.[0];
  // While mining, the redundant "Mining remains active until …" waiting line is
  // hidden: the State pill already shows the durable target stop time locally.
  const waitingLineHidden = running && latest?.kind === 'waiting' && /Mining remains active until/.test(latest.detail ?? '');
  $('automation-activity').textContent = waitingLineHidden
    ? 'Mining in progress — see the fleet State pill for the stop time and live Copper estimate.'
    : latest
      ? `${new Date(latest.occurredAt).toLocaleString()} · ${latest.kind.toUpperCase()}${latest.action ? ` · ${latest.action}` : ''}${latest.signature ? ` · ${short(latest.signature)}` : ''} · ${latest.detail}`
      : 'No automatic activity recorded.';
}

function selectedAutomationDraft() {
  return {
    fleetAddress: $('automation-fleet').value,
    assignment: $('automation-assignment').value,
    homeSystemAddress: $('automation-home').value,
    resourceId: Number($('automation-resource').value),
    destinationAddress: $('automation-destination').value,
    travelMode: $('automation-travel').value,
  };
}

function refreshMiningDestinations(preferredDestination, preferredTravelMode) {
  if (!automationCatalog) return;
  const home = automationCatalog.homeStarbases.find((candidate) => candidate.systemAddress === $('automation-home').value);
  const resourceId = Number($('automation-resource').value);
  if (!home || !Number.isSafeInteger(resourceId)) return;
  const destinations = rankMiningDestinations({ faction: automationCatalog.faction, resourceId, home: home.coordinates, destinations: automationCatalog.destinations });
  replaceSelectOptions($('automation-destination'), destinations.map((destination) => ({ value: destination.address, label: destination.label })), preferredDestination);
  const selected = destinations.find((destination) => destination.address === $('automation-destination').value);
  const travel = $('automation-travel');
  const autoOption = travel.options[0];
  if (selected?.distance === 0) {
    autoOption.textContent = 'Not required (same system)';
    travel.value = 'auto';
    travel.disabled = true;
  } else {
    autoOption.textContent = 'Auto';
    travel.disabled = false;
    if (preferredTravelMode && [...travel.options].some((option) => option.value === preferredTravelMode)) travel.value = preferredTravelMode;
  }
  const fleet = automationCatalog.fleets.find((candidate) => candidate.address === $('automation-fleet').value);
  const resource = automationCatalog.resources.find((candidate) => candidate.id === resourceId);
  $('configuration-route').textContent = selected && fleet && resource
    ? `${fleet.name} · ${resource.name} · ${selected.label}`
    : 'No eligible asteroid belt for this configuration';
  $('configuration-detail').textContent = selected?.distance === 0
    ? 'Same-system assignment; travel is not required. Save enables live execution immediately.'
    : 'Travel route is shown for configuration only; automatic execution is not yet supported for this route.';
  $('save-assignment').disabled = !selected || automationRuntime?.assignment?.enabled === true || automationRuntime?.assignment?.status === 'paused';
}

function renderAutomationCatalog(catalog) {
  automationCatalog = catalog;
  const draft = automationRuntime?.assignment || readAutomationDraft();
  replaceSelectOptions($('automation-fleet'), catalog.fleets.map((fleet) => ({ value: fleet.address, label: `${fleet.name} | ${fleet.state}` })), draft.fleetAddress || catalog.fleets.find((fleet) => fleet.name === 'MF-01')?.address);
  replaceSelectOptions($('automation-home'), catalog.homeStarbases.map((home) => ({ value: home.systemAddress, label: `${formatRegionCode(home.regionOwner, home.regionId)} | ${home.systemName}` })), draft.homeSystemAddress);
  replaceSelectOptions($('automation-resource'), catalog.resources.map((resource) => ({ value: resource.id, label: resource.name })), draft.resourceId || catalog.resources.find((resource) => resource.name === 'Copper Ore')?.id);
  $('automation-empty').hidden = true;
  $('automation-config').hidden = false;
  refreshMiningDestinations(draft.destinationAddress, draft.travelMode);
}

function miningPillContent(state) {
  if (state !== 'mining') return null;
  const stop = automationRuntime?.assignment?.targetStopAtUnixSeconds;
  const plan = lastCopperLoopPlan;
  if (!stop) return { label: 'mining', title: '' };
  const label = `Mining ${formatLocalHhmm(BigInt(stop))}`;
  // Linear estimate holds only when cargo is the limiting event; otherwise keep
  // the pill without a counter rather than show a wrong number.
  if (!plan || plan.limitingEvent !== 'cargo') return { label, title: '' };
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
    const content = miningPillContent('mining');
    if (!content) continue;
    pill.textContent = content.label;
    pill.title = content.title;
  }
}

function renderCopperLoop(plan) {
  lastCopperLoopPlan = plan;
  $('route-empty').hidden = true;
  $('route-preview').hidden = false;
  $('route-path').textContent = `${plan.homeSystem} → ${plan.asteroid} → ${plan.homeSystem}`;
  $('route-note').textContent = plan.sameSystem ? 'Ioki is inside the Eternity system; no inter-system travel is required.' : 'Movement required.';
  $('food-cargo').textContent = `${plan.foodForCargoRaw} Food`;
  $('food-ammo').textContent = `${plan.foodForAmmoRaw} Food`;
  $('food-load').textContent = `${plan.foodToLoadRaw} Food`;
  $('limit-reason').textContent = plan.limitingEvent === 'simultaneous' ? 'Cargo and Ammo finish together' : `${plan.limitingEvent === 'cargo' ? 'Cargo capacity' : 'Ammo bank'} happens first`;
  $('expected-copper').textContent = `${plan.expectedCopperRaw} Copper Ore`;
  $('mining-duration').textContent = formatDuration(plan.targetMiningSeconds);
  $('bank-targets').textContent = `${plan.ammoBankTargetRaw} Ammo / ${plan.fuelTankTargetRaw} Fuel`;
  $('rounding-note').textContent = plan.unavoidableFoodRoundingRaw === '0'
    ? 'Food reaches exactly zero at the limiting event. No reserve is added.'
    : `No reserve is added. Exact integer execution leaves ${plan.unavoidableFoodRoundingRaw} unavoidable raw Food unit of rounding.`;
}

async function simulateNextStep() {
  const button = $('simulate-next');
  button.disabled = true;
  button.textContent = 'Signing & simulating…';
  $('simulation-result').textContent = 'Building from fresh C4 state, signing locally, and verifying the signature in simulation…';
  try {
    const result = await window.aepa.simulateNextCopperStep();
    $('simulation-result').textContent = `PASS — signature verified; ${result.summary} (${result.unitsConsumed} compute units; nothing submitted)`;
    $('simulation-logs').hidden = false;
    $('simulation-logs').textContent = [
      'SIGNED SIMULATION — NOTHING SUBMITTED',
      `Action: ${result.nextStep}`,
      `Authority: ${result.authority} (profile key index ${result.keyIndex})`,
      `Transaction signature: ${result.transactionSignature}`,
      `Simulation slot: ${result.simulationSlot}`,
      `Compute units: ${result.unitsConsumed}`,
      '',
      'Exact plan:',
      JSON.stringify(result.plan, null, 2),
      '',
      'Program logs:',
      ...result.logs,
    ].join('\n');
  } catch (error) {
    $('simulation-result').textContent = `BLOCKED — ${error.message || String(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Run signed simulation';
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
$('simulate-next').onclick = simulateNextStep;
for (const id of ['automation-fleet', 'automation-home', 'automation-resource', 'automation-destination', 'automation-travel']) {
  $(id).addEventListener('change', () => refreshMiningDestinations($('automation-destination').value, $('automation-travel').value));
}
$('save-assignment').onclick = async () => {
  const button = $('save-assignment');
  button.disabled = true;
  $('configuration-detail').textContent = 'Validating the assignment against fresh C4 data…';
  try {
    const draft = selectedAutomationDraft();
    localStorage.setItem(AUTOMATION_DRAFT_KEY, JSON.stringify(draft));
    const state = await window.aepa.saveAutomationAssignment(draft);
    renderAutomationState(state);
    $('configuration-detail').textContent = state?.assignment?.enabled
      ? 'Assignment saved — live execution enabled automatically. No simulation before sends.'
      : 'Assignment saved, but live execution could not be enabled (see status).';
  } catch (error) {
    $('configuration-detail').textContent = `BLOCKED — ${error.message || String(error)}`;
  } finally {
    button.disabled = automationRuntime?.assignment?.enabled === true || automationRuntime?.assignment?.status === 'paused';
  }
};
$('cancel-assignment').onclick = restoreSavedAssignment;
$('clear-pause').onclick = async () => {
  if (!window.confirm('Clear this spurious pause? It happened while planning a refill, so nothing was submitted. The assignment will return to disabled so you can Save (which re-enables it).')) return;
  $('automatic-detail').textContent = 'Clearing the spurious pause…';
  try { renderAutomationState(await window.aepa.clearAutomationPause()); }
  catch (error) { $('automatic-detail').textContent = `BLOCKED — ${error.message || String(error)}`; }
};
$('pause-automation').onclick = async () => {
  if (!window.confirm('Pause Automation? A transaction already submitted to C4 cannot be cancelled, but no following transaction will start.')) return;
  try { renderAutomationState(await window.aepa.setAutomationEnabled(false)); }
  catch (error) { $('automatic-detail').textContent = `BLOCKED — ${error.message || String(error)}`; }
};
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
$('connect').onclick = async () => {
  const button = $('connect');
  button.disabled = true; button.textContent = 'Refreshing…'; $('rpc-status').textContent = 'Reading C4 accounts…';
  try {
    await window.aepa.connect();
    renderFleetSnapshot(await window.aepa.getFleetSnapshot());
    await ensureAutomationCatalog(true);
  } catch (error) { $('rpc-status').textContent = error.message || String(error); }
  finally { button.disabled = false; button.textContent = 'Refresh now'; }
};

setInterval(async () => {
  try {
    const [fleetSnapshot, automation] = await Promise.all([window.aepa.getFleetSnapshot(), window.aepa.getAutomationState()]);
    renderFleetSnapshot(fleetSnapshot);
    renderAutomationState(automation);
    renderStatusPanel();
  } catch { /* Manual refresh or the next explicit action will surface IPC failures. */ }
}, 5_000);

// Realtime pill: local 1s linear estimate from the durable plan, zero RPC and
// zero IPC churn. The 60s fleet snapshot remains the authoritative correction.
setInterval(applyMiningPills, 1_000);

boot().catch((error) => { $('rpc-status').textContent = `Startup failed: ${error.message || error}`; });
