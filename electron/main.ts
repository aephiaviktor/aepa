import { shouldEnableSavedAssignment } from '../src/automation-stop.js';
import { recoverPausedOperation } from '../src/operator-recovery.js';
import { RawStoreWorker } from '../src/raw-store-worker.js';
import { RawCaptureRuntime, configureRawCapture } from '../src/raw-capture-runtime.js';
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMiningAutomationCatalog } from '../src/automation-catalog.js';
import { assertAutomationCanEnable, isCrossSystemTravelMode, validateSupportedAutomationAssignment } from '../src/automation-assignment.js';
import { AutomaticCopperRunner, nextAutomationTickDelayMs, shouldAutoRetryPaused } from '../src/automation-runner.js';
import { executeNextCopperStepOnce } from '../src/automatic-c4.js';
import { getActiveC4ProfileAuthority, inspectNextCopperStep, loadC4Fleets, simulateNextCopperStepSigned, type MiningLoopScope } from '../src/c4.js';
import { AepaDatabase } from '../src/database.js';
import { FleetSyncCoordinator } from '../src/fleet-sync.js';
import { CatalogSyncCoordinator } from '../src/catalog-sync.js';
import { isPostSubmissionFailure } from '../src/automatic-c4.js';
import { C4_NETWORK } from '../src/network.js';
import { authorizeSignerStatus, getSignerStatus, removeStoredSigner, storeAuthorizedSigner, withStoredSigner, type SignerStatus } from '../src/signer-store.js';

// Proven Electron-on-Windows configuration used by GM/LM Market Bots: software
// rendering plus no renderer backgrounding. AEPA's Intel UHD iGPU stalls on
// first interaction (lazy shader compile + occluded-window throttling), which
// shows up as multi-second "Keine Rückmeldung" freezes — these switches match
// the stack that already works for the other bots. Must run before app ready.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const here = path.dirname(fileURLToPath(import.meta.url));
let database: AepaDatabase;
let rawStore: RawStoreWorker;
let rawCapture: RawCaptureRuntime;
let automationRunner: AutomaticCopperRunner;
let automationTimer: NodeJS.Timeout | undefined;
let fleetSync: FleetSyncCoordinator<Awaited<ReturnType<typeof loadC4Fleets>>>;
let catalogSync: CatalogSyncCoordinator;
let signerPath: string;

async function automationState() {
  const settings = database.getSettings();
  const archiveHealth = await rawStore.health(settings.network, settings.playerProfile).catch(() => null);
  const assignments = database.listAutomationAssignments();
  return {
    recoveryOperations: await rawStore.inspectRecovery(settings.network, settings.playerProfile).catch(() => null),
    archiveHealth,
    captureHealth: rawCapture?.health(),
    assignments: assignments.map((assignment) => ({
      ...assignment,
      targetStopAtUnixSeconds: assignment.targetStopAtUnixSeconds?.toString(),
    })),
    assignment: assignments[0] ? { ...assignments[0], targetStopAtUnixSeconds: assignments[0].targetStopAtUnixSeconds?.toString() } : undefined,
    clearablePause: assignments.some((assignment) => assignment.status === 'paused' && !isPostSubmissionFailure(assignment.lastError ?? '')),
    activity: database.listAutomationActivity(25),
  };
}

// Plan-stage (spurious) pauses retry on their own: the operator no longer has
// to clear them. Post-submission pauses always stay paused for out-of-band
// chain-state reconciliation, never auto-retried.
let lastAutoReconnectAt = 0;
const AUTO_RECONNECT_INTERVAL_MS = 60_000;

function scheduleAutomationTick(delayMs = 0): void {
  if (automationTimer) clearTimeout(automationTimer);
  automationTimer = setTimeout(async () => {
    const assignments = database.listAutomationAssignments();
    const now = Date.now();
    if (now - lastAutoReconnectAt >= AUTO_RECONNECT_INTERVAL_MS) {
      lastAutoReconnectAt = now;
      for (const assignment of assignments.filter(shouldAutoRetryPaused)) {
        database.setAutomationEnabled(true, assignment.fleetAddress);
        database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'enabled', detail: 'Automatic reconnect after a plan-stage pause (nothing was submitted)' });
      }
    }
    const result = await automationRunner.tick();
    // SLYA-style snappiness: as soon as one action confirms, chain the next
    // step almost immediately instead of waiting the full refresh interval.
    const refreshSeconds = database.getSettings().refreshIntervalSeconds;
    const normalDelay = nextAutomationTickDelayMs(result.kind, refreshSeconds);
    const activeCount = database.listAutomationAssignments().filter((assignment) => assignment.enabled && assignment.status === 'running').length;
    const fairShareDelay = activeCount > 1 ? Math.max(2_500, Math.floor(refreshSeconds * 1_000 / activeCount)) : normalDelay;
    scheduleAutomationTick(Math.min(normalDelay, fairShareDelay));
  }, delayMs);
}

