/** Explicit operator acknowledgement, not automatic replay or proof of intent.
 * Disable durably before releasing the barrier; a crash leaves automation off. */
export async function recoverPausedOperation(evidence: string, hooks: {
  inspect(): Promise<void>;
  disable(): Promise<void>;
  resolve(): Promise<void>;
}): Promise<void> {
  if (evidence !== 'finalized-success' && evidence !== 'finalized-failure') {
    throw new Error('Recovery requires matching finalized transaction evidence; operation remains blocked');
  }
  await hooks.inspect();
  await hooks.disable();
  await hooks.resolve();
}
