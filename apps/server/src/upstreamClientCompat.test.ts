// Decodes upstream clients' requests with the fork's schemas and the fork's mapped responses with
// upstream's, bundled in upstreamClientCompat.snapshot.js at the commit on its first line. After each
// upstream merge: `git fetch upstream && vp run upstream-contracts:refresh`, then rerun this file.
// The rule, the checks and how to fix a failure: docs/internals/fork-wire-compatibility.md.
import { describe, expect, it } from "@effect/vitest";
import {
  ASSISTANT_TEXT_PARTS_CAPABILITY,
  AUTOMATIONS_CLIENT_CAPABILITY,
  EnvironmentHttpApi,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
  ExecutionEnvironmentDescriptor,
  PEER_LINK_UNAUTHORIZED_STATUS_CAPABILITY,
  PeerLinkSummary,
  SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY,
  SCHEDULED_TASK_SKIPPED_STATUS_CAPABILITY,
  ScheduledTask,
  ScheduledTaskError,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  TERMINAL_WORKSPACE_CHANGED_ERROR_CAPABILITY,
  TerminalCwdStatError,
  TerminalWorkspaceChangedError,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

import * as PinnedUpstream from "./upstreamClientCompat.snapshot.js";
import type * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import {
  errorForClient,
  hidesScheduledTask,
  readClientWireCapabilities,
  responseForClient,
  scheduledTasksForClient,
  threadHistoryPageForClient,
  type ClientWireCapabilities,
} from "./upstreamClientCompat.ts";

// A probe bundle from `UPSTREAM_SNAPSHOT=<absolute path> vp run upstream-contracts:refresh <ref>`. It
// resolves effect from its own directory, so write it under apps/server/node_modules/.cache.
const Upstream: typeof PinnedUpstream =
  process.env.UPSTREAM_SNAPSHOT === undefined
    ? PinnedUpstream
    : await import(process.env.UPSTREAM_SNAPSHOT);

// Accepted gaps, each asserted to still fail so a fixed one is removed here.
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map([
  ["server.checkOtlpEndpoint request", "unchecked: no random string matches its URL pattern"],
]);
// Arrays whose fork-only items upstream clients drop by design, because they cannot act on them.
const TOLERATED_DROPS: ReadonlyMap<string, string> = new Map([
  ["server.getConfig success $.keybindings", "bindings for the fork's own commands"],
  ["subscribeServerConfig success $.payload.keybindings", "bindings for the fork's own commands"],
  ["subscribeServerConfig success $.config.keybindings", "bindings for the fork's own commands"],
  ["server.upsertKeybinding success $.keybindings", "bindings for the fork's own commands"],
  ["server.removeKeybinding success $.keybindings", "bindings for the fork's own commands"],
]);

const SEED = 20_261_113;
const COUNT = 24;
// Wide structs (settings, thread projections) exhaust the discard budget at the default size.
const SIZES = [undefined, 8, 1];
const MAX_DISCARDS = 2_000;
const FORCED_SAMPLES_PER_LITERAL = 3;

const upstreamClient = readClientWireCapabilities(SETTINGS_SECRET_REFERENCES_CAPABILITY);
const reviewAgent: NonNullable<ScheduledTask["agent"]> = {
  type: "review",
  kind: "standards",
  rules: [{ id: "rule", title: "Rule", instructions: "Check." }],
  targets: {
    state: "all",
    threadIds: [],
    includeChildren: false,
    minAgeMs: 0,
    updatedWithinMs: null,
  },
  delivery: "alerts",
};
const withoutAgent = ({ agent: _agent, ...task }: ScheduledTask): ScheduledTask => task;
type Mapper = (value: never, client: ClientWireCapabilities) => unknown;
const responseMappers: Readonly<Record<string, Mapper>> = responseForClient;
const errorMappers: Readonly<Record<string, Mapper>> = errorForClient;
// scheduledTasksForClient refuses these on a task the client cannot show before they run, and
// upstream's upsert has no event schedule to create one with.
const refusedTask = (result: { readonly task: ScheduledTask }) =>
  hidesScheduledTask(result.task, upstreamClient);
const REFUSED: Readonly<Record<string, (value: never) => boolean>> = {
  [WS_METHODS.scheduledTasksUpsert]: refusedTask,
  [WS_METHODS.scheduledTasksSetEnabled]: refusedTask,
  [WS_METHODS.scheduledTasksRunNow]: refusedTask,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: refusedTask,
};

type Wire = unknown;

// Derivation throws for schemas it cannot generate, which the exit records as a defect.
const sample = (schema: Schema.Constraint, count: number, seed: number, size: number | undefined) =>
  Effect.exit(
    Effect.suspend(() =>
      Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        count,
        seed,
        size,
        maxDiscards: MAX_DISCARDS,
      }),
    ),
  );

