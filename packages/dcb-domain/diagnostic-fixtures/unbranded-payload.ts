import { command, done, event, read, projector, tagFamily } from "@sekiban/dcb-domain";
import { z } from "zod";

const order = tagFamily("order");
const placed = event("DiagnosticBranded", z.object({ id: z.string() }), {
  tags: (payload) => [order.of(payload.id)],
});
const orderProjector = projector({
  id: "diagnostic-branded-projector",
  tag: order,
  events: [placed],
  initialState: { kind: "empty" as const },
  handlers: { DiagnosticBranded: (state) => state },
});
command({
  id: "diagnostic-unbranded",
  input: z.object({ id: z.string() }),
  reads: (input) => read(orderProjector, order.of(input.id)),
  handle: (input, context) => {
    context.append(placed, { id: input.id });
    return done();
  },
});
