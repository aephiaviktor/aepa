import {
  isRoundTripReachable,
  type FleetTravelCapability,
} from "./automation-options.js";

export interface TransportCargoAmount {
  cargoId: number;
  amountRaw: string;
}

export interface TransportSystem {
  address: string;
  name: string;
  systemId: number;
  coordinates: { x: number; y: number };
  connections: readonly number[];
}

export type TransportTravelMode = "subwarp" | "warp-lane";

export function rankTransportTargets<T extends TransportSystem>(input: {
  home: T;
  systems: readonly T[];
  fleet: FleetTravelCapability;
  travelMode: TransportTravelMode;
}): Array<T & { distance: number }> {
  return input.systems
    .filter((system) => system.address !== input.home.address)
    .map((system) => ({
      ...system,
      distance: Math.hypot(
        system.coordinates.x - input.home.coordinates.x,
        system.coordinates.y - input.home.coordinates.y,
      ),
    }))
    .filter((system) =>
      isRoundTripReachable(input.travelMode, system.distance, input.fleet),
    )
    .filter(
      (system) =>
        input.travelMode !== "warp-lane" ||
        (input.home.connections.includes(system.systemId) &&
          system.connections.includes(input.home.systemId)),
    )
    .sort(
      (left, right) =>
        left.distance - right.distance || left.name.localeCompare(right.name),
    );
}

export function projectedReturnAvailability(
  target: readonly TransportCargoAmount[],
  outbound: readonly TransportCargoAmount[],
): Array<{ cargoId: number; liveRaw: string; projectedRaw: string }> {
  const live = new Map(
    target.map((value) => [
      value.cargoId,
      parseRaw(value.amountRaw, "available cargo"),
    ]),
  );
  const delivered = new Map(
    outbound.map((value) => [
      value.cargoId,
      parseRaw(value.amountRaw, "outbound cargo"),
    ]),
  );
  return [...new Set([...live.keys(), ...delivered.keys()])]
    .sort((a, b) => a - b)
    .map((cargoId) => ({
      cargoId,
      liveRaw: (live.get(cargoId) ?? 0n).toString(),
      projectedRaw: (
        (live.get(cargoId) ?? 0n) + (delivered.get(cargoId) ?? 0n)
      ).toString(),
    }));
}

function parseRaw(value: string, label: string): bigint {
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`${label} amount must be a positive whole raw quantity`);
  const amount = BigInt(value);
  if (amount > 18_446_744_073_709_551_615n)
    throw new Error(`${label} amount exceeds unsigned u64`);
  return amount;
}

export function validateTransportQuantities(input: {
  requested: readonly TransportCargoAmount[];
  available: readonly TransportCargoAmount[];
  storageCostByCargoId: ReadonlyMap<number, bigint>;
  remainingStorageRaw: bigint;
}): Array<{ cargoId: number; amount: bigint }> {
  if (
    new Set(input.requested.map((value) => value.cargoId)).size !==
    input.requested.length
  )
    throw new Error("Cargo selections must be unique");
  const available = new Map(
    input.available.map((value) => [value.cargoId, BigInt(value.amountRaw)]),
  );
  let requiredStorage = 0n;
  const amounts = input.requested.map((value) => {
    if (
      !Number.isSafeInteger(value.cargoId) ||
      value.cargoId < 0 ||
      value.cargoId > 65_535
    )
      throw new Error("Cargo id must be an unsigned u16");
    const amount = parseRaw(value.amountRaw, "Cargo");
    if (amount > (available.get(value.cargoId) ?? 0n))
      throw new Error(
        `Requested cargo ${value.cargoId} exceeds currently available balance`,
      );
    const storageCost = input.storageCostByCargoId.get(value.cargoId);
    if (storageCost === undefined || storageCost < 0n)
      throw new Error(`Cargo ${value.cargoId} has no valid storage cost`);
    // Cargo definition storageCost is encoded at scale 256 while Fleet
    // capacity is already in whole storage units. Round each row upward.
    requiredStorage += (amount * storageCost + 255n) / 256n;
    return { cargoId: value.cargoId, amount };
  });
  if (requiredStorage > input.remainingStorageRaw)
    throw new Error("Requested cargo exceeds Fleet cargo capacity");
  return amounts;
}

export type TransportPhase =
  | "load-outbound"
  | "travel-outbound"
  | "service-target"
  | "travel-return"
  | "service-home"
  | "load-outbound-cargo"
  | "load-outbound-crew"
  | "undock-outbound"
  | "settle-outbound"
  | "dock-target"
  | "unload-outbound-cargo"
  | "unload-outbound-crew"
  | "load-return-cargo"
  | "load-return-crew"
  | "undock-return"
  | "settle-return"
  | "dock-home"
  | "unload-return-cargo"
  | "unload-return-crew"
  | "stop-unload-outbound-cargo"
  | "stop-unload-outbound-cargo-only"
  | "stop-unload-outbound-crew";
export type TransportAction =
  | "load-outbound"
  | "undock-outbound"
  | "travel-outbound"
  | "settle-outbound"
  | "dock-target"
  | "unload-outbound"
  | "load-return"
  | "undock-return"
  | "travel-return"
  | "settle-return"
  | "dock-home"
  | "unload-return"
  | "cycle-complete"
  | "wait";

export function decideTransportStep(input: {
  phase: TransportPhase;
  location: "home" | "target" | "other";
  fleetState: "docked" | "idle" | "moving";
  outboundLoaded: boolean;
  outboundUnloaded: boolean;
  returnLoaded: boolean;
  returnUnloaded: boolean;
}): TransportAction {
  if (input.fleetState === "moving") return "wait";
  if (input.location === "home") {
    if (input.fleetState === "docked") {
      if (!input.returnUnloaded) return "unload-return";
      if (!input.outboundLoaded) return "load-outbound";
      return "undock-outbound";
    }
    return input.phase === "travel-return" ? "dock-home" : "travel-outbound";
  }
  if (input.location === "target") {
    if (input.fleetState === "idle")
      return input.phase === "travel-outbound"
        ? "dock-target"
        : "travel-return";
    if (!input.outboundUnloaded) return "unload-outbound";
    if (!input.returnLoaded) return "load-return";
    return "undock-return";
  }
  return input.phase === "travel-return" ? "settle-return" : "settle-outbound";
}