const sampleValues = Effect.fn("upstreamClientCompatTest.sampleValues")(function* (
  schema: Schema.Top,
) {
  const type = AST.toType(schema.ast);
  // Sample each member of a top-level union, so a rare command or event is never missed.
  const parts = (type._tag === "Union" ? type.types : [type]).map((part) => Schema.make(part));
  const values: Array<unknown> = [];
  parts: for (const part of parts) {
    for (const size of SIZES) {
      const exit = yield* sample(part, COUNT, SEED, size);
      if (Exit.isSuccess(exit)) {
        values.push(...exit.value);
        continue parts;
      }
    }
    // One exhausted value fails a whole batch, so keep the values that do generate.
    for (let index = 0; index < COUNT; index++) {
      const exit = yield* sample(part, 1, SEED + index, 1);
      if (Exit.isSuccess(exit)) values.push(...exit.value);
    }
  }
  return values;
});

const jsonCodecs = new Map<Schema.Top, ReturnType<typeof compileJsonCodec>>();
function compileJsonCodec(schema: Schema.Top) {
  // Wire contracts decode and encode without services.
  const codec = Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
  return { encode: Schema.encodeUnknownExit(codec), decode: Schema.decodeUnknownExit(codec) };
}
function jsonCodec(schema: Schema.Top) {
  const compiled = jsonCodecs.get(schema) ?? compileJsonCodec(schema);
  jsonCodecs.set(schema, compiled);
  return compiled;
}

// Transport-faithful: the RPC layer's JSON codec, then a JSON round trip.
function toWire(schema: Schema.Top, value: unknown): Wire | undefined {
  const exit = jsonCodec(schema).encode(value);
  return Exit.isSuccess(exit) ? JSON.parse(JSON.stringify(exit.value)) : undefined;
}

function fromWire(schema: Schema.Top, wire: Wire) {
  return jsonCodec(schema).decode(wire);
}

