type Entry<Value> = {
  expiresAt: number;
  value: Promise<Value>;
};

/** Small process-local cache for shared definition/configuration reads.
 * Rejected loads are never retained; concurrent callers share one request.
 */
export class TtlPromiseCache<Key, Value> {
  private readonly entries = new Map<Key, Entry<Value>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('TTL must be positive');
  }

  get(key: Key, load: () => Promise<Value>): Promise<Value> {
    const current = this.entries.get(key);
    const now = this.now();
    if (current && current.expiresAt > now) return current.value;

    const value = load();
    const entry = { expiresAt: now + this.ttlMs, value };
    this.entries.set(key, entry);
    void value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
