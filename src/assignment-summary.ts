export interface NamedSelection {
  name: string;
  amount?: string;
}

export function formatAssignmentSelection(
  selected: readonly NamedSelection[],
  emptyLabel: string,
): { summary: string; title: string } {
  if (selected.length === 0) return { summary: emptyLabel, title: '' };
  return {
    summary: selected.map(item => item.name + (item.amount === undefined ? '' : ' ' + item.amount))
      .join(selected.every(item => item.amount === undefined) ? ', ' : ' · '),
    title: selected.map(item => item.name + (item.amount === undefined ? '' : ': ' + item.amount)).join('\n'),
  };
}

export function formatTransportCargoTooltip(snapshot: unknown): string {
  const cargoHold = (snapshot as { cargoHold?: { items?: unknown[] } } | undefined)?.cargoHold;
  const items = Array.isArray(cargoHold?.items) ? cargoHold.items : [];
  const cargo = items.flatMap((value): NamedSelection[] => {
    const item = value as { name?: unknown; amount?: unknown };
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Unknown cargo';
    let amount: bigint;
    try { amount = BigInt(String(item.amount ?? 0)); } catch { return []; }
    return amount > 0n ? [{ name, amount: amount.toString() }] : [];
  });
  const detail = formatAssignmentSelection(cargo, 'None').title || 'None';
  return 'Onboard cargo\n' + detail;
}
