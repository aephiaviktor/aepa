import assert from 'node:assert/strict';
import test from 'node:test';
import { getStartMiningAsteroidInstructionDataDecoder, getStopMiningAsteroidInstructionDataDecoder } from '@staratlas/dev-sage';
import { AccountRole, address } from '@solana/kit';
import { planStartMiningCopper, planStopMiningCopper } from '../src/mining-plans.js';

const a = (seed: string) => address(seed);
const authorization = { profile: a('B36ebn83M5MHknfJ6SAPVVjkw4TG9DKHB8r91f6Hnpv8'), authority: a('5sHs3Gjw43Csi9WN582iqoHUZrVZE8LhyJ7xqtcoQFCw'), keyIndex: 0 };
const fleet = a('JDwD6VCcKz1zaRws34djc3fM57P8MTwYw2i9e74UfCv1');
const game = a('EKEj47SzaCjPM3m4T4vRXrrsVtkEmiNgPMMFye3AkXj4');
const asteroid = a('BwkkW5fgeot3xjkttvSMXHXHjx3MR8B8ysJ4jB2eDRsU');

test('start mining plan encodes only Copper id 311 in the generated C4 account order', () => {
  const plan = planStartMiningCopper({ authorization, fleet, game, asteroid, character: a('6YEfNTb74aiqj4m7PA5pfTPEBb8xYybuPkX9JmWXsYXP'), system: a('BpxPzmKGBrnufxehfMm2rLWmw1MxT16DCVQDtUQkvtQr'), regionTracker: a('CbwrSoauo4D6HAJY1xuvjgCxHh3999Be68otnbThBQsi'), resourceIds: [311], fleetName: 'MF-01', asteroidName: 'Ioki', resourceName: 'Copper Ore' });
  assert.equal(plan.kind, 'fleet.mining.start');
  assert.deepEqual(plan.requiredSigners, [authorization.authority]);
  assert.equal(plan.steps[0].instruction.accounts?.length, 10);
  assert.equal(plan.steps[0].instruction.accounts?.[0].role, AccountRole.READONLY_SIGNER);
  assert.equal(plan.steps[0].instruction.accounts?.[4].address, fleet);
  assert.equal(plan.steps[0].instruction.accounts?.[8].address, asteroid);
  assert.deepEqual(getStartMiningAsteroidInstructionDataDecoder().decode(plan.steps[0].instruction.data!), { discriminator: new Uint8Array([186,215,80,30,174,226,211,33]), keyIndex: 0, resources: [311] });
});

test('start mining rejects any resource other than Copper', () => {
  assert.throws(() => planStartMiningCopper({ authorization, fleet, game, asteroid, character: authorization.profile, system: authorization.profile, regionTracker: authorization.profile, resourceIds: [309], fleetName: 'MF-01', asteroidName: 'Ioki', resourceName: 'Chromite Ore' }), /only Copper/);
});

test('stop mining plan uses optional-account sentinels and exact discriminator', () => {
  const plan = planStopMiningCopper({ authorization, fleet, game, asteroid, character: authorization.profile, fleetName: 'MF-01' });
  assert.equal(plan.kind, 'fleet.mining.stop');
  assert.equal(plan.steps[0].instruction.accounts?.length, 10);
  assert.equal(plan.steps[0].instruction.accounts?.[8].role, AccountRole.READONLY);
  assert.deepEqual(getStopMiningAsteroidInstructionDataDecoder().decode(plan.steps[0].instruction.data!), { discriminator: new Uint8Array([181,77,45,163,103,27,211,81]), keyIndex: 0 });
});

test('stop mining appends all three Career-XP budgets in deployed-program order', () => {
  const pilot = {
    userPointsAccount: a('8qbHbw2BbbTHBW1sbeqakYXVXw9fWnWj6JtQvX3C3LTM'),
    pointsCategory: a('PiLotBQoUBUvKxMrrQbuR3qDhqgwLJctWsXj3uR7fGs'),
    pointsModifierAccount: a('11111111111111111111111111111111'),
  };
  const mining = {
    userPointsAccount: a('SysvarRent111111111111111111111111111111111'),
    pointsCategory: a('MineMBxARiRdMh7s1wdStSK4Ns3YfnLjBfvF5ZCnzuw'),
    pointsModifierAccount: a('SysvarC1ock11111111111111111111111111111111'),
  };
  const councilRank = {
    userPointsAccount: a('Vote111111111111111111111111111111111111111'),
    pointsCategory: a('XPneyd1Wvoay3aAa24QiKyPjs8SUbZnGg5xvpKvTgN9'),
    pointsModifierAccount: a('Stake11111111111111111111111111111111111111'),
  };
  const progressionConfig = a('Config1111111111111111111111111111111111111');
  const pointsProgram = a('Point2iBvz7j5TMVef8nEgpmz4pDr7tU7v3RjAfkQbM');
  const plan = planStopMiningCopper({
    authorization,
    fleet,
    game,
    asteroid,
    character: authorization.profile,
    fleetName: 'MF-01',
    careerXp: { pilot, mining, councilRank, progressionConfig, pointsProgram },
  });
  const trailing = plan.steps[0].instruction.accounts!.slice(10);
  assert.equal(plan.steps[0].instruction.accounts?.length, 21);
  assert.deepEqual(trailing.map(({ address: account, role }) => [account, role]), [
    [pilot.userPointsAccount, AccountRole.WRITABLE],
    [pilot.pointsCategory, AccountRole.READONLY],
    [pilot.pointsModifierAccount, AccountRole.READONLY],
    [mining.userPointsAccount, AccountRole.WRITABLE],
    [mining.pointsCategory, AccountRole.READONLY],
    [mining.pointsModifierAccount, AccountRole.READONLY],
    [councilRank.userPointsAccount, AccountRole.WRITABLE],
    [councilRank.pointsCategory, AccountRole.READONLY],
    [councilRank.pointsModifierAccount, AccountRole.READONLY],
    [progressionConfig, AccountRole.READONLY],
    [pointsProgram, AccountRole.READONLY],
  ]);
});
