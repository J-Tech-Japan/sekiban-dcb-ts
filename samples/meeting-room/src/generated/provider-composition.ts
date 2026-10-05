// Generated from contracts/provider-composition.json by scripts/g34-provider-composition.mjs. Do not edit.
export const providerCompositionDigest = "1550d2621d2a3e584e65f597806f3602b0923f752937406af1ec74e394792710";
export const providerCompositionDescriptor = {"profileId":"meeting-room-cloudflare","components":[{"id":"worker","entrypoints":[{"kind":"default","operation":"fetch","requiredBindings":["ALLOCATOR","BOOTSTRAP","D1","D1_MV","DOWNSTREAM_QUEUE","JOURNAL","TAG","TAG_STATE"],"forbiddenBindings":[]},{"kind":"named","name":"MeetingRoomDownstreamDoorbell","operation":"deliver","requiredBindings":["ALLOCATOR","BOOTSTRAP","D1","D1_MV","DOWNSTREAM_QUEUE","JOURNAL","TAG","TAG_STATE"],"forbiddenBindings":[]}]}],"bindings":["ALLOCATOR","BOOTSTRAP","D1","D1_MV","DOWNSTREAM_QUEUE","JOURNAL","TAG","TAG_STATE"]} as const;

export function allocatorBinding<E extends { ALLOCATOR?: unknown }>(env: E): NonNullable<E["ALLOCATOR"]> {
  return env["ALLOCATOR"] as NonNullable<E["ALLOCATOR"]>;
}

export function bootstrapBinding<E extends { BOOTSTRAP?: unknown }>(env: E): NonNullable<E["BOOTSTRAP"]> {
  return env["BOOTSTRAP"] as NonNullable<E["BOOTSTRAP"]>;
}

export function pipelineD1<E extends { D1?: unknown }>(env: E): NonNullable<E["D1"]> {
  return env["D1"] as NonNullable<E["D1"]>;
}

export function materializedViewD1<E extends { D1_MV?: unknown }>(env: E): NonNullable<E["D1_MV"]> {
  return env["D1_MV"] as NonNullable<E["D1_MV"]>;
}

export function downstreamQueue<E extends { DOWNSTREAM_QUEUE?: unknown }>(env: E): NonNullable<E["DOWNSTREAM_QUEUE"]> {
  return env["DOWNSTREAM_QUEUE"] as NonNullable<E["DOWNSTREAM_QUEUE"]>;
}

export function journalBinding<E extends { JOURNAL?: unknown }>(env: E): NonNullable<E["JOURNAL"]> {
  return env["JOURNAL"] as NonNullable<E["JOURNAL"]>;
}

export function tagBinding<E extends { TAG?: unknown }>(env: E): NonNullable<E["TAG"]> {
  return env["TAG"] as NonNullable<E["TAG"]>;
}

export function tagStateBinding<E extends { TAG_STATE?: unknown }>(env: E): NonNullable<E["TAG_STATE"]> {
  return env["TAG_STATE"] as NonNullable<E["TAG_STATE"]>;
}
