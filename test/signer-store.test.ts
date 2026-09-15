import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorizeSignerStatus, encodeBase58, getSignerStatus, migrateEncryptedSigner, parseWalletSecretKey, removeStoredSigner, storeAuthorizedSigner, withStoredSigner, type SecretProtector } from '../src/signer-store.js';

function validSecret(): number[] {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return [...seed, ...publicBytes];
}

const protector: SecretProtector = {
  isEncryptionAvailable: () => true,
  decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^enc:/, ''),
  encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
};

test('wallet parser accepts 32-byte seeds and 64-byte keypairs, and rejects a mismatched public key', () => {
  const bytes = validSecret();
  const fromSeed = parseWalletSecretKey(JSON.stringify(bytes.slice(0, 32)));
  const fromKeypair = parseWalletSecretKey(JSON.stringify(bytes));
  assert.equal(fromSeed.secretKey.length, 64);
  assert.equal(fromSeed.publicKey.length, 32);
  assert.deepEqual(fromSeed.secretKey, fromKeypair.secretKey);
  fromSeed.secretKey.fill(0);
  fromKeypair.secretKey.fill(0);

  bytes[63] ^= 1;
  assert.throws(() => parseWalletSecretKey(JSON.stringify(bytes)), /does not match/);
  assert.throws(() => parseWalletSecretKey(JSON.stringify(bytes.slice(0, 31))), /32 or 64 bytes/);
});

test('migration decrypts, validates, re-encrypts atomically, and reports only signer status', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aepa-signer-'));
  const source = path.join(directory, 'source.enc');
  const target = path.join(directory, 'target.enc');
  const plaintext = JSON.stringify(validSecret());
  writeFileSync(source, protector.encryptString(plaintext));

  const migrated = migrateEncryptedSigner(source, target, protector);
  assert.equal(migrated.configured, true);
  assert.equal(migrated.encryptionAvailable, true);
  assert.ok(migrated.publicKey);
  assert.match(migrated.publicKey, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.notEqual(readFileSync(target, 'utf8'), plaintext);
  assert.deepEqual(getSignerStatus(target, protector), migrated);
  assert.equal(existsSync(`${target}.tmp`), false);
});

test('stored signer callback exposes validated bytes only for its scope and clears them afterward', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aepa-signer-callback-'));
  const target = path.join(directory, 'target.enc');
  const plaintext = JSON.stringify(validSecret());
  writeFileSync(target, protector.encryptString(plaintext));
  let scopedBytes: Buffer | undefined;
  const publicKey = await withStoredSigner(target, protector, async (secretKey, signerPublicKey) => {
    scopedBytes = secretKey;
    assert.equal(secretKey.length, 64);
    return signerPublicKey;
  });
  assert.match(publicKey, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.ok(scopedBytes?.every((byte) => byte === 0));
});

test('status does not claim readiness when OS encryption is unavailable', () => {
  assert.deepEqual(getSignerStatus('missing', { ...protector, isEncryptionAvailable: () => false }), {
    configured: false,
    encryptionAvailable: false,
  });
});

test('signer authorization fails closed unless the stored key matches the live C4 profile authority', () => {
  const signer = { configured: true, encryptionAvailable: true, publicKey: 'AM6wrong' };
  assert.deepEqual(authorizeSignerStatus(signer, '5sHscorrect'), {
    ...signer,
    authorizedForProfile: false,
    expectedPublicKey: '5sHscorrect',
    error: 'Stored signer does not match the active C4 Player Profile authority',
  });
  assert.deepEqual(authorizeSignerStatus({ ...signer, publicKey: '5sHscorrect' }, '5sHscorrect'), {
    ...signer,
    publicKey: '5sHscorrect',
    authorizedForProfile: true,
    expectedPublicKey: '5sHscorrect',
  });
});

test('authorized signer storage rejects a wrong C4 key before writing and safely supports replace/remove', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aepa-authorized-signer-'));
  const target = path.join(directory, 'wallet-secret-key.enc');
  const first = JSON.stringify(validSecret());
  const firstParsed = parseWalletSecretKey(first);
  const firstPublicKey = encodeBase58(firstParsed.publicKey);
  firstParsed.secretKey.fill(0);

  assert.throws(() => storeAuthorizedSigner(first, target, protector, '5sHscorrect'), /does not match/);
  assert.equal(existsSync(target), false);
  const stored = storeAuthorizedSigner(first, target, protector, firstPublicKey);
  assert.equal(stored.authorizedForProfile, true);

  const second = JSON.stringify(validSecret());
  const secondParsed = parseWalletSecretKey(second);
  const secondPublicKey = encodeBase58(secondParsed.publicKey);
  secondParsed.secretKey.fill(0);
  assert.throws(() => storeAuthorizedSigner(second, target, protector, secondPublicKey), /already configured/);
  const replaced = storeAuthorizedSigner(second, target, protector, secondPublicKey, { replace: true });
  assert.equal(replaced.publicKey, secondPublicKey);
  assert.equal(replaced.authorizedForProfile, true);

  removeStoredSigner(target);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(`${target}.tmp`), false);
  assert.equal(existsSync(`${target}.bak`), false);
});
