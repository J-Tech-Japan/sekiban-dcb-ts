import { Session, event, projector, read, tagFamily } from "@sekiban/dcb-domain";
import { z } from "zod";

const order = tagFamily("order");
const reservation = tagFamily("reservation");
const placed = event("DiagnosticPlaced", z.object({ id: z.string() }), {
  tags: (payload) => [order.of(payload.id)],
});
const orderProjector = projector({
  id: "diagnostic-order-projector",
  tag: order,
  events: [placed],
  initialState: { kind: "empty" as const },
  handlers: { DiagnosticPlaced: (state) => state },
});
const session = new Session({ now: 0, readSet: read(orderProjector, order.of("id")) });
session.context().state(orderProjector, reservation.of("id"));
