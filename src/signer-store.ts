import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface SecretProtector {
  isEncryptionAvailable(): boolean;
  decryptString(value: Buffer): string;
  encryptString(value: string): Buffer;
}

export interface SignerStatus {
  configured: boolean;
  encryptionAvailable: boolean;
  publicKey?: string;
  expectedPublicKey?: string;
  authorizedForProfile?: boolean;
  error?: string;
}

export function authorizeSignerStatus(status: SignerStatus, expectedPublicKey: string): SignerStatus {
  const authorizedForProfile = status.publicKey === expectedPublicKey && !status.error;
  return {
    ...status,
    expectedPublicKey,
    authorizedForProfile,
    ...(authorizedForProfile ? {} : { error: status.error ?? 'Stored signer does not match the active C4 Player Profile authority' }),
  };
}

export function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return '1'.repeat(leadingZeroes) + encoded;
}

export function parseWalletSecretKey(value: string): { secretKey: Buffer; publicKey: Buffer } {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || ![32, 64].includes(parsed.length) || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Secret key must be a JSON array containing exactly 32 or 64 bytes');
  }
  const supplied = Buffer.from(parsed);
  const seed = supplied.subarray(0, 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (supplied.length === 64 && !crypto.timingSafeEqual(publicKey, supplied.subarray(32))) {
    supplied.fill(0);
    throw new Error('Secret key public key does not match its private seed');
  }
  if (supplied.length === 64) return { secretKey: supplied, publicKey };
  const secretKey = Buffer.concat([seed, publicKey]);
  supplied.fill(0);
  return { secretKey, publicKey };
}

export function getSignerStatus(secretPath: string, protector: SecretProtector): SignerStatus {
  const encryptionAvailable = protector.isEncryptionAvailable();
  if (!fs.existsSync(secretPath)) return { configured: false, encryptionAvailable };
  if (!encryptionAvailable) return { configured: true, encryptionAvailable: false, error: 'Operating-system encryption is not available' };
  let parsed: ReturnType<typeof parseWalletSecretKey> | undefined;
  try {
    parsed = parseWalletSecretKey(protector.decryptString(fs.readFileSync(secretPath)));
    return { configured: true, encryptionAvailable: true, publicKey: encodeBase58(parsed.publicKey) };
  } catch (error) {
    return { configured: true, encryptionAvailable: true, error: String((error as Error)?.message ?? error) };
  } finally {
    parsed?.secretKey.fill(0);
  }
}

export function storePlaintextSigner(plaintext: string, targetPath: string, protector: SecretProtector): SignerStatus {
  if (!protector.isEncryptionAvailable()) throw new Error('Operating-system encryption is not available');
  if (fs.existsSync(targetPath)) throw new Error('AEPA signer is already configured');

  const parsed = parseWalletSecretKey(plaintext);
  const expectedPublicKey = encodeBase58(parsed.publicKey);
  const temporaryPath = `${targetPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(temporaryPath, protector.encryptString(plaintext), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, targetPath);
    const status = getSignerStatus(targetPath, protector);
    if (status.publicKey !== expectedPublicKey || status.error) {
      fs.rmSync(targetPath, { force: true });
      throw new Error('AEPA signer verification failed after encryption');
    }
    return status;
  } finally {
    parsed.secretKey.fill(0);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function storeAuthorizedSigner(
  plaintext: string,
  targetPath: string,
  protector: SecretProtector,
  expectedPublicKey: string,
  options: { replace?: boolean } = {},
): SignerStatus {
  if (!protector.isEncryptionAvailable()) throw new Error('Operating-system encryption is not available');

  const parsed = parseWalletSecretKey(plaintext);
  const publicKey = encodeBase58(parsed.publicKey);
  const temporaryPath = `${targetPath}.tmp`;
  const backupPath = `${targetPath}.bak`;
  let previousMoved = false;
  let replacementInstalled = false;
  try {
    if (publicKey !== expectedPublicKey) throw new Error('Private key does not match the active C4 Player Profile authority');

    if (fs.existsSync(backupPath)) {
      if (fs.existsSync(targetPath)) fs.rmSync(backupPath, { force: true });
      else fs.renameSync(backupPath, targetPath);
    }
    fs.rmSync(temporaryPath, { force: true });
    if (fs.existsSync(targetPath) && !options.replace) throw new Error('AEPA signer is already configured');

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(temporaryPath, protector.encryptString(plaintext), { mode: 0o600, flag: 'wx' });
    const temporaryStatus = getSignerStatus(temporaryPath, protector);
    if (temporaryStatus.publicKey !== expectedPublicKey || temporaryStatus.error) throw new Error('AEPA signer verification failed after encryption');

    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath);
      previousMoved = true;
    }
    fs.renameSync(temporaryPath, targetPath);
    replacementInstalled = true;

    const status = authorizeSignerStatus(getSignerStatus(targetPath, protector), expectedPublicKey);
    if (!status.authorizedForProfile || status.error) throw new Error('AEPA signer authorization failed after storage');
    fs.rmSync(backupPath, { force: true });
    previousMoved = false;
    return status;
  } catch (error) {
    if (previousMoved && fs.existsSync(backupPath)) {
      if (replacementInstalled) fs.rmSync(targetPath, { force: true });
      fs.renameSync(backupPath, targetPath);
      previousMoved = false;
    } else if (replacementInstalled) {
      fs.rmSync(targetPath, { force: true });
    }
    throw error;
  } finally {
    parsed.secretKey.fill(0);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function removeStoredSigner(targetPath: string): void {
  fs.rmSync(targetPath, { force: true });
  fs.rmSync(`${targetPath}.tmp`, { force: true });
  fs.rmSync(`${targetPath}.bak`, { force: true });
}

export async function withStoredSigner<T>(
  secretPath: string,
  protector: SecretProtector,
  use: (secretKey: Buffer, publicKey: string) => Promise<T>,
): Promise<T> {
  if (!fs.existsSync(secretPath)) throw new Error('No AEPA signer is configured');
  if (!protector.isEncryptionAvailable()) throw new Error('Operating-system encryption is not available');
  const parsed = parseWalletSecretKey(protector.decryptString(fs.readFileSync(secretPath)));
  try {
    return await use(parsed.secretKey, encodeBase58(parsed.publicKey));
  } finally {
    parsed.secretKey.fill(0);
  }
}

export function migrateEncryptedSigner(sourcePath: string, targetPath: string, protector: SecretProtector): SignerStatus {
  if (!fs.existsSync(sourcePath)) throw new Error('Source signer does not exist');
  return storePlaintextSigner(protector.decryptString(fs.readFileSync(sourcePath)), targetPath, protector);
}
