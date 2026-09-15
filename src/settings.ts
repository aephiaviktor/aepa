import { address } from '@solana/kit';
import { C4_NETWORK } from './network.js';

export interface AppSettings {
  network: typeof C4_NETWORK.id;
  rpcUrl: string;
  playerProfile: string;
  refreshIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  network: C4_NETWORK.id,
  rpcUrl: C4_NETWORK.defaultRpcUrl,
  playerProfile: '',
  refreshIntervalSeconds: 60,
});

export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') throw new Error('Settings must be an object');
  const input = value as Partial<AppSettings>;
  if (input.network !== C4_NETWORK.id) throw new Error('AEPA is locked to C4 Testnet');
  if (typeof input.rpcUrl !== 'string') throw new Error('RPC URL is required');
  let rpc: URL;
  try {
    rpc = new URL(input.rpcUrl.trim());
  } catch {
    throw new Error('RPC URL must be a valid URL');
  }
  if (rpc.protocol !== 'https:' && rpc.protocol !== 'http:') {
    throw new Error('RPC URL must use HTTP or HTTPS');
  }
  const playerProfile = String(input.playerProfile ?? '').trim();
  if (playerProfile) address(playerProfile);
  const refreshIntervalSeconds = Number(input.refreshIntervalSeconds);
  if (!Number.isInteger(refreshIntervalSeconds) || refreshIntervalSeconds < 15 || refreshIntervalSeconds > 3600) {
    throw new Error('Refresh interval must be between 15 and 3600 seconds');
  }
  return {
    network: C4_NETWORK.id,
    rpcUrl: rpc.toString().replace(/\/$/, ''),
    playerProfile,
    refreshIntervalSeconds,
  };
}
