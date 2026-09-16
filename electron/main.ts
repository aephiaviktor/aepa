import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMiningAutomationCatalog } from '../src/automation-catalog.js';
import { assertAutomationCanEnable, assertAutomationCanReplace, validateSupportedAutomationAssignment } from '../src/automation-assignment.js';
import { AutomaticCopperRunner } from '../src/automation-runner.js';
import { executeNextCopperStepOnce } from '../src/automatic-c4.js';
import { getActiveC4ProfileAuthority, loadC4Fleets, simulateNextCopperStepSigned } from '../src/c4.js';
import { AepaDatabase } from '../src/database.js';
import { FleetSyncCoordinator } from '../src/fleet-sync.js';
import { CatalogSyncCoordinator } from '../src/catalog-sync.js';
import { C4_NETWORK } from '../src/network.js';
import { authorizeSignerStatus, getSignerStatus, removeStoredSigner, storeAuthorizedSigner, withStoredSigner, type SignerStatus } from '../src/signer-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let database: AepaDatabase;
let automationRunner: AutomaticCopperRunner;
let automationTimer: NodeJS.Timeout | undefined;
let fleetSync: FleetSyncCoordinator<Awaited<ReturnType<typeof loadC4Fleets>>>;
let catalogSync: CatalogSyncCoordinator;
let signerPath: string;

function automationState() {
  const assignment = database.getAutomationAssignment();
  return {
    assignment: assignment ? {
      ...assignment,
      targetStopAtUnixSeconds: assignment.targetStopAtUnixSeconds?.toString(),
    } : undefined,
    activity: database.listAutomationActivity(25),
  };
}

function scheduleAutomationTick(delayMs = 0): void {
  if (automationTimer) clearTimeout(automationTimer);
  automationTimer = setTimeout(async () => {
    await automationRunner.tick();
    const intervalMs = Math.max(database.getSettings().refreshIntervalSeconds, 15) * 1_000;
    scheduleAutomationTick(intervalMs);
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
  signerPath = path.join(app.getPath('userData'), 'wallet-secret-key.enc');
  fleetSync = new FleetSyncCoordinator({
    database,
    getProfile: () => database.getSettings().playerProfile,
    getIntervalMs: () => Math.max(database.getSettings().refreshIntervalSeconds, 15) * 1_000,
    load: () => loadC4Fleets(database.getSettings()),
    toPayload: ({ characterAddress, copperLoop }) => ({ characterAddress, copperLoop }),
  });
  catalogSync = new CatalogSyncCoordinator({
    database,
    getScope: () => database.getSettings().playerProfile,
  });
  automationRunner = new AutomaticCopperRunner(database, async (assignment) => {
    const settings = database.getSettings();
    if (assignment.profile !== settings.playerProfile) throw new Error('Saved Automation profile no longer matches Settings');
    if (assignment.fleetName !== 'MF-01' || assignment.homeSystemId !== 10 || assignment.homeSystemName !== 'Eternity'
      || assignment.resourceId !== 311 || assignment.destinationName !== 'Ioki' || assignment.travelMode !== 'auto') {
      throw new Error('Saved assignment is outside the currently authorized MF-01 Eternity Ioki Copper scope');
    }
    const expectedAuthority = await getActiveC4ProfileAuthority(settings);
    return withStoredSigner(signerPath, safeStorage, async (secretKey, publicKey) => {
      if (publicKey !== expectedAuthority) throw new Error('Stored signer no longer matches the active C4 authority');
      return executeNextCopperStepOnce(settings, secretKey, assignment.targetStopAtUnixSeconds, (stage, details) => {
        if (stage === 'automatic-action-selected' && details?.action === 'start-mining' && details.targetStopAtUnixSeconds) {
          database.setAutomationTargetStop(BigInt(details.targetStopAtUnixSeconds));
        }
      });
    });
  });
  ipcMain.handle('bootstrap', async () => ({ version: app.getVersion(), network: C4_NETWORK, signer: await getAuthorizedSignerStatus(signerPath) }));
  ipcMain.handle('signer:store', async (_event, plaintext, replace) => {
    if (typeof plaintext !== 'string' || plaintext.length < 2 || plaintext.length > 4096) throw new Error('Enter a valid 32- or 64-byte JSON private key');
    const expectedPublicKey = await getActiveC4ProfileAuthority(database.getSettings());
    return storeAuthorizedSigner(plaintext, signerPath, safeStorage, expectedPublicKey, { replace: replace === true });
  });
  ipcMain.handle('signer:remove', () => {
    if (database.getAutomationAssignment()?.enabled) {
      database.pauseAutomation('Signer was removed while Automation was enabled');
      database.recordAutomationActivity({ kind: 'paused', detail: 'Signer was removed while Automation was enabled' });
    }
    removeStoredSigner(signerPath);
    return getSignerStatus(signerPath, safeStorage);
  });
  ipcMain.handle('settings:get', () => database.getSettings());
  ipcMain.handle('settings:save', (_event, value) => {
    if (database.getAutomationAssignment()?.enabled) throw new Error('Pause Automation before changing Settings');
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
    assertAutomationCanReplace(database.getAutomationAssignment());
    const settings = database.getSettings();
    const catalog = await loadMiningAutomationCatalog(settings);
    const assignment = database.saveAutomationAssignment(validateSupportedAutomationAssignment(value, catalog, settings.playerProfile));
    // Saving a fleet assignment automatically enables live execution. There is
    // no separate "enable automatic send" step; the runner starts on save.
    try {
      assertAutomationCanEnable(assignment);
      const signer = await getAuthorizedSignerStatus(signerPath);
      if (!signer.authorizedForProfile || signer.error) throw new Error(signer.error ?? 'An authorized C4 signer is required');
      if (assignment.profile !== database.getSettings().playerProfile) throw new Error('Saved Automation assignment belongs to another Player Profile');
      database.setAutomationEnabled(true);
      database.recordAutomationActivity({ kind: 'enabled', detail: 'Assignment saved and live execution enabled automatically' });
      scheduleAutomationTick(0);
    } catch (error) {
      database.recordAutomationActivity({ kind: 'disabled', detail: `Assignment saved but not enabled: ${String((error as Error)?.message ?? error)}` });
    }
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
      database.setAutomationEnabled(true);
      database.recordAutomationActivity({ kind: 'enabled', detail: 'Live automatic execution explicitly enabled' });
      scheduleAutomationTick(0);
    } else {
      database.setAutomationEnabled(false);
      database.recordAutomationActivity({ kind: 'disabled', detail: 'Automatic execution disabled by the operator' });
    }
    return automationState();
  });
  ipcMain.handle('automation:simulate-next', async () => withStoredSigner(
    signerPath,
    safeStorage,
    async (secretKey) => simulateNextCopperStepSigned(database.getSettings(), secretKey),
  ));
  createWindow();
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
  if (automationTimer) clearTimeout(automationTimer);
  fleetSync?.stop();
  catalogSync?.stop();
  database?.close();
});