async function getAuthorizedSignerStatus(signerPath: string): Promise<SignerStatus> {
  let signer = getSignerStatus(signerPath, safeStorage);
  if (!signer.configured || signer.error) return signer;
  try {
    signer = authorizeSignerStatus(signer, await getActiveC4ProfileAuthority(database.getSettings()));
  } catch (error) {
    signer = {
      ...signer,
      authorizedForProfile: false,
      error: `C4 signer authorization unavailable: ${String((error as Error)?.message ?? error)}`,
    };
  }
  return signer;
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#08111f',
    title: 'AEPA — C4 Testnet',
    icon: path.join(here, '../../assets/ustur-c4.png'),
    webPreferences: {
      preload: path.join(here, '../../electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(path.join(here, '../../ui/index.html'));
}

app.whenReady().then(() => {
  database = new AepaDatabase(path.join(app.getPath('userData'), 'aepa.sqlite'));
  rawStore = new RawStoreWorker(path.join(app.getPath('userData'), 'aepa-raw-transactions.sqlite'));
  rawCapture = new RawCaptureRuntime(rawStore, () => database.getSettings(), fetch, message => console.error(message));
  configureRawCapture(rawCapture);
  signerPath = path.join(app.getPath('userData'), 'wallet-secret-key.enc');
  fleetSync = new FleetSyncCoordinator({
    database,
    getProfile: () => database.getSettings().playerProfile,
    getIntervalMs: () => Math.max(database.getSettings().refreshIntervalSeconds, 15) * 1_000,
    load: () => loadC4Fleets(database.getSettings(), database.listAutomationAssignments().map((assignment) => ({
      fleetName: assignment.fleetName,
      fleetAddress: assignment.fleetAddress,
      scope: {
        homeSystemId: assignment.homeSystemId,
        homeSystemName: assignment.homeSystemName,
        resourceId: assignment.resourceId,
        resourceIds: assignment.resourceIds,
        resourceName: assignment.resourceName,
        destinationAddress: assignment.destinationAddress,
        destinationName: assignment.destinationName,
      },
    }))),
    toPayload: ({ characterAddress, copperLoop, copperLoops }) => ({ characterAddress, copperLoop, copperLoops }),
  });
  catalogSync = new CatalogSyncCoordinator({
    database,
    getScope: () => database.getSettings().playerProfile,
  });
  automationRunner = new AutomaticCopperRunner(database, async (assignment) => {
    const settings = database.getSettings();
    if (assignment.profile !== settings.playerProfile) throw new Error('Saved Automation profile no longer matches Settings');
    if (isCrossSystemTravelMode(assignment.travelMode)) throw new Error('Cross-system execution is disabled until C4 fuel, routing, arrival, and return behavior has been validated');
    const scopeFor = (value: typeof assignment): MiningLoopScope => ({
      homeSystemId: value.homeSystemId,
      homeSystemName: value.homeSystemName,
      resourceId: value.resourceId,
      resourceIds: value.resourceIds,
      resourceName: value.resourceName,
      destinationAddress: value.destinationAddress,
      destinationName: value.destinationName,
    });
    let effective = assignment;
    if (assignment.pendingAssignment) {
      const inspection = await inspectNextCopperStep(settings, assignment.targetStopAtUnixSeconds, assignment.fleetName, assignment.fleetAddress, scopeFor(assignment));
      if (inspection.decision.kind === 'start-mining') {
        effective = database.applyPendingAutomationAssignment(assignment.fleetAddress);
        database.recordAutomationActivity({ fleetAddress: effective.fleetAddress, fleetName: effective.fleetName, kind: 'enabled', detail: `Pending assignment activated at the serviced cycle boundary: ${effective.resourceName} at ${effective.destinationName}` });
      }
    }
    const expectedAuthority = await getActiveC4ProfileAuthority(settings);
    return withStoredSigner(signerPath, safeStorage, async (secretKey, publicKey) => {
      if (publicKey !== expectedAuthority) throw new Error('Stored signer no longer matches the active C4 authority');
      return executeNextCopperStepOnce(settings, secretKey, effective.targetStopAtUnixSeconds, (stage, details) => {
        if (stage === 'automatic-action-selected' && details?.action === 'start-mining' && details.targetStopAtUnixSeconds) {
          database.setAutomationTargetStop(BigInt(details.targetStopAtUnixSeconds), effective.fleetAddress);
        }
      }, effective.fleetName, effective.fleetAddress, scopeFor(effective), effective.stopMode);
    });
  });
  ipcMain.handle('bootstrap', async () => ({ version: app.getVersion(), network: C4_NETWORK, signer: await getAuthorizedSignerStatus(signerPath) }));
  ipcMain.handle('signer:store', async (_event, plaintext, replace) => {
    if (typeof plaintext !== 'string' || plaintext.length < 2 || plaintext.length > 4096) throw new Error('Enter a valid 32- or 64-byte JSON private key');
    const expectedPublicKey = await getActiveC4ProfileAuthority(database.getSettings());
    return storeAuthorizedSigner(plaintext, signerPath, safeStorage, expectedPublicKey, { replace: replace === true });
  });
  ipcMain.handle('signer:remove', () => {
    for (const assignment of database.listAutomationAssignments().filter((value) => value.enabled)) {
      database.pauseAutomation('Signer was removed while Automation was enabled', assignment.fleetAddress);
      database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'paused', detail: 'Signer was removed while Automation was enabled' });
    }
    removeStoredSigner(signerPath);
    return getSignerStatus(signerPath, safeStorage);
  });
  ipcMain.handle('settings:get', () => database.getSettings());
  ipcMain.handle('settings:save', (_event, value) => {
    if (database.listAutomationAssignments().some((assignment) => assignment.enabled)) throw new Error('Pause Automation before changing Settings');
    const settings = database.saveSettings(value);
    void fleetSync.refresh().catch(() => undefined);
    return settings;
  });
  ipcMain.handle('fleets:list', () => {
    const settings = database.getSettings();
    return database.listFleets(settings.playerProfile);
  });
  ipcMain.handle('fleets:snapshot', () => database.getFleetSnapshot(database.getSettings().playerProfile));
  ipcMain.handle('c4:connect', () => fleetSync.refresh());
  ipcMain.handle('automation:catalog', async () => (await catalogSync.resolve()).value);
  ipcMain.handle('automation:state', () => automationState());
  ipcMain.handle('automation:save', async (_event, value) => {
    try {
      const settings = database.getSettings();
      const catalog = await loadMiningAutomationCatalog(settings);
      if (!Array.isArray(value) || value.length === 0) throw new Error('Save at least one fleet assignment');
      const validated = value.map((draft) => validateSupportedAutomationAssignment(draft, catalog, settings.playerProfile));
      const previous = database.listAutomationAssignments();
      for (const assignment of previous.filter((candidate) => candidate.stopMode)) {
        const replacement = validated.find((candidate) => candidate.fleetAddress === assignment.fleetAddress);
        const unchanged = replacement && Object.entries(replacement).every(([key, field]) => JSON.stringify(assignment[key as keyof typeof replacement]) === JSON.stringify(field));
        if (!unchanged) throw new Error(`Fleet ${assignment.fleetName} is stopping and cannot be edited or removed`);
      }
      for (const candidate of validated.filter((assignment) => isCrossSystemTravelMode(assignment.travelMode))) {
        const active = previous.find((assignment) => assignment.fleetAddress === candidate.fleetAddress && assignment.enabled);
        if (active) throw new Error(`Pause ${candidate.fleetName} Automation before replacing its live assignment with cross-system travel`);
      }
      for (const assignment of previous) {
        const replacement = validated.find((candidate) => candidate.fleetAddress === assignment.fleetAddress);
        if (!replacement && (assignment.enabled || assignment.status === 'paused')) {
          throw new Error(`Fleet ${assignment.fleetName} is active or paused and cannot be removed; keep its row or disable it after reconciliation`);
        }
      }
      const assignments = database.saveAutomationAssignments(validated);
      for (const assignment of assignments.filter((candidate) => candidate.pendingAssignment)) {
        database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'enabled', detail: `Assignment update queued for the next serviced cycle boundary: ${assignment.pendingAssignment!.resourceName} at ${assignment.pendingAssignment!.destinationName}` });
      }
      // Saving a new fleet assignment automatically enables live execution.
      // Updates to a running fleet stay pending until its current cycle has
      // stopped, docked, unloaded, and refilled safely.
      try {
        const signer = await getAuthorizedSignerStatus(signerPath);
        if (!signer.authorizedForProfile || signer.error) throw new Error(signer.error ?? 'An authorized C4 signer is required');
        for (const assignment of assignments) {
          if (!shouldEnableSavedAssignment(assignment)) continue;
          if (isCrossSystemTravelMode(assignment.travelMode)) {
            const detail = 'Cross-system assignment saved locally; execution remains disabled until C4 fuel, routing, arrival, and return behavior has been validated';
            database.setAutomationBlocked(detail, assignment.fleetAddress);
            database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'disabled', detail });
            continue;
          }
          assertAutomationCanEnable(assignment);
          if (assignment.profile !== database.getSettings().playerProfile) throw new Error('Saved Automation assignment belongs to another Player Profile');
          database.setAutomationEnabled(true, assignment.fleetAddress);
          database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'enabled', detail: 'Assignment saved and live execution enabled automatically' });
        }
        scheduleAutomationTick(0);
      } catch (error) {
        const detail = `Assignment saved but not enabled: ${String((error as Error)?.message ?? error)}`;
        for (const assignment of database.listAutomationAssignments().filter((candidate) => !candidate.enabled && candidate.status !== 'paused')) {
          database.setAutomationBlocked(detail, assignment.fleetAddress);
          database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'disabled', detail });
        }
      }
      return automationState();
    } catch (error) {
      const detail = `Save blocked — ${String((error as Error)?.message ?? error)}`;
      database.recordAutomationActivity({ kind: 'disabled', detail });
      throw error;
    }
  });
  ipcMain.handle('automation:request-stop', async (_event, fleetAddress, mode) => {
    if (typeof fleetAddress !== 'string' || fleetAddress.length < 1 || fleetAddress.length > 64) throw new Error('Invalid Fleet address');
    if (mode !== 'now' && mode !== 'end-of-cycle') throw new Error('Invalid Automation stop mode');
    const assignment = database.requestAutomationStop(mode, fleetAddress);
    const timing = mode === 'now' ? 'immediately' : 'at the end of the current mining cycle';
    database.recordAutomationActivity({
      fleetAddress: assignment.fleetAddress,
      fleetName: assignment.fleetName,
      kind: 'waiting',
      action: 'stop-automation',
      detail: `Stop requested ${timing}; AEPA will return home, unload, refill, and then disable this assignment`,
    });
    scheduleAutomationTick(0);
    return automationState();
  });
  ipcMain.handle('automation:set-enabled', async (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Automation enabled state must be boolean');
    const assignment = database.getAutomationAssignment();
    if (!assignment) throw new Error('Save the supported Automation assignment first');
    if (enabled) {
      assertAutomationCanEnable(assignment);
      const signer = await getAuthorizedSignerStatus(signerPath);
      if (!signer.authorizedForProfile || signer.error) throw new Error(signer.error ?? 'An authorized C4 signer is required');
      if (assignment.profile !== database.getSettings().playerProfile) throw new Error('Saved Automation assignment belongs to another Player Profile');
      if (recoveringFleets.has(assignment.fleetAddress)) throw new Error('Fleet recovery is in progress');
      database.setAutomationEnabled(true);
      database.recordAutomationActivity({ kind: 'enabled', detail: 'Live automatic execution explicitly enabled' });
      scheduleAutomationTick(0);
    } else {
      database.setAutomationEnabled(false);
      database.recordAutomationActivity({ kind: 'disabled', detail: 'Automatic execution disabled by the operator' });
    }
    return automationState();
  });
  const recoveringFleets = new Set<string>();
  ipcMain.handle('automation:recover', async (_event, operationId: unknown) => {
    if (typeof operationId !== 'string') throw new Error('Invalid recovery operation');
    const settings = database.getSettings();
    const operation = (await rawStore.inspectRecovery(settings.network, settings.playerProfile)).find(row => row.id === operationId);
    if (!operation || !operation.scope.startsWith('fleet:')) throw new Error('Recovery operation not found');
    const fleetAddress = operation.scope.slice(6);
    const assignment = database.listAutomationAssignments().find(row => row.fleetAddress === fleetAddress);
    if (!assignment || assignment.profile !== settings.playerProfile || assignment.status !== 'paused') throw new Error('Recovery requires a paused matching fleet');
    if (recoveringFleets.has(fleetAddress)) throw new Error('Recovery already in progress');
    recoveringFleets.add(fleetAddress);
    try {
      let nextStep = '';
      await recoverPausedOperation(operation.evidence, {
        inspect: async () => {
          const observed = await inspectNextCopperStep(settings, assignment.targetStopAtUnixSeconds, assignment.fleetName, fleetAddress, {
            homeSystemId:assignment.homeSystemId, homeSystemName:assignment.homeSystemName,
            resourceId:assignment.resourceId, resourceIds:assignment.resourceIds, resourceName:assignment.resourceName,
            destinationAddress:assignment.destinationAddress, destinationName:assignment.destinationName,
          });
          if (observed.decision.kind === 'blocked') throw new Error(observed.decision.reason);
          nextStep = observed.decision.kind;
          const current = database.getSettings();
          const latest = database.listAutomationAssignments().find(row => row.fleetAddress === fleetAddress);
          if (current.network !== settings.network || current.playerProfile !== settings.playerProfile ||
              current.rpcUrl !== settings.rpcUrl || JSON.stringify(latest, (_key,value) => typeof value === 'bigint' ? value.toString() : value) !==
              JSON.stringify(assignment, (_key,value) => typeof value === 'bigint' ? value.toString() : value)) throw new Error('Settings or assignment changed during recovery; try again');
        },
        disable: async () => { database.setAutomationEnabled(false, fleetAddress); },
        resolve: async () => { await rawStore.resolveOperation(operation.id); },
      });
      if (assignment.stopMode) {
        database.setAutomationEnabled(true, fleetAddress);
        database.recordAutomationActivity({fleetAddress, fleetName:assignment.fleetName, kind:'enabled', action:'stop-automation',
          detail:`Operator reconciled ${operation.signature} (${operation.evidence}); current next step: ${nextStep}. Resuming the already-requested safe shutdown.`});
        scheduleAutomationTick(0);
      } else {
        database.recordAutomationActivity({fleetAddress, fleetName:assignment.fleetName, kind:'disabled',
          detail:`Operator reconciled ${operation.signature} (${operation.evidence}); current next step: ${nextStep}. Automation remains disabled; enable separately.`});
      }
      return automationState();
    } finally { recoveringFleets.delete(fleetAddress); }
  });
  ipcMain.handle('automation:clear-pause', () => {
    const assignment = database.getAutomationAssignment();
    if (!assignment || assignment.status !== 'paused') throw new Error('Automation is not paused');
    if (isPostSubmissionFailure(assignment.lastError ?? '')) {
      throw new Error('This pause followed a submitted transaction and requires out-of-band chain-state reconciliation; AEPA will not clear it automatically');
    }
    database.setAutomationEnabled(false);
    database.recordAutomationActivity({ kind: 'disabled', detail: `Plan-stage pause cleared: ${String(assignment.lastError).slice(0, 200)}` });
    return automationState();
  });
  ipcMain.handle('automation:simulate-next', async () => withStoredSigner(
    signerPath,
    safeStorage,
    async (secretKey) => simulateNextCopperStepSigned(database.getSettings(), secretKey),
  ));
  ipcMain.handle('game:clear-cache', async () => {
    await rawStore.rotateGeneration(database.getSettings().network);
    database.clearGameCache();
    database.recordAutomationActivity({ kind: 'disabled', detail: 'Cached game data cleared after a C4 reset (fresh start); settings and encrypted signer kept' });
    scheduleAutomationTick(0);
    return automationState();
  });
  createWindow();
  rawCapture.start();
  fleetSync.start();
  catalogSync.start();
  scheduleAutomationTick(3_000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void rawCapture?.stop();
  if (automationTimer) clearTimeout(automationTimer);
  fleetSync?.stop();
  catalogSync?.stop();
  database?.close();
});
