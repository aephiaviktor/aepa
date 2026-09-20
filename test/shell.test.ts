import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('desktop shell exposes automatic cached fleet refresh and safe read-only status', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  assert.match(html, /C4 TESTNET/);
  assert.match(html, /Player Profile/);
  assert.doesNotMatch(html, /Refresh now/);
  assert.match(html, /id="fleet-sync-status"/);
  assert.match(html, /No signer configured; no RPC writes/);
  assert.match(html, /id="signer-status"/);
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  const main = await readFile(join(process.cwd(), 'electron/main.ts'), 'utf8');
  const preload = await readFile(join(process.cwd(), 'electron/preload.cjs'), 'utf8');
  assert.match(script, /getFleetSnapshot/);
  assert.match(script, /Cached snapshot/);
  assert.match(main, /fleetSync\.start\(\)/);
  assert.match(main, /fleets:snapshot/);
  assert.match(preload, /fleets:snapshot/);
  assert.match(main, /new CatalogSyncCoordinator/);
  assert.match(main, /catalogSync\.start\(\)/);
  assert.match(main, /catalogSync\.resolve\(\)/);
  assert.match(main, /shouldAutoRetryPaused/);
  assert.match(script, /authorizedForProfile/);
  assert.match(script, /C4 authority verified/);
  assert.match(html, /C4 signer private key/);
  assert.match(html, /32- or 64-byte secret-key JSON/);
  assert.match(html, /type="password"[^>]+id="c4-signer-secret"/);
  assert.match(html, /id="store-signer"/);
  assert.match(html, /id="remove-signer"/);
  assert.match(html, /id="clear-game-cache"/);
  assert.match(html, /Clear cached game data \(fresh start\)/);
  assert.match(preload, /clearGameCache/);
  assert.match(main, /game:clear-cache/);
  assert.match(script, /clearGameCache\(\)/);
  assert.match(script, /saveSigner/);
  assert.match(script, /removeSigner/);
  assert.doesNotMatch(html, /Influx/i);
});

test('sidebar switches between distinct Fleets and Automation pages without scrolling', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  assert.match(html, /id="show-fleets"/);
  assert.match(html, /id="fleets-page"[^>]+class="[^"]*page-view/);
  assert.match(html, /id="automation-page"[^>]+class="[^"]*page-view/);
  assert.match(script, /setActivePage/);
  assert.doesNotMatch(script, /scrollIntoView/);
});

test('fleet workspace uses My Fleets, Aephia artwork, and selectable columns', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  assert.match(html, /<img[^>]+src="\.\.\/assets\/aephia-logo\.webp"[^>]+alt="Aephia">/);
  assert.match(html, /<h3>My Fleets<\/h3>/);
  assert.match(html, /id="fleet-column-selector"/);
  assert.match(html, /data-column="ships"[^>]*>Ships/);
  assert.match(html, /data-column="ownership"[^>]*>Ownership/);

  const profilePosition = html.indexOf('id="player-profile"');
  const networkPosition = html.indexOf('<h3>Network</h3>');
  assert.ok(profilePosition >= 0 && profilePosition < networkPosition, 'Player Profile should be the first Settings entry');
});

test('automation workspace exposes the agreed cascading mining configuration', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  const preload = await readFile(join(process.cwd(), 'electron/preload.cjs'), 'utf8');
  assert.match(html, /id="automation-rows"/);
  assert.match(html, /id="add-fleet"/);
  assert.match(html, /id="automation-issues"/);
  for (const field of ['fleet', 'assignment', 'home', 'resource', 'destination', 'travel']) {
    assert.match(script, new RegExp(`data-field=\\"${field}\\"`));
  }
  assert.match(html, /Region \| System \| Asteroid belt \| Home distance/);
  assert.match(html, /class="assignment-columns compact-field-grid"/);
  assert.match(html, /<h3>Fleet Log<\/h3>/);
  assert.ok(html.indexOf('id="add-fleet"') < html.indexOf('id="automation-issues"'), 'Fleet Log must be below Add Fleet inside Fleet Assignment');
  assert.match(html, /config-header/);
  assert.match(html, /Fleet Assignment/);
  assert.doesNotMatch(html, /Mining Configuration/);
  assert.match(html, /id="save-assignment"/);
  assert.match(script, /rankMiningDestinations/);
  assert.match(script, /loadAutomationCatalog/);
  assert.match(preload, /automation:catalog/);
  assert.match(preload, /automation:save/);
  assert.match(preload, /automation:set-enabled/);
  assert.match(html, /id="show-status"/);
  assert.match(html, /id="status-panel"/);
  assert.match(html, /id="cancel-assignment"/);
  assert.doesNotMatch(html, /id="pause-automation"/);
  assert.doesNotMatch(html, /id="clear-pause"/);
  assert.match(script, /saveAutomationAssignment/);
  assert.match(script, /renderStatusPanel/);
  assert.match(script, /className = 'automation-fleet-row'/);
  assert.match(script, /class=\"field-grid compact-field-grid\"/);
  assert.doesNotMatch(html, /configuration-summary/);
  assert.doesNotMatch(script, /<label>Fleet<select|<label>Assignment<select/);
  assert.doesNotMatch(script, /select\.disabled = true/);

  const styles = await readFile(join(process.cwd(), 'ui/styles.css'), 'utf8');
  assert.match(styles, /--cyan:/);
  assert.match(styles, /\.page-view\[hidden\]/);
  assert.match(styles, /\.compact-field-grid/);
  assert.doesNotMatch(styles, /live-automation|metric-grid|simulation-row/);
});

