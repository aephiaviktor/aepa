export interface ActivityEntry {
  fleetName?: string;
  action?: string;
  kind: string;
  detail: string;
  occurredAt?: string;
  repeatCount?: number;
}

function fleetLabel(entry: ActivityEntry): string {
  return entry.fleetName || 'System';
}

export function activityFleetNames(entries: readonly ActivityEntry[]): string[] {
  return [...new Set(entries.map(fleetLabel))].sort((a, b) => a.localeCompare(b));
}

export function filterActivityEntries(entries: readonly ActivityEntry[], fleet: string, search: string): ActivityEntry[] {
  const needle = search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (fleet && fleetLabel(entry) !== fleet) return false;
    if (!needle) return true;
    return [fleetLabel(entry), entry.action, entry.kind, entry.detail]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(needle));
  });
}
