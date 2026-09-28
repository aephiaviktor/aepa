import { createSageClient, type FleetView } from "@aephia/atlas-kit";
import {
  planFleetDock,
  planFleetSettleArrival,
  planFleetSubwarp,
  planFleetUndock,
  planFleetWarpLane,
  planLoadFleetCrew,
  planUnloadFleetCrew,
} from "@aephia/atlas-kit/fleets/actions";
import { planFleetTransferCargoAtStarbase } from "@aephia/atlas-kit/cargo/actions";
import { getStarbasePlayerForCharacterAtSystem } from "@aephia/atlas-kit/starbases";
import { planRegisterStarbasePlayer } from "@aephia/atlas-kit/starbases/actions";
import type { Plan } from "@aephia/atlas-kit/planning";
import { address, createSolanaRpc } from "@solana/kit";
import type { AutomationAssignmentRecord, AepaDatabase } from "./database.js";
import type { AppSettings } from "./settings.js";
import type { AutomaticStepOutcome } from "./automation-runner.js";
import { executeGuardedPlan } from "./guarded-plan.js";
import {
  validateTransportQuantities,
  type TransportCargoAmount,
  type TransportPhase,
} from "./transport-model.js";
import {
  adaptWarpLaneCurrencyCachePlan,
  assertFreshWarpLaneCurrencyCache,
} from "./transport-plan.js";
import { ActionStageTimer, formatActionTimings } from "./action-timing.js";

const READ = { commitment: "confirmed", policy: "no-store" } as const;
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
type Client = ReturnType<typeof createSageClient>;
type Rpc = ReturnType<typeof createSolanaRpc>;
type Action =
  | "register-home"
  | "register-target"
  | "load-outbound-cargo"
  | "load-outbound-crew"
  | "undock-outbound"
  | "travel-outbound"
  | "settle-outbound"
  | "dock-target"
  | "unload-outbound-cargo"
  | "unload-outbound-crew"
  | "load-return-cargo"
  | "load-return-crew"
  | "undock-return"
  | "travel-return"
  | "settle-return"
  | "dock-home"
  | "unload-return-cargo"
  | "unload-return-crew";

async function chainClock(rpc: Rpc): Promise<bigint> {
  const result = await rpc
    .getAccountInfo(CLOCK, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!result.value) throw new Error("Canonical chain Clock is unavailable");
  const bytes = Buffer.from(result.value.data[0], "base64");
  if (bytes.length !== 40) throw new Error("Invalid chain Clock");
  return bytes.readBigInt64LE(32);
}
function same(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x === b.x && a.y === b.y;
}
function cargoAmount(fleet: FleetView, id: number) {
  return fleet.cargoHold.items.find((item) => item.id === id)?.amount ?? 0n;
}
function raw(values: readonly TransportCargoAmount[] | undefined) {
  return (values ?? []).map((value) => ({
    cargoId: value.cargoId,
    amount: BigInt(value.amountRaw),
  }));
}
function normalize(phase: TransportPhase): TransportPhase {
  if (phase === "load-outbound") return "load-outbound-cargo";
  if (phase === "service-target") return "unload-outbound-cargo";
  if (phase === "travel-return") return "travel-return";
  if (phase === "service-home") return "unload-return-cargo";
  return phase;
}
function next(action: Action): TransportPhase {
  const map: Record<Action, TransportPhase> = {
    "register-home": "load-outbound-cargo",
    "register-target": "unload-outbound-cargo",
    "load-outbound-cargo": "load-outbound-crew",
    "load-outbound-crew": "undock-outbound",
    "undock-outbound": "travel-outbound",
    "travel-outbound": "settle-outbound",
    "settle-outbound": "dock-target",
    "dock-target": "unload-outbound-cargo",
    "unload-outbound-cargo": "unload-outbound-crew",
    "unload-outbound-crew": "load-return-cargo",
    "load-return-cargo": "load-return-crew",
    "load-return-crew": "undock-return",
    "undock-return": "travel-return",
    "travel-return": "settle-return",
    "settle-return": "dock-home",
    "dock-home": "unload-return-cargo",
    "unload-return-cargo": "unload-return-crew",
    "unload-return-crew": "load-outbound-cargo",
  };
  return map[action];
}