test('shell drops the zero-reserve preview and the manual simulation controls', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  for (const gone of ['Copper Mining Loop', 'Food until cargo full', 'Food until ammo empty', 'Food to load', 'preview-pill', 'Run signed simulation', 'nothing will be submitted', 'Next signed transaction']) {
    assert.doesNotMatch(html, new RegExp(gone));
  }
  // The Automation status card keeps its "Preview only" default text; only the
  // zero-reserve section (and its preview pill) is gone.
  assert.match(html, /Preview only/);
  assert.doesNotMatch(script, /simulateNextStep|renderCopperLoop|unavoidableFoodRoundingRaw|transactionSignature|signature verified|simulateNextCopperStep/);
  // The fleet State pill estimate stays: it is fed by the same cached plan.
  assert.match(script, /copperLoop/);
  assert.match(script, /formatMiningProgress/);
  assert.match(script, /miningPillContent/);
});

test('destination precedes checkbox resource picker with eight-resource counter', async () => {
  const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8').catch(() => readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'));
  assert.match(source, /type="checkbox"/);
  assert.match(source, /\/8/);
  assert.ok(source.indexOf('aria-label="Mining Destination"') < source.indexOf('aria-label="Resources"'));
});

test('travel mode precedes mining destination and same-system wording stays compact', async () => {
  const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8').catch(() => readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'));
  assert.ok(source.indexOf('aria-label="Travel"') < source.indexOf('aria-label="Mining Destination"'));
  assert.match(source, /Same system/);
  assert.doesNotMatch(source, /Not required \(same system\)/);
  assert.doesNotMatch(source, /travel unavailable/);
});

test('Save highlights only for valid unsaved assignment changes', async () => {
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  const styles = await readFile(join(process.cwd(), 'ui/styles.css'), 'utf8');
  assert.match(script, /automationDraftsEqual/);
  assert.match(script, /save\.classList\.toggle\('dirty', canSave && dirty\)/);
  assert.match(script, /save\.disabled = !canSave \|\| !dirty/);
  assert.match(styles, /#save-assignment:not\(\.dirty\)/);
  assert.match(script, /row\.classList\.toggle\('pending', !!persisted\?\.pendingAssignment\)/);
});

test('mining tooltips use per-fleet multi-resource progress without Estimated', async () => {
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  const main = await readFile(join(process.cwd(), 'electron/main.ts'), 'utf8');
  const c4 = await readFile(join(process.cwd(), 'src/c4.ts'), 'utf8');
  assert.match(script, /formatMiningProgress/);
  assert.match(script, /miningLoopPlans\.get\(fleetAddress\)/);
  assert.doesNotMatch(script, /title: `Estimated/);
  assert.match(main, /copperLoops/);
  assert.match(c4, /expectedResources/);
});

test('Automation warns before navigation when assignment changes are unsaved', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  assert.match(html, /id="unsaved-dialog"/);
  assert.match(html, /Save and leave/);
  assert.match(html, /Discard and leave/);
  assert.match(html, /Keep editing/);
  assert.match(html, /id="show-activity"/);
  assert.match(script, /requestNavigation/);
  assert.match(script, /beforeunload/);
});

test('Fleet and Player Profile addresses are full, selectable, and copyable', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  const styles = await readFile(join(process.cwd(), 'ui/styles.css'), 'utf8');
  assert.match(html, /id="profile-status"[^>]*class="[^"]*copyable-address/);
  assert.match(html, /id="copy-profile-address"/);
  assert.match(script, /renderFleetAddress/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(script, /column\.id === 'address' \? short\(value\)/);
  assert.match(styles, /user-select:\s*text/);
});
