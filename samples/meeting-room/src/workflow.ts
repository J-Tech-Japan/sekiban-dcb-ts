import type { ExecuteResult } from "@sekiban/dcb-client";

export type WorkflowExecutor = (commandId: string, input: unknown) => Promise<ExecuteResult>;

/**
 * A two-step booking workflow is intentionally non-atomic: the room creation
 * remains durable when the reservation step conflicts or is rejected.
 */
export async function bookRoomWorkflow(
  execute: WorkflowExecutor,
  input: { readonly roomId: string; readonly reservationId: string; readonly name?: string; readonly userId?: string },
): Promise<{ readonly create: ExecuteResult; readonly reserve?: ExecuteResult }> {
  const create = await execute("create-room", { roomId: input.roomId, name: input.name });
  if (create.kind !== "committed") return { create };
  const reserve = await execute("reserve-room", {
    roomId: input.roomId,
    reservationId: input.reservationId,
    userId: input.userId,
  });
  return { create, reserve };
}