async function observe(
  client: Client,
  rpc: Rpc,
  settings: AppSettings,
  assignment: AutomationAssignmentRecord,
) {
  if (assignment.assignment !== "transport")
    throw new Error("Expected a Transport assignment");
  const profileAddress = address(settings.playerProfile);
  const [fleet, profile, character, home, target, now] = await Promise.all([
    client.fleets.get(address(assignment.fleetAddress), READ),
    client.profiles.get(profileAddress, READ),
    client.characters.forProfile(profileAddress, READ),
    client.systems.byId(assignment.homeSystemId, READ),
    client.systems.get(address(assignment.destinationAddress), READ),
    chainClock(rpc),
  ]);
  if (
    fleet.name !== assignment.fleetName ||
    fleet.ownerProfile.address !== profileAddress ||
    String(home.address) !== assignment.homeSystemAddress
  )
    throw new Error("Transport Fleet/Profile/route identity mismatch");
  const keyIndex = profile.keys.findIndex(
    (key) => key.expiresAt === undefined || key.expiresAt > now,
  );
  if (keyIndex < 0) throw new Error("No active Profile authority");
  const authorization = {
    profile: profileAddress,
    authority: profile.keys[keyIndex]!.address,
    keyIndex,
  };
  const atHome =
    fleet.state.kind === "docked"
      ? fleet.state.system.address === home.address
      : same(fleet.location, home.coordinates);
  const atTarget =
    fleet.state.kind === "docked"
      ? fleet.state.system.address === target.address
      : same(fleet.location, target.coordinates);
  const starbase = async (system: typeof home) => {
    try {
      return await getStarbasePlayerForCharacterAtSystem(
        client.context,
        character.address,
        system.address,
        READ,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ACCOUNT_NOT_FOUND")
        return undefined;
      throw error;
    }
  };
  const [homePlayer, targetPlayer] = await Promise.all([
    starbase(home),
    starbase(target),
  ]);
  return {
    fleet,
    character,
    home,
    target,
    now,
    authorization,
    atHome,
    atTarget,
    homePlayer,
    targetPlayer,
  };
}
type Observation = Awaited<ReturnType<typeof observe>>;

function amountsForLoad(
  observed: Observation,
  configured: readonly TransportCargoAmount[],
  player: NonNullable<Observation["homePlayer"]>,
) {
  return validateTransportQuantities({
    requested: configured,
    available: player.cargo.items.map((item) => ({
      cargoId: item.id,
      amountRaw: item.quantityRaw.toString(),
    })),
    storageCostByCargoId: new Map(
      player.cargo.items.map((item) => [item.id, BigInt(item.storageCost)]),
    ),
    remainingStorageRaw: observed.fleet.capacities.cargo.remaining,
  });
}

async function planAction(
  client: Client,
  observed: Observation,
  assignment: AutomationAssignmentRecord,
  action: Action,
): Promise<Plan> {
  const options = { authorization: observed.authorization };
  switch (action) {
    case "register-home":
      return planRegisterStarbasePlayer(
        client.context,
        observed.character,
        observed.home,
        { funder: observed.authorization.authority },
      );
    case "register-target":
      return planRegisterStarbasePlayer(
        client.context,
        observed.character,
        observed.target,
        { funder: observed.authorization.authority },
      );
    case "undock-outbound":
    case "undock-return":
      return planFleetUndock(client.context, observed.fleet, options);
    case "dock-target":
    case "dock-home":
      return planFleetDock(client.context, observed.fleet, options);
    case "settle-outbound":
    case "settle-return":
      return planFleetSettleArrival(client.context, observed.fleet, options);
    case "travel-outbound":
    case "travel-return": {
      const destination =
        action === "travel-outbound" ? observed.target : observed.home;
      return assignment.travelMode === "warp-lane"
        ? planFleetWarpLane(client.context, observed.fleet, {
            ...options,
            destinationSystem: destination.address,
          })
        : planFleetSubwarp(client.context, observed.fleet, {
            ...options,
            destination: destination.coordinates,
          });
    }
    case "load-outbound-cargo":
    case "load-return-cargo": {
      const player =
        action === "load-outbound-cargo"
          ? observed.homePlayer
          : observed.targetPlayer;
      if (!player)
        throw new Error("Transport source Starbase Player is not registered");
      const configured =
        action === "load-outbound-cargo"
          ? (assignment.cargoOut ?? [])
          : (assignment.cargoBack ?? []);
      const cargoHold = amountsForLoad(observed, configured, player);
      const fuel =
        action === "load-outbound-cargo"
          ? observed.fleet.capacities.fuel.remaining
          : 0n;
      if (!cargoHold.length && fuel === 0n)
        throw new Error("No cargo or fuel remains to load");
      return planFleetTransferCargoAtStarbase(client.context, observed.fleet, {
        ...options,
        direction: "toFleet",
        amounts: {
          ...(fuel > 0n ? { fuel } : {}),
          ...(cargoHold.length ? { cargoHold } : {}),
        },
      });
    }
    case "unload-outbound-cargo":
    case "unload-return-cargo": {
      const cargoHold = raw(
        action === "unload-outbound-cargo"
          ? assignment.cargoOut
          : assignment.cargoBack,
      );
      return planFleetTransferCargoAtStarbase(client.context, observed.fleet, {
        ...options,
        direction: "toStarbase",
        amounts: { cargoHold },
      });
    }
    case "load-outbound-crew":
      return planLoadFleetCrew(client.context, observed.fleet.address, {
        ...options,
        count: assignment.crewOut!,
      });
    case "load-return-crew":
      return planLoadFleetCrew(client.context, observed.fleet.address, {
        ...options,
        count: assignment.crewBack!,
      });
    case "unload-outbound-crew":
      return planUnloadFleetCrew(client.context, observed.fleet.address, {
        ...options,
        count: assignment.crewOut!,
      });
    case "unload-return-crew":
      return planUnloadFleetCrew(client.context, observed.fleet.address, {
        ...options,
        count: assignment.crewBack!,
      });
  }
}

async function postcondition(
  client: Client,
  before: Observation,
  assignment: AutomationAssignmentRecord,
  action: Action,
) {
  if (action === "register-home" || action === "register-target") {
    const system = action === "register-home" ? before.home : before.target;
    await getStarbasePlayerForCharacterAtSystem(
      client.context,
      before.character.address,
      system.address,
      READ,
    );
    return true;
  }
  const fleet = await client.fleets.get(before.fleet.address, READ);
  if (action.startsWith("undock-")) return fleet.state.kind === "idle";
  if (action === "dock-target")
    return (
      fleet.state.kind === "docked" &&
      fleet.state.system.address === before.target.address
    );
  if (action === "dock-home")
    return (
      fleet.state.kind === "docked" &&
      fleet.state.system.address === before.home.address
    );
  if (action.startsWith("travel-")) {
    const target = action === "travel-outbound" ? before.target : before.home;
    return (
      (fleet.state.kind === "subwarp" || fleet.state.kind === "warp") &&
      same(fleet.state.to, target.coordinates)
    );
  }
  if (action.startsWith("settle-")) {
    const target = action === "settle-outbound" ? before.target : before.home;
    return (
      fleet.state.kind === "idle" && same(fleet.location, target.coordinates)
    );
  }
  if (action.includes("crew")) {
    const amount = action.includes("outbound")
      ? (assignment.crewOut ?? 0)
      : (assignment.crewBack ?? 0);
    return (
      fleet.crewCount ===
      before.fleet.crewCount + (action.startsWith("load-") ? amount : -amount)
    );
  }
  const configured = action.includes("outbound")
    ? (assignment.cargoOut ?? [])
    : (assignment.cargoBack ?? []);
  const sign = action.startsWith("load-") ? 1n : -1n;
  return (
    configured.every(
      (item) =>
        cargoAmount(fleet, item.cargoId) ===
        cargoAmount(before.fleet, item.cargoId) + sign * BigInt(item.amountRaw),
    ) &&
    (action !== "load-outbound-cargo" ||
      fleet.fuel.amount ===
        before.fleet.fuel.amount + before.fleet.capacities.fuel.remaining)
  );
}

type ExpectedPostState =
  | { kind: "registered"; system: "home" | "target" }
  | { kind: "state"; state: "idle" | "docked"; system?: string }
  | { kind: "move"; to: { x: number; y: number } }
  | { kind: "crew"; count: number }
  | { kind: "cargo"; amounts: Record<string, string>; fuel?: string };
function expectedPost(
  observed: Observation,
  assignment: AutomationAssignmentRecord,
  action: Action,
): ExpectedPostState {
  if (action === "register-home" || action === "register-target")
    return {
      kind: "registered",
      system: action === "register-home" ? "home" : "target",
    };
  if (action.startsWith("undock-")) return { kind: "state", state: "idle" };
  if (action === "dock-target")
    return {
      kind: "state",
      state: "docked",
      system: String(observed.target.address),
    };
  if (action === "dock-home")
    return {
      kind: "state",
      state: "docked",
      system: String(observed.home.address),
    };
  if (action.startsWith("travel-") || action.startsWith("settle-")) {
    const target = action.includes("outbound")
      ? observed.target
      : observed.home;
    return { kind: "move", to: target.coordinates };
  }
  if (action.includes("crew")) {
    const amount = action.includes("outbound")
      ? (assignment.crewOut ?? 0)
      : (assignment.crewBack ?? 0);
    return {
      kind: "crew",
      count:
        observed.fleet.crewCount +
        (action.startsWith("load-") ? amount : -amount),
    };
  }
  const configured = action.includes("outbound")
    ? (assignment.cargoOut ?? [])
    : (assignment.cargoBack ?? []);
  const sign = action.startsWith("load-") ? 1n : -1n;
  const amounts = Object.fromEntries(
    configured.map((item) => [
      String(item.cargoId),
      (
        cargoAmount(observed.fleet, item.cargoId) +
        sign * BigInt(item.amountRaw)
      ).toString(),
    ]),
  );
  return {
    kind: "cargo",
    amounts,
    ...(action === "load-outbound-cargo"
      ? {
          fuel: (
            observed.fleet.fuel.amount +
            observed.fleet.capacities.fuel.remaining
          ).toString(),
        }
      : {}),
  };
}
function expectedObserved(
  observed: Observation,
  expected: ExpectedPostState,
): boolean {
  if (expected.kind === "registered")
    return expected.system === "home"
      ? !!observed.homePlayer
      : !!observed.targetPlayer;
  if (expected.kind === "state")
    return expected.state === "idle"
      ? observed.fleet.state.kind === "idle"
      : observed.fleet.state.kind === "docked" &&
          String(observed.fleet.state.system.address) === expected.system;
  if (expected.kind === "move")
    return (
      ((observed.fleet.state.kind === "subwarp" ||
        observed.fleet.state.kind === "warp") &&
        same(observed.fleet.state.to, expected.to)) ||
      same(observed.fleet.location, expected.to)
    );
  if (expected.kind === "crew")
    return observed.fleet.crewCount === expected.count;
  return (
    Object.entries(expected.amounts).every(
      ([id, amount]) =>
        cargoAmount(observed.fleet, Number(id)) === BigInt(amount),
    ) &&
    (expected.fuel === undefined ||
      observed.fleet.fuel.amount === BigInt(expected.fuel))
  );
}

function phaseAction(
  observed: Observation,
  assignment: AutomationAssignmentRecord,
  phase: TransportPhase,
): {
  action?: Action;
  phase?: TransportPhase;
  wait?: bigint;
  stopped?: boolean;
} {
  phase = normalize(phase);
  if (observed.atHome && observed.fleet.state.kind === "docked") {
    if (phase === "load-outbound-cargo" && assignment.stopMode)
      return { stopped: true };
    if (assignment.stopMode === "now" && phase === "load-outbound-crew")
      return { phase: "stop-unload-outbound-cargo-only" };
    if (assignment.stopMode === "now" && phase === "undock-outbound")
      return { phase: "stop-unload-outbound-cargo" };
  }
  if (
    observed.fleet.state.kind === "subwarp" ||
    observed.fleet.state.kind === "warp"
  ) {
    if (observed.now < observed.fleet.state.arrivesAtUnixSeconds)
      return { wait: observed.fleet.state.arrivesAtUnixSeconds };
    if (observed.fleet.state.kind === "subwarp")
      return {
        action: phase.includes("return") ? "settle-return" : "settle-outbound",
      };
    return { action: phase.includes("return") ? "dock-home" : "dock-target" };
  }
  if (phase === "load-outbound-cargo") {
    if (!observed.atHome) return { phase: "settle-outbound" };
    if (observed.fleet.state.kind !== "docked") return { action: "dock-home" };
    if (!observed.homePlayer) return { action: "register-home" };
    if (
      !(assignment.cargoOut ?? []).length &&
      observed.fleet.capacities.fuel.remaining === 0n
    )
      return { phase: "load-outbound-crew" };
    return { action: "load-outbound-cargo" };
  }
  if (phase === "load-outbound-crew")
    return (assignment.crewOut ?? 0) > 0
      ? { action: "load-outbound-crew" }
      : { phase: "undock-outbound" };
  if (phase === "undock-outbound") {
    if (observed.fleet.crewCount < observed.fleet.stats.misc.requiredCrew)
      throw new Error(
        `Fleet requires ${observed.fleet.stats.misc.requiredCrew} operating crew before departure`,
      );
    if (
      observed.fleet.crewCount - observed.fleet.stats.misc.requiredCrew >
      observed.fleet.stats.misc.passengerCapacity
    )
      throw new Error(
        "Transport passengers exceed current Fleet passenger capacity",
      );
    return observed.fleet.state.kind === "idle"
      ? { phase: "travel-outbound" }
      : { action: "undock-outbound" };
  }
  if (phase === "travel-outbound")
    return observed.atTarget
      ? { phase: "dock-target" }
      : { action: "travel-outbound" };
  if (phase === "settle-outbound")
    return observed.atTarget
      ? { phase: "dock-target" }
      : { action: "settle-outbound" };
  if (phase === "dock-target") {
    if (observed.fleet.state.kind !== "docked")
      return { action: "dock-target" };
    if (!observed.targetPlayer) return { action: "register-target" };
    return { phase: "unload-outbound-cargo" };
  }
  if (phase === "unload-outbound-cargo")
    return (assignment.cargoOut ?? []).length
      ? { action: "unload-outbound-cargo" }
      : { phase: "unload-outbound-crew" };
  if (phase === "unload-outbound-crew")
    return (assignment.crewOut ?? 0) > 0
      ? { action: "unload-outbound-crew" }
      : { phase: "load-return-cargo" };
  if (phase === "load-return-cargo")
    return (assignment.cargoBack ?? []).length
      ? { action: "load-return-cargo" }
      : { phase: "load-return-crew" };
  if (phase === "load-return-crew")
    return (assignment.crewBack ?? 0) > 0
      ? { action: "load-return-crew" }
      : { phase: "undock-return" };
  if (phase === "undock-return") {
    if (observed.fleet.crewCount < observed.fleet.stats.misc.requiredCrew)
      throw new Error(
        `Fleet requires ${observed.fleet.stats.misc.requiredCrew} operating crew before departure`,
      );
    if (
      observed.fleet.crewCount - observed.fleet.stats.misc.requiredCrew >
      observed.fleet.stats.misc.passengerCapacity
    )
      throw new Error(
        "Transport passengers exceed current Fleet passenger capacity",
      );
    return observed.fleet.state.kind === "idle"
      ? { phase: "travel-return" }
      : { action: "undock-return" };
  }
  if (phase === "travel-return")
    return observed.atHome
      ? { phase: "dock-home" }
      : { action: "travel-return" };
  if (phase === "settle-return")
    return observed.atHome
      ? { phase: "dock-home" }
      : { action: "settle-return" };
  if (phase === "dock-home")
    return observed.fleet.state.kind === "docked"
      ? { phase: "unload-return-cargo" }
      : { action: "dock-home" };
  if (phase === "unload-return-cargo")
    return (assignment.cargoBack ?? []).length
      ? { action: "unload-return-cargo" }
      : { phase: "unload-return-crew" };
  if (phase === "unload-return-crew")
    return (assignment.crewBack ?? 0) > 0
      ? { action: "unload-return-crew" }
      : assignment.stopMode
        ? { stopped: true }
        : { phase: "load-outbound-cargo" };
  if (phase === "stop-unload-outbound-cargo")
    return (assignment.cargoOut ?? []).length
      ? { action: "unload-outbound-cargo" }
      : { phase: "stop-unload-outbound-crew" };
  if (phase === "stop-unload-outbound-cargo-only")
    return (assignment.cargoOut ?? []).length
      ? { action: "unload-outbound-cargo" }
      : { stopped: true };
  if (phase === "stop-unload-outbound-crew")
    return (assignment.crewOut ?? 0) > 0
      ? { action: "unload-outbound-crew" }
      : { stopped: true };
  return { phase: "load-outbound-cargo" };
}

export async function executeNextTransportStepOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  assignment: AutomationAssignmentRecord,
  database: AepaDatabase,
): Promise<AutomaticStepOutcome> {
  const timer = new ActionStageTimer();
  const rpc = createSolanaRpc(settings.rpcUrl);
  const client = createSageClient({ cluster: "zink-ptr", rpc, writeRpc: rpc });
  try {
    let runtime = database.getTransportRuntime(
      assignment.profile,
      assignment.fleetAddress,
    );
    let phase = runtime.phase;
    for (let transitions = 0; transitions < 20; transitions++) {
      const observed = await observe(client, rpc, settings, assignment);
      timer.complete("observation");
      const decision = phaseAction(observed, assignment, phase);
      if (runtime.attemptAction) {
        if (!expectedObserved(observed, runtime.expected as ExpectedPostState))
          throw new Error(
            `Persisted Transport attempt ${runtime.attemptAction} is unresolved; chain state does not prove success and it must not be retried automatically`,
          );
        phase =
          phase === "stop-unload-outbound-cargo"
            ? "stop-unload-outbound-crew"
            : phase === "stop-unload-outbound-cargo-only" ||
                phase === "stop-unload-outbound-crew"
              ? "load-outbound-cargo"
              : next(runtime.attemptAction as Action);
        database.setTransportPhase(
          assignment.profile,
          assignment.fleetAddress,
          phase,
        );
        runtime = { phase };
        continue;
      }
      if (decision.stopped)
        return {
          kind: "stopped",
          detail: "Transport Fleet is docked and serviced at Home Starbase",
        };
      if (decision.wait !== undefined)
        return {
          kind: "waiting",
          untilUnixSeconds: decision.wait,
          detail: `Transport arrival expected at ${decision.wait}`,
        };
      if (decision.phase) {
        phase = decision.phase;
        database.setTransportPhase(
          assignment.profile,
          assignment.fleetAddress,
          phase,
        );
        runtime = { phase };
        continue;
      }
      const action = decision.action!;
      let plan = await planAction(client, observed, assignment, action);
      let currencyCache: Awaited<ReturnType<typeof adaptWarpLaneCurrencyCachePlan>> | undefined;
      if (plan.kind === "fleet.warp-lane") {
        const game = client.context.game;
        if (!game) throw new Error("Configured C4 Game is unavailable");
        currencyCache = await adaptWarpLaneCurrencyCachePlan(plan, game);
        plan = currencyCache.plan;
      }
      timer.complete("planning");
      const expected = expectedPost(observed, assignment, action);
      const result = await executeGuardedPlan({
        settings,
        context: client.context,
        rpc,
        plan,
        authority: observed.authorization.authority,
        secretKey,
        fleetAddress: assignment.fleetAddress,
        beforeSubmission: currencyCache
          ? () => assertFreshWarpLaneCurrencyCache(rpc, currencyCache.currencyCache)
          : undefined,
        onSubmission: () => database.setTransportAttempt(
          assignment.profile,
          assignment.fleetAddress,
          phase,
          action,
          expected,
        ),
        observeConfirmed: () =>
          postcondition(client, observed, assignment, action),
        timer,
      });
      const nextPhase =
        phase === "stop-unload-outbound-cargo"
          ? "stop-unload-outbound-crew"
          : phase === "stop-unload-outbound-cargo-only" ||
              phase === "stop-unload-outbound-crew"
            ? "load-outbound-cargo"
            : next(action);
      database.setTransportPhase(
        assignment.profile,
        assignment.fleetAddress,
        nextPhase,
      );
      return {
        kind: "confirmed",
        action,
        signature: result.signature,
        detail: `${plan.summary}; confirmed at slot ${result.slot}; ${formatActionTimings(result.timings)}`,
        continueImmediately: true,
      };
    }
    throw new Error(
      "Transport phase reconciliation exceeded its safe transition limit",
    );
  } finally {
    await client.dispose();
  }
}
