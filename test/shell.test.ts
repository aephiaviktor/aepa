import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('desktop shell exposes automatic cached fleet refresh and safe read-only status', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  assert.match(html, /C4 TESTNET/);
  assert.match(html, /Player Profile/);
  assert.match(html, /Refresh now/);
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
  assert.match(script, /authorizedForProfile/);
  assert.match(script, /C4 authority verified/);
  assert.match(html, /C4 signer private key/);
  assert.match(html, /32- or 64-byte secret-key JSON/);
  assert.match(html, /type="password"[^>]+id="c4-signer-secret"/);
  assert.match(html, /id="store-signer"/);
  assert.match(html, /id="remove-signer"/);
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
  for (const id of ['automation-fleet', 'automation-assignment', 'automation-home', 'automation-resource', 'automation-destination', 'automation-travel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Region \| System \| Asteroid belt \| Distance/);
  assert.match(html, /config-header/);
  assert.match(html, /id="save-assignment"/);
  assert.match(script, /rankMiningDestinations/);
  assert.match(script, /loadAutomationCatalog/);
  assert.match(preload, /automation:catalog/);
  assert.match(preload, /automation:save/);
  assert.match(preload, /automation:set-enabled/);
  assert.match(html, /id="show-status"/);
  assert.match(html, /id="status-panel"/);
  assert.match(html, /id="cancel-assignment"/);
  assert.match(html, /id="pause-automation"/);
  assert.match(html, /enables it automatically/);
  assert.match(script, /saveAutomationAssignment/);
  assert.match(script, /setAutomationEnabled\(false\)/);
  assert.match(script, /renderStatusPanel/);
  assert.match(script, /transaction already submitted to C4 cannot be cancelled/);
  assert.match(html, /class="automation-fleet-row"/);
  assert.match(html, /class="field-grid compact-field-grid"/);

  const styles = await readFile(join(process.cwd(), 'ui/styles.css'), 'utf8');
  assert.match(styles, /--cyan:/);
  assert.match(styles, /\.page-view\[hidden\]/);
  assert.match(styles, /\.compact-field-grid/);
});

test('shell exposes the zero-reserve Eternity and Ioki Copper loop preview', async () => {
  const html = await readFile(join(process.cwd(), 'ui/index.html'), 'utf8');
  const script = await readFile(join(process.cwd(), 'ui/app.js'), 'utf8');
  assert.match(html, /Copper Mining Loop/);
  assert.match(html, /Food until cargo full/);
  assert.match(html, /Food until ammo empty/);
  assert.match(html, /Food to load/);
  assert.match(html, /Preview only/);
  assert.match(script, /copperLoop/);
  assert.match(script, /unavoidableFoodRoundingRaw/);
  assert.match(html, /Run signed simulation/);
  assert.match(html, /nothing will be submitted/);
  assert.match(script, /signature verified/);
  assert.match(script, /transactionSignature/);
  assert.match(script, /simulateNextCopperStep/);
  assert.match(html, /nothing will be submitted|Next signed transaction/);
});
