export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export interface MiningFoodInput {
  cargoCapacityRaw: bigint;
  preservedCargoStorageRaw: bigint;
  copperStoragePerUnit: Rational;
  foodStoragePerUnit: Rational;
  copperUnitsPerSecond: Rational;
  foodUnitsPerSecond: Rational;
  ammoAmountRaw: bigint;
  ammoUnitsPerSecond: Rational;
}

export interface MiningFoodPlan {
  limitingEvent: 'cargo' | 'ammo' | 'simultaneous';
  targetMiningSeconds: Rational;
  foodForCargoRaw: bigint;
  foodForAmmoRaw: bigint;
  foodToLoadRaw: bigint;
  copperAtStopRaw: bigint;
  cargoStorageAtStopRaw: bigint;
  unavoidableFoodRoundingRaw: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator <= 0n) throw new RangeError('Rational denominator must be positive');
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function requirePositive(value: Rational, label: string): Rational {
  if (value.numerator <= 0n || value.denominator <= 0n) throw new RangeError(`${label} must be positive`);
  return rational(value.numerator, value.denominator);
}

function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

function compare(a: Rational, b: Rational): number {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function floor(value: Rational): bigint {
  return value.numerator / value.denominator;
}

function ceil(value: Rational): bigint {
  return (value.numerator + value.denominator - 1n) / value.denominator;
}

function storageForUnits(units: bigint, storagePerUnit: Rational): bigint {
  return ceil(rational(units * storagePerUnit.numerator, storagePerUnit.denominator));
}

/**
 * Calculates a zero-policy-reserve Food load for one mining trip.
 *
 * Food is loaded only into cargo. Ammo and Fuel are deliberately absent from
 * this contract because they belong in their dedicated Fleet banks. The two
 * candidate stopping times are cargo-full and ammo-empty; the earlier event
 * determines the minimum sufficient integer Food quantity.
 */
export function calculateMiningFoodPlan(input: MiningFoodInput): MiningFoodPlan {
  if (input.cargoCapacityRaw <= 0n) throw new RangeError('Cargo capacity must be positive');
  if (input.preservedCargoStorageRaw < 0n || input.preservedCargoStorageRaw >= input.cargoCapacityRaw) {
    throw new RangeError('Preserved cargo must be non-negative and smaller than cargo capacity');
  }
  if (input.ammoAmountRaw < 0n) throw new RangeError('Ammo amount must be non-negative');

  const copperStorage = requirePositive(input.copperStoragePerUnit, 'Copper storage per unit');
  const foodStorage = requirePositive(input.foodStoragePerUnit, 'Food storage per unit');
  const copperRate = requirePositive(input.copperUnitsPerSecond, 'Copper rate');
  const foodRate = requirePositive(input.foodUnitsPerSecond, 'Food rate');
  const ammoRate = requirePositive(input.ammoUnitsPerSecond, 'Ammo rate');

  const availableStorage = input.cargoCapacityRaw - input.preservedCargoStorageRaw;
  const copperAtCargoLimit = floor(rational(availableStorage * copperStorage.denominator, copperStorage.numerator));
  if (copperAtCargoLimit <= 0n) throw new RangeError('No usable cargo capacity remains for Copper');

  const timeCargo = rational(copperAtCargoLimit * copperRate.denominator, copperRate.numerator);
  const timeAmmo = rational(input.ammoAmountRaw * ammoRate.denominator, ammoRate.numerator);
  const foodForCargoRaw = ceil(multiply(foodRate, timeCargo));
  const foodForAmmoRaw = ceil(multiply(foodRate, timeAmmo));
  const ordering = compare(timeCargo, timeAmmo);
  const limitingEvent = ordering < 0 ? 'cargo' : ordering > 0 ? 'ammo' : 'simultaneous';
  const targetMiningSeconds = ordering <= 0 ? timeCargo : timeAmmo;
  const foodToLoadRaw = ordering <= 0 ? foodForCargoRaw : foodForAmmoRaw;

  if (storageForUnits(foodToLoadRaw, foodStorage) > availableStorage) {
    throw new RangeError('Food required for the limiting event does not fit in the usable cargo capacity');
  }

  const copperAtStopRaw = ordering <= 0
    ? copperAtCargoLimit
    : floor(multiply(copperRate, targetMiningSeconds));
  const cargoStorageAtStopRaw = input.preservedCargoStorageRaw + storageForUnits(copperAtStopRaw, copperStorage);
  const exactFoodConsumed = multiply(foodRate, targetMiningSeconds);

  return {
    limitingEvent,
    targetMiningSeconds,
    foodForCargoRaw,
    foodForAmmoRaw,
    foodToLoadRaw,
    copperAtStopRaw,
    cargoStorageAtStopRaw,
    unavoidableFoodRoundingRaw: foodToLoadRaw - floor(exactFoodConsumed),
  };
}

export interface MultiResourceFoodInput extends Omit<MiningFoodInput, 'copperStoragePerUnit' | 'copperUnitsPerSecond'> {
  fleetUnitsPerSecond: Rational;
  resources: readonly { id: number; richness: Rational; storagePerUnit: Rational }[];
}

/** Split fleet effort equally; combine storage rates, not unweighted item counts.
 * Reserve one Food storage unit for unavoidable integer consumption rounding.
 */
export function calculateMultiResourceFoodPlan(input: MultiResourceFoodInput) {
  if (input.resources.length < 1 || input.resources.length > 8 || new Set(input.resources.map(r => r.id)).size !== input.resources.length) {
    throw new RangeError('Select one to eight unique resources');
  }
  const fleetRate = requirePositive(input.fleetUnitsPerSecond, 'Fleet mining rate');
  let storageRate = rational(0n, 1n);
  const outputs = input.resources.map(resource => {
    const rate = multiply(fleetRate, requirePositive(resource.richness, 'Resource richness'));
    const unitsPerSecond = rational(rate.numerator, rate.denominator * BigInt(input.resources.length));
    const storage = multiply(unitsPerSecond, requirePositive(resource.storagePerUnit, 'Resource storage'));
    storageRate = rational(storageRate.numerator * storage.denominator + storage.numerator * storageRate.denominator, storageRate.denominator * storage.denominator);
    return { ...resource, unitsPerSecond };
  });
  const roundingStorage = storageForUnits(1n, requirePositive(input.foodStoragePerUnit, 'Food storage'));
  const plan = calculateMiningFoodPlan({ ...input, preservedCargoStorageRaw: input.preservedCargoStorageRaw + roundingStorage,
    copperStoragePerUnit: rational(1n, 1n), copperUnitsPerSecond: storageRate });
  const seconds = floor(plan.targetMiningSeconds);
  if (seconds < 1n) throw new RangeError('No safe whole second of mining fits');
  const targetMiningSeconds = rational(seconds, 1n);
  const foodToLoadRaw = ceil(multiply(input.foodUnitsPerSecond, targetMiningSeconds));
  const projected = outputs.map(output => ({ ...output, amountRaw: floor(multiply(output.unitsPerSecond, targetMiningSeconds)) }));
  const totalOutputRaw = projected.reduce((sum, output) => sum + output.amountRaw, 0n);
  const cargoStorageAtStopRaw = input.preservedCargoStorageRaw + roundingStorage + projected.reduce((sum, output) => sum + storageForUnits(output.amountRaw, output.storagePerUnit), 0n);
  if (cargoStorageAtStopRaw > input.cargoCapacityRaw) throw new RangeError('Rounded resource cargo exceeds capacity');
  return { ...plan, targetMiningSeconds, foodToLoadRaw, copperAtStopRaw: totalOutputRaw, cargoStorageAtStopRaw, outputs: projected };
}
