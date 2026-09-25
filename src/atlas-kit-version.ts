export interface AtlasKitVersionStatus {
  bundled: string;
  latest: string | null;
  current: boolean | null;
  error?: string;
}

const REGISTRY_URL = 'https://registry.npmjs.org/%40aephia%2Fatlas-kit';

export function classifyAtlasKitVersion(
  bundled: string,
  latest: string | null,
  error?: string,
): AtlasKitVersionStatus {
  return {
    bundled,
    latest,
    current: latest === null ? null : bundled === latest,
    ...(error ? { error } : {}),
  };
}

export async function getAtlasKitVersionStatus(
  bundled: string,
  fetchRegistry: typeof fetch = fetch,
): Promise<AtlasKitVersionStatus> {
  try {
    const response = await fetchRegistry(REGISTRY_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const registry = await response.json() as { 'dist-tags'?: { next?: unknown } };
    const latest = registry['dist-tags']?.next;
    if (typeof latest !== 'string' || !latest) throw new Error('npm registry did not return the next tag');
    return classifyAtlasKitVersion(bundled, latest);
  } catch (error) {
    return classifyAtlasKitVersion(bundled, null, String((error as Error)?.message ?? error));
  }
}
