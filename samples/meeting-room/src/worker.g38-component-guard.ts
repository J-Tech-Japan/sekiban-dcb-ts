/** Routes that are meaningful only on the primary deployment identity. */
export type PrimaryComponentRoute = "command" | "bootstrap-operator" | "repair-operator" | "conformance";

export interface ComponentGuardEnv {
  readonly G32_COMPONENT?: string;
}

export const G38_PRIMARY_COMPONENT_REJECT = {
  error: "This route is available only on the primary component",
  code: "g38_primary_component_required",
} as const;

export function rejectUnlessPrimaryComponent(
  env: ComponentGuardEnv,
  route: PrimaryComponentRoute,
): Response | undefined {
  // Keep the route in the call signature so each entry's guard is explicit.
  void route;
  if (env.G32_COMPONENT === "primary") return undefined;
  return new Response(JSON.stringify(G38_PRIMARY_COMPONENT_REJECT), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
