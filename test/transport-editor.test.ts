import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  checked = false;
  disabled = false;
  value = '';
  textContent = '';
  max = '';
  min = '';
  step = '';
  type = '';
  title = '';
  placeholder = '';

  append(...children: FakeElement[]) { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]) { this.children = children; }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  dispatch(name: string) { this.listeners.get(name)?.(); }
}

test('outbound Cargo amount immediately updates projected Cargo back availability', async () => {
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { document: { createElement: () => new FakeElement() } });
  try {
    const { refreshTransportEditor } = await import(new URL('../../ui/transport-editor.js', import.meta.url).href);
    const outPicker = new FakeElement();
    const outSummary = new FakeElement();
    const outHost = new FakeElement();
    const backPicker = new FakeElement();
    const backSummary = new FakeElement();
    const backHost = new FakeElement();
    const target = new FakeElement();
    const crewOut = new FakeElement();
    const crewBack = new FakeElement();
    const pickerQuery = (summary: FakeElement, host: FakeElement) => (selector: string) => selector === 'summary' ? summary : host;
    Object.assign(outPicker, { querySelector: pickerQuery(outSummary, outHost) });
    Object.assign(backPicker, { querySelector: pickerQuery(backSummary, backHost) });
    const row = {
      querySelector(selector: string) {
        if (selector === '[data-cargo-direction="out"]') return outPicker;
        if (selector === '[data-cargo-direction="back"]') return backPicker;
        if (selector === '[data-field="destination"]') return target;
        if (selector === '[data-field="crew-out"]') return crewOut;
        if (selector === '[data-field="crew-back"]') return crewBack;
        throw new Error(`Unexpected selector ${selector}`);
      },
    };
    const catalog = {
      fleets: [{ address: 'fleet', passengerCapacity: 5, travel: { fuelCapacityRaw: '100', maxWarpDistance: 10, subwarpFuelConsumptionRate: 1, warpFuelConsumptionRate: 1 } }],
      transportSystems: [
        { address: 'home', systemId: 1, name: 'Home', coordinates: { x: 0, y: 0 }, connections: [2], availableCrew: 4,
          cargo: [{ cargoId: 10, name: 'Carbon', amountRaw: '7', storageCostRaw: '256' }] },
        { address: 'target', systemId: 2, name: 'Target', coordinates: { x: 1, y: 0 }, connections: [1], availableCrew: 2, cargo: [] },
      ],
    };
    const replaceSelectOptions = (select: FakeElement, options: Array<{value: string}>, preferred: string) => {
      select.value = options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? '');
    };
    refreshTransportEditor({
      row,
      draft: { fleetAddress: 'fleet', homeSystemAddress: 'home', destinationAddress: 'target', travelMode: 'subwarp', cargoOut: [], cargoBack: [] },
      preferredDestination: 'target',
      catalog,
      replaceSelectOptions,
      onChanged: () => undefined,
    });
    const [outLabel] = outHost.children;
    const [checkbox, , amount] = outLabel!.children;
    checkbox!.checked = true;
    checkbox!.dispatch('change');
    amount!.value = '3';
    amount!.dispatch('input');
    assert.equal(backHost.children.length, 1);
    assert.equal(backHost.children[0]!.children[1]!.textContent, 'Carbon · available 3');
  } finally {
    Object.assign(globalThis, { document: originalDocument });
  }
});
