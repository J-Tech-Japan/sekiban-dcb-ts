// Generated from contracts/provider-composition.json by scripts/g34-provider-composition.mjs. Do not edit.
export const providerCompositionDigest = "5ff2347ea2a407b49aa89ef102112b5f5ac923e5e03fa0213bdfaf2cd7004c2b";
export const providerCompositionDescriptor = {"profileId":"g32-cutover","components":[{"id":"primary","entrypoints":[{"operation":"fetch","requiredBindings":["ALLOCATOR","BOOTSTRAP","D1","D1_MV","DOWNSTREAM_DOORBELL","DOWNSTREAM_QUEUE","JOURNAL","TAG"],"forbiddenBindings":[]}]},{"id":"receiver","entrypoints":[{"operation":"fetch","requiredBindings":["ALLOCATOR","BOOTSTRAP","D1","D1_MV","JOURNAL","TAG"],"forbiddenBindings":["DOWNSTREAM_QUEUE"]}]}],"bindings":["ALLOCATOR","BOOTSTRAP","D1_MV","D1","DOWNSTREAM_DOORBELL","DOWNSTREAM_QUEUE","JOURNAL","TAG"]} as const;

export function allocatorBinding<E extends { ALLOCATOR?: unknown }>(env: E): NonNullable<E["ALLOCATOR"]> {
  return env["ALLOCATOR"] as NonNullable<E["ALLOCATOR"]>;
}

export function bootstrapBinding<E extends { BOOTSTRAP?: unknown }>(env: E): NonNullable<E["BOOTSTRAP"]> {
  return env["BOOTSTRAP"] as NonNullable<E["BOOTSTRAP"]>;
}

export function materializedViewD1<E extends { D1_MV?: unknown }>(env: E): NonNullable<E["D1_MV"]> {
  return env["D1_MV"] as NonNullable<E["D1_MV"]>;
}

export function pipelineD1<E extends { D1?: unknown }>(env: E): NonNullable<E["D1"]> {
  return env["D1"] as NonNullable<E["D1"]>;
}

export function downstreamDoorbell<E extends { DOWNSTREAM_DOORBELL?: unknown }>(env: E): NonNullable<E["DOWNSTREAM_DOORBELL"]> {
  return env["DOWNSTREAM_DOORBELL"] as NonNullable<E["DOWNSTREAM_DOORBELL"]>;
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