/** Samples the sender's own codec accepts; random values its checks reject are not traffic. */
const wireSamples = (schema: Schema.Top) =>
  Effect.map(sampleValues(schema), (values) =>
    values.flatMap((value) => {
      const wire = toWire(schema, value);
      return wire !== undefined && Exit.isSuccess(fromWire(schema, wire)) ? [wire] : [];
    }),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The path of an array `received` holds fewer items of than `sent`. */
function droppedItems(sent: unknown, received: unknown, path = "$"): string | undefined {
  if (Array.isArray(sent)) {
    if (!Array.isArray(received)) return undefined;
    if (received.length < sent.length) return path;
    for (const [index, item] of sent.entries()) {
      const dropped = droppedItems(item, received[index], `${path}[${index}]`);
      if (dropped !== undefined) return dropped;
    }
    return undefined;
  }
  if (!isRecord(sent) || !isRecord(received)) return undefined;
  for (const [key, value] of Object.entries(sent)) {
    if (!(key in received)) continue;
    const dropped = droppedItems(value, received[key], `${path}.${key}`);
    if (dropped !== undefined) return dropped;
  }
  return undefined;
}

interface Position {
  readonly literals: Set<string>;
  /** Members of a literal union, which other members can stand in for in a sample. */
  readonly enumMembers: Set<string>;
  /** Union members this literal tags, by literal; the union sits one property up. */
  readonly memberTags: Map<string, Set<AST.AST>>;
  anyString: boolean;
}

/** The string literal properties that tell a union member apart, through class declarations. */
function tagsOf(node: AST.AST): ReadonlyArray<readonly [string, string]> {
  const type = AST.toType(node);
  if (type._tag === "Declaration") return type.typeParameters.flatMap(tagsOf);
  if (type._tag !== "Objects") return [];
  return type.propertySignatures.flatMap((property) => {
    const value = AST.toType(property.type);
    return value._tag === "Literal" && typeof value.literal === "string"
      ? [[String(property.name), value.literal] as const]
      : [];
  });
}

/** The string literals a schema accepts at each property path, through unions and suspensions. */
function literalPositions(ast: AST.AST): ReadonlyMap<string, Position> {
  const positions = new Map<string, Position>();
  const visited = new Map<AST.AST, Set<string>>();
  // A recursive schema's inner positions repeat its outer ones, so recursion is not unrolled.
  const recursing = new Set<AST.AST>();
  const at = (path: string) => {
    const position = positions.get(path) ?? {
      literals: new Set<string>(),
      enumMembers: new Set<string>(),
      memberTags: new Map<string, Set<AST.AST>>(),
      anyString: false,
    };
    positions.set(path, position);
    return position;
  };
  const visit = (node: AST.AST, path: string, inUnion: boolean): void => {
    const type = AST.toType(node);
    const visitedKey = `${path}${inUnion ? "|" : ""}`;
    const paths = visited.get(type) ?? new Set<string>();
    if (paths.has(visitedKey)) return;
    visited.set(type, paths.add(visitedKey));
    switch (type._tag) {
      case "Union":
        for (const member of type.types) {
          for (const [key, literal] of tagsOf(member)) {
            const { memberTags } = at(`${path}.${key}`);
            memberTags.set(literal, (memberTags.get(literal) ?? new Set()).add(member));
          }
        }
        return type.types.forEach((member) => visit(member, path, true));
      case "Suspend": {
        const target = type.thunk();
        if (recursing.has(target)) return;
        recursing.add(target);
        visit(target, path, inUnion);
        recursing.delete(target);
        return;
      }
      case "Declaration":
        return type.typeParameters.forEach((parameter) => visit(parameter, path, inUnion));
      case "Literal":
        if (typeof type.literal !== "string") return;
        at(path).literals.add(type.literal);
        if (inUnion) at(path).enumMembers.add(type.literal);
        return;
      case "Enum":
        for (const [, value] of type.enums) {
          if (typeof value !== "string") continue;
          at(path).literals.add(value);
          at(path).enumMembers.add(value);
        }
        return;
      case "String":
      case "TemplateLiteral":
      case "Unknown":
      case "Any":
        at(path).anyString = true;
        return;
      case "Objects":
        for (const property of type.propertySignatures) {
          visit(property.type, `${path}.${String(property.name)}`, false);
        }
        for (const index of type.indexSignatures) visit(index.type, `${path}{}`, false);
        return;
      case "Arrays":
        for (const item of [...type.elements, ...type.rest]) visit(item, `${path}[]`, false);
        return;
    }
  };
  visit(ast, "$", false);
  return positions;
}

interface UnionMember {
  readonly unionPath: string;
  readonly member: AST.AST;
}

interface AddedLiteral {
  readonly siblings: ReadonlySet<string>;
  readonly enumMember: boolean;
  /** Union members the literal tags, which a sample can carry only whole. */
  readonly members: ReadonlyArray<UnionMember>;
}

/**
 * String literals the fork's schema accepts at a path where upstream's accepts only other literals.
 * Paths only the fork has are skipped: upstream ignores fields it does not know.
 */
function addedLiterals(fork: AST.AST, upstream: AST.AST): ReadonlyMap<string, AddedLiteral> {
  const added = new Map<
    string,
    { siblings: Set<string>; enumMember: boolean; members: Array<UnionMember> }
  >();
  const upstreamPositions = literalPositions(upstream);
  for (const [path, forkPosition] of literalPositions(fork)) {
    const upstreamPosition = upstreamPositions.get(path);
    if (upstreamPosition === undefined || upstreamPosition.anyString) continue;
    if (upstreamPosition.literals.size === 0) continue;
    for (const literal of forkPosition.literals) {
      if (upstreamPosition.literals.has(literal)) continue;
      const entry = added.get(literal) ?? {
        siblings: new Set<string>(),
        enumMember: false,
        members: [],
      };
      forkPosition.literals.forEach((sibling) => entry.siblings.add(sibling));
      entry.enumMember ||= forkPosition.enumMembers.has(literal);
      const unionPath = path.slice(0, path.lastIndexOf("."));
      for (const member of forkPosition.memberTags.get(literal) ?? []) {
        entry.members.push({ unionPath, member });
      }
      added.set(literal, entry);
    }
  }
  return added;
}

/** Copies of the wire with one string leaf from `from` replaced by `to`. */
function* withLeafReplaced(wire: Wire, from: ReadonlySet<string>, to: string): Generator<Wire> {
  if (typeof wire === "string" && wire !== to && from.has(wire)) yield to;
  if (Array.isArray(wire)) {
    for (const [index, item] of wire.entries()) {
      for (const replaced of withLeafReplaced(item, from, to)) {
        yield wire.map((original, at) => (at === index ? replaced : original));
      }
    }
  } else if (isRecord(wire)) {
    for (const [key, value] of Object.entries(wire)) {
      for (const replaced of withLeafReplaced(value, from, to)) yield { ...wire, [key]: replaced };
    }
  }
}

const pathSegments = (path: string) =>
  (path.match(/\.[^.[{]+|\[\]|\{\}/g) ?? []).map((segment) =>
    segment.startsWith(".") ? segment.slice(1) : segment,
  );

/** Copies of the wire with one value at `path` replaced; declared arrays carry no `[]` segment. */
function* withValueAt(wire: Wire, path: ReadonlyArray<string>, value: Wire): Generator<Wire> {
  const [segment, ...rest] = path;
  if (segment === undefined) {
    yield value;
    return;
  }
  const inArray = segment === "[]" ? rest : path;
  if (Array.isArray(wire)) {
    for (const [index, item] of wire.entries()) {
      for (const replaced of withValueAt(item, inArray, value)) {
        yield wire.map((original, at) => (at === index ? replaced : original));
      }
    }
  } else if (isRecord(wire)) {
    const entries = segment === "{}" ? Object.entries(wire) : [[segment, wire[segment]] as const];
    for (const [key, item] of entries) {
      for (const replaced of withValueAt(item, rest, value)) yield { ...wire, [key]: replaced };
    }
  }
}

const memberWires = new Map<AST.AST, ReadonlyArray<Wire>>();
const memberSamples = Effect.fn("upstreamClientCompatTest.memberSamples")(function* (
  member: AST.AST,
) {
  const cached = memberWires.get(member);
  if (cached !== undefined) return cached;
  const wires = yield* wireSamples(Schema.make(member));
  memberWires.set(member, wires);
  return wires;
});

interface Pair {
  readonly name: string;
  readonly fork: Schema.Top;
  readonly upstream: Schema.Top;
  readonly map?: (value: never, client: ClientWireCapabilities) => unknown;
  /** Values the server refuses to answer upstream clients with. */
  readonly refused?: (value: never) => boolean;
}

interface Failure {
  readonly name: string;
  readonly issue: string;
}

/** At most one failure per pair. */
const serverToUpstreamFailure = Effect.fn("upstreamClientCompatTest.serverToUpstreamFailure")(
  function* (pair: Pair) {
    const added = addedLiterals(pair.fork.ast, pair.upstream.ast);
    const memberWires = new Map<AST.AST, ReadonlyArray<Wire>>();
    for (const { members } of added.values()) {
      for (const { member } of members) memberWires.set(member, yield* memberSamples(member));
    }
    return firstFailure(pair, yield* wireSamples(pair.fork), added, memberWires);
  },
);

function firstFailure(
  pair: Pair,
  samples: ReadonlyArray<Wire>,
  added: ReadonlyMap<string, AddedLiteral>,
  memberWires: ReadonlyMap<AST.AST, ReadonlyArray<Wire>>,
): Failure | undefined {
  const fail = (issue: string) => ({ name: pair.name, issue });
  // Undefined when the fork's server could not have sent this wire; null when upstream decodes it
  // or never receives it.
  const check = (forkWire: Wire): string | null | undefined => {
    const decoded = fromWire(pair.fork, forkWire);
    if (Exit.isFailure(decoded)) return undefined;
    if (pair.refused?.(decoded.value as never)) return null;
    const mapped = pair.map ? pair.map(decoded.value as never, upstreamClient) : decoded.value;
    const sent = toWire(pair.fork, mapped);
    if (sent === undefined) return undefined;
    const received = fromWire(pair.upstream, sent);
    if (Exit.isFailure(received)) return String(received.cause);
    // Against the fork's own decode: its ForwardCompatibleArrays drop some sampled items too.
    const forkReceived = fromWire(pair.fork, sent);
    if (Exit.isFailure(forkReceived)) return undefined;
    const dropped = droppedItems(forkReceived.value, received.value)?.replace(/\[\d+\]/g, "[]");
    if (dropped === undefined || TOLERATED_DROPS.has(`${pair.name} ${dropped}`)) return null;
    return `upstream dropped items at ${dropped}`;
  };

  if (samples.length === 0) return fail("no samples; adjust SIZES or MAX_DISCARDS");
  for (const wire of samples) {
    const issue = check(wire);
    if (issue) return fail(issue);
  }
  for (const [literal, { siblings, enumMember, members }] of added) {
    // A member the literal tags, sampled on its own and put where its union sits in each sample.
    let spliced = 0;
    members: for (const { unionPath, member } of members) {
      const replacements = memberWires.get(member) ?? [];
      for (const [index, wire] of samples.entries()) {
        const replacement = replacements[index % replacements.length];
        if (replacement === undefined) break;
        const [candidate] = withValueAt(wire, pathSegments(unionPath), replacement);
        if (candidate === undefined) continue;
        const issue = check(candidate);
        if (issue) return fail(`with "${literal}": ${issue}`);
        if (issue === null && ++spliced >= FORCED_SAMPLES_PER_LITERAL) break members;
      }
    }
    if (members.length > 0 && spliced === 0) {
      return fail(`no sample takes a member tagged "${literal}"; adjust COUNT or SIZES`);
    }
    let forced = 0;
    for (const wire of samples) {
      for (const candidate of withLeafReplaced(wire, siblings, literal)) {
        const issue = check(candidate);
        if (issue) return fail(`with "${literal}": ${issue}`);
        if (issue === null && ++forced >= FORCED_SAMPLES_PER_LITERAL) break;
      }
      if (forced >= FORCED_SAMPLES_PER_LITERAL) break;
    }
    const carried = samples.some((wire) => JSON.stringify(wire).includes(JSON.stringify(literal)));
    if (enumMember && forced === 0 && !carried) {
      return fail(`no sample carries "${literal}"; adjust COUNT or SIZES`);
    }
  }
  return undefined;
}

interface WireRpc {
  readonly payloadSchema: Schema.Top;
  readonly successSchema: Schema.Top;
  readonly errorSchema: Schema.Top;
}

const successOf = (rpc: WireRpc) =>
  RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.success : rpc.successSchema;
// A stream RPC fails through its stream schema.
const errorOf = (rpc: WireRpc) =>
  RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.error : rpc.errorSchema;

const forkRpcs: ReadonlyMap<string, WireRpc> = WsRpcGroup.requests;
const upstreamRpcs = Upstream.WsRpcGroup.requests;
const sharedRpcs = [...upstreamRpcs].flatMap(([tag, upstream]) => {
  const fork = forkRpcs.get(tag);
  return fork === undefined ? [] : [{ tag, fork, upstream }];
});

interface HttpApiSchemas {
  readonly groups: Readonly<
    Record<
      string,
      {
        readonly endpoints: Readonly<
          Record<
            string,
            { readonly success: ReadonlySet<Schema.Top>; readonly error: ReadonlySet<Schema.Top> }
          >
        >;
      }
    >
  >;
}
/** HTTP endpoints by `group.endpoint`; upstream clients load their first screens through these. */
const httpEndpoints = (api: HttpApiSchemas) =>
  new Map(
    Object.entries(api.groups).flatMap(([group, { endpoints }]) =>
      Object.entries(endpoints).map(([name, endpoint]) => [`${group}.${name}`, endpoint] as const),
    ),
  );
const forkEndpoints = httpEndpoints(EnvironmentHttpApi);
const upstreamEndpoints = httpEndpoints(Upstream.EnvironmentHttpApi);
function anyOf(schemas: ReadonlySet<Schema.Top>): Schema.Top {
  const [only, ...others] = schemas;
  return only !== undefined && others.length === 0 ? only : Schema.Union([...schemas]);
}
const httpPairs: ReadonlyArray<Pair> = [...upstreamEndpoints].flatMap(([name, upstream]) => {
  const fork = forkEndpoints.get(name);
  return fork === undefined
    ? []
    : (["success", "error"] as const).flatMap((kind) =>
        fork[kind].size === 0
          ? []
          : [
              {
                name: `http ${name} ${kind}`,
                fork: anyOf(fork[kind]),
                upstream: anyOf(upstream[kind]),
              },
            ],
      );
});

/** Unexpected failures, plus a known gap that no longer fails. */
function unexpected(failures: ReadonlyArray<Failure>, names: ReadonlyArray<string>) {
  const failed = new Set(failures.map((failure) => failure.name));
  return [
    ...failures
      .filter((failure) => !KNOWN_GAPS.has(failure.name))
      .map((failure) => `${failure.name}: ${failure.issue}`),
    ...names
      .filter((name) => KNOWN_GAPS.has(name) && !failed.has(name))
      .map((name) => `${name} works now; remove it from KNOWN_GAPS`),
  ];
}

describe("upstream client wire compatibility", () => {
  it("serves every upstream method", () => {
    const methods = [
      ...upstreamRpcs.keys(),
      ...[...upstreamEndpoints.keys()].map((name) => `http ${name}`),
    ];
    const failures = [
      ...[...upstreamRpcs.keys()].filter((tag) => !forkRpcs.has(tag)),
      ...[...upstreamEndpoints.keys()]
        .filter((name) => !forkEndpoints.has(name))
        .map((name) => `http ${name}`),
    ].map((name) => ({ name, issue: "not served" }));
    expect(unexpected(failures, methods)).toEqual([]);
  });

  it.effect("decodes upstream client requests", () =>
    Effect.gen(function* () {
      const failures: Array<Failure> = [];
      for (const { tag, fork, upstream } of sharedRpcs) {
        const name = `${tag} request`;
        const samples = yield* wireSamples(upstream.payloadSchema);
        if (samples.length === 0) {
          failures.push({ name, issue: "no samples; adjust SIZES or MAX_DISCARDS" });
        }
        for (const wire of samples) {
          const decoded = fromWire(fork.payloadSchema, wire);
          if (Exit.isSuccess(decoded)) continue;
          failures.push({ name, issue: String(decoded.cause) });
          break;
        }
      }
      expect(unexpected(failures, [])).toEqual([]);
    }),
  );

  it.effect("sends upstream clients responses, stream items and errors they decode", () =>
    Effect.gen(function* () {
      const pairs: ReadonlyArray<Pair> = [
        {
          name: "environment descriptor",
          fork: ExecutionEnvironmentDescriptor,
          upstream: Upstream.ExecutionEnvironmentDescriptor,
        },
        ...httpPairs,
        ...sharedRpcs.flatMap(({ tag, fork, upstream }) => {
          const map = responseMappers[tag];
          const mapError = errorMappers[tag];
          const refused = REFUSED[tag];
          const success = { fork: successOf(fork), upstream: successOf(upstream) };
          const error = { fork: errorOf(fork), upstream: errorOf(upstream) };
          return [
            {
              name: `${tag} success`,
              ...success,
              ...(map ? { map } : {}),
              ...(refused ? { refused } : {}),
            },
            ...(AST.toType(error.fork.ast)._tag === "Never"
              ? []
              : [{ name: `${tag} error`, ...error, ...(mapError ? { map: mapError } : {}) }]),
          ];
        }),
      ];
      const failures = (yield* Effect.forEach(pairs, serverToUpstreamFailure)).flatMap(
        (failure) => failure ?? [],
      );
      expect(
        unexpected(
          failures,
          pairs.map((pair) => pair.name),
        ),
      ).toEqual([]);
    }),
  );

  it.effect("keeps the fork's statuses for clients that declare them", () =>
    Effect.gen(function* () {
      const forkClient = readClientWireCapabilities(
        [
          SETTINGS_SECRET_REFERENCES_CAPABILITY,
          SCHEDULED_TASK_SKIPPED_STATUS_CAPABILITY,
          PEER_LINK_UNAUTHORIZED_STATUS_CAPABILITY,
          TERMINAL_WORKSPACE_CHANGED_ERROR_CAPABILITY,
          SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY,
          AUTOMATIONS_CLIENT_CAPABILITY,
        ].join(","),
      );
      const [sample] = (yield* sampleValues(ScheduledTask)) as ReadonlyArray<ScheduledTask>;
      const task = sample === undefined ? undefined : withoutAgent(sample);
      const [link] = (yield* sampleValues(PeerLinkSummary)) as ReadonlyArray<PeerLinkSummary>;
      if (task === undefined || link === undefined) throw new Error("no samples");
      const skipped = { task: { ...task, lastRunStatus: "skipped" as const } };
      const unauthorized = { links: [{ ...link, status: "unauthorized" as const }] };
      const runNow = responseForClient[WS_METHODS.scheduledTasksRunNow];
      const listLinks = responseForClient[WS_METHODS.peerLinksList];

      expect(runNow(skipped, forkClient).task.lastRunStatus).toBe("skipped");
      expect(listLinks(unauthorized, forkClient).links[0]?.status).toBe("unauthorized");
      expect(runNow(skipped, upstreamClient).task.lastRunStatus).toBe("succeeded");
      expect(listLinks(unauthorized, upstreamClient).links[0]?.status).toBe("expired");

      const once = { ...task, schedule: { type: "once" as const, runAt: task.createdAt } };
      const onEvent = {
        ...task,
        schedule: { type: "event" as const, event: "run_ended" as const },
      };
      const reviewing = { ...once, agent: reviewAgent };
      const list = { tasks: [onEvent, once, reviewing] };
      const listTasks = responseForClient[WS_METHODS.scheduledTasksSubscribe];
      expect(listTasks(list, forkClient).tasks).toEqual([onEvent, once, reviewing]);
      expect(listTasks(list, upstreamClient).tasks.map(({ schedule }) => schedule)).toEqual([
        once.schedule,
      ]);

      const moved = new TerminalWorkspaceChangedError({
        threadId: "thread",
        terminalId: "default",
        worktreePath: "/work/new",
      });
      const openError = errorForClient[WS_METHODS.terminalOpen];
      expect(openError(moved, forkClient)).toBe(moved);
      const mapped = openError(moved, upstreamClient);
      expect(mapped).toBeInstanceOf(TerminalCwdStatError);
      expect(mapped.message).toBe(`Failed to access terminal cwd: ${moved.message}`);
    }),
  );

  it("sends upstream clients every assistant text part as a final answer", () => {
    const at = DateTime.makeUnsafe("2026-11-13T10:00:00Z");
    const base = (id: string, ordinal: number) => ({
      id: TurnItemId.make(id),
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    });
    const text = (
      id: string,
      ordinal: number,
      fields: { readonly text: string; readonly phase?: "commentary" | "final_answer" },
    ): OrchestrationV2TurnItem => ({
      ...base(id, ordinal),
      type: "assistant_message",
      messageId: MessageId.make(id),
      streaming: false,
      ...fields,
    });
    const items: ReadonlyArray<OrchestrationV2TurnItem> = [
      text("commentary", 1, { text: "Found it, fixing.", phase: "commentary" }),
      text("unphased", 2, { text: "Tests pass." }),
      text("empty", 3, { text: "" }),
      { ...base("tool", 4), type: "reasoning", text: "Hmm", streaming: false },
      text("final", 5, { text: "Done.", phase: "final_answer" }),
    ];
    const projected = items.map((item): OrchestrationV2ProjectedTurnItem => ({
      position: item.ordinal,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    }));
    const phases = (sent: ReadonlyArray<OrchestrationV2TurnItem>) =>
      sent.map((item) => (item.type === "assistant_message" ? (item.phase ?? null) : item.type));
    const upstreamPhases = ["final_answer", "final_answer", null, "reasoning", "final_answer"];
    const forkClient = readClientWireCapabilities(ASSISTANT_TEXT_PARTS_CAPABILITY);
    const projection = {
      turnItems: items,
      visibleTurnItems: projected,
    } as Partial<OrchestrationV2ThreadProjection> as OrchestrationV2ThreadProjection;

    const getProjection = responseForClient[ORCHESTRATION_V2_WS_METHODS.getThreadProjection];
    expect(getProjection(projection, forkClient)).toBe(projection);
    const sentProjection = getProjection(projection, upstreamClient);
    expect(phases(sentProjection.turnItems)).toEqual(upstreamPhases);
    expect(phases(sentProjection.visibleTurnItems.map(({ item }) => item))).toEqual(upstreamPhases);
    expect(sentProjection.turnItems[4]).toBe(items[4]);

    const subscribe = responseForClient[ORCHESTRATION_V2_WS_METHODS.subscribeThread];
    const snapshot = {
      kind: "snapshot" as const,
      snapshotSequence: 1,
      projection,
      idTable: true as const,
    };
    expect(subscribe(snapshot, forkClient)).toBe(snapshot);
    const sentSnapshot = subscribe(snapshot, upstreamClient);
    expect(
      sentSnapshot.kind === "snapshot" ? phases(sentSnapshot.projection.turnItems) : null,
    ).toEqual(upstreamPhases);
    // A live update whose text the deduper blanked is still a text part.
    const omitted = { ...items[0]!, text: "", textOmitted: true as const };
    const event = (payload: OrchestrationV2TurnItem) => ({
      kind: "event" as const,
      sequence: 2,
      event: {
        id: "event" as never,
        threadId: payload.threadId,
        type: "turn-item.updated" as const,
        payload,
        createdAt: at,
      } as never,
    });
    for (const payload of [items[0]!, omitted]) {
      const sent = subscribe(event(payload), upstreamClient);
      expect(sent.kind === "event" && sent.event.type === "turn-item.updated").toBe(true);
      if (sent.kind === "event" && sent.event.type === "turn-item.updated") {
        expect(phases([sent.event.payload])).toEqual(["final_answer"]);
      }
      expect(subscribe(event(payload), forkClient)).toEqual(event(payload));
    }

    const getItem = responseForClient[ORCHESTRATION_V2_WS_METHODS.getTurnItem];
    expect(phases([getItem({ item: items[1]! }, upstreamClient).item!])).toEqual(["final_answer"]);
    expect(getItem({ item: items[1]! }, forkClient).item).toBe(items[1]);

    const page = {
      snapshotSequence: 1,
      items: projected,
      nextCursor: null,
      hasMoreHistory: false,
      idTable: true as const,
    };
    expect(threadHistoryPageForClient(page, forkClient)).toBe(page);
    expect(
      phases(threadHistoryPageForClient(page, upstreamClient).items.map(({ item }) => item)),
    ).toEqual(upstreamPhases);
  });

  it.effect(
    "refuses upstream clients' changes to a task they cannot show before running them",
    () =>
      Effect.gen(function* () {
        const [sample] = (yield* sampleValues(ScheduledTask)) as ReadonlyArray<ScheduledTask>;
        if (sample === undefined) throw new Error("no samples");
        const task = withoutAgent(sample);
        const shown = { ...task, schedule: { type: "once" as const, runAt: task.createdAt } };
        const onEvent = {
          ...task,
          id: `${task.id}-event` as ScheduledTask["id"],
          schedule: { type: "event" as const, event: "thread_created" as const },
        };
        const onReview = {
          ...shown,
          id: `${task.id}-review` as ScheduledTask["id"],
          agent: reviewAgent,
        };
        const ran: Array<string> = [];
        const record =
          (method: string) => (input: { readonly id?: ScheduledTask["id"] | undefined }) =>
            Effect.sync(() => {
              ran.push(`${method} ${input.id ?? "new"}`);
              return { id: input.id ?? shown.id, task: shown, threadId: null };
            });
        const service = {
          list: () => Effect.succeed({ tasks: [shown, onEvent, onReview] }),
          upsert: record("upsert"),
          setEnabled: record("setEnabled"),
          setThreadEnabled: record("setThreadEnabled"),
          runNow: record("runNow"),
          rotateWebhookToken: record("rotateWebhookToken"),
          delete: record("delete"),
          listRuns: (input: { readonly id: ScheduledTask["id"] }) =>
            Effect.sync(() => {
              ran.push(`listRuns ${input.id}`);
              return { runs: [], hasMore: false };
            }),
        } as Partial<
          ScheduledTasks.ScheduledTaskService["Service"]
        > as ScheduledTasks.ScheduledTaskService["Service"];
        const forUpstream = scheduledTasksForClient(service, upstreamClient);
        const { id: _id, ...upsert } = shown;
        const calls = (
          id: ScheduledTask["id"],
        ): Array<Effect.Effect<object, ScheduledTaskError>> => [
          forUpstream.upsert({ ...upsert, id }),
          forUpstream.setEnabled({ id, enabled: false }),
          forUpstream.setThreadEnabled({ id, threadId: ThreadId.make("thread:a"), enabled: false }),
          forUpstream.runNow({ id }),
          forUpstream.rotateWebhookToken({ id }),
          forUpstream.delete({ id }),
          forUpstream.listRuns({ id }),
        ];

        const runNowRpc = upstreamRpcs.get(WS_METHODS.scheduledTasksRunNow);
        if (runNowRpc === undefined) throw new Error("upstream has no runNow");
        for (const call of [...calls(onEvent.id), ...calls(onReview.id)]) {
          const refusal = yield* Effect.flip(call);
          expect(refusal).toBeInstanceOf(ScheduledTaskError);
          expect([onEvent.id, onReview.id]).toContain(refusal.taskId);
          const wire = toWire(ScheduledTaskError, refusal);
          expect(Exit.isSuccess(fromWire(errorOf(runNowRpc), wire))).toBe(true);
        }
        expect(ran).toEqual([]);

        yield* Effect.all([...calls(shown.id), forUpstream.upsert(upsert)]);
        expect(ran).toEqual([
          `upsert ${shown.id}`,
          `setEnabled ${shown.id}`,
          `setThreadEnabled ${shown.id}`,
          `runNow ${shown.id}`,
          `rotateWebhookToken ${shown.id}`,
          `delete ${shown.id}`,
          `listRuns ${shown.id}`,
          "upsert new",
        ]);
        const forFork = readClientWireCapabilities(
          `${SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY},${AUTOMATIONS_CLIENT_CAPABILITY}`,
        );
        expect(
          yield* Effect.flip(
            scheduledTasksForClient(
              service,
              readClientWireCapabilities(SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY),
            ).runNow({ id: onReview.id }),
          ),
        ).toBeInstanceOf(ScheduledTaskError);
        expect(scheduledTasksForClient(service, forFork)).toBe(service);
      }),
  );
});
