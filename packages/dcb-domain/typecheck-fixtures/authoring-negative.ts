import { z } from "zod";
import {
  command,
  done,
  event,
  projector,
  read,
  tagFamily,
} from "@sekiban/dcb-domain";

const order = tagFamily("order");
const reservation = tagFamily("reservation");
const orderPlaced = event("OrderPlaced", z.object({ orderId: z.string() }), {
  tags: (payload) => [order.of(payload.orderId)],
});

// @ts-expect-error schema-less definitions are rejected at the authoring boundary.
event("SchemaMissing", { tags: () => [] });

// @ts-expect-error tags-less definitions are rejected at the authoring boundary.
event("TagsMissing", z.object({ orderId: z.string() }), {});

const orderProjector = projector({
  id: "order-projector",
  tag: order,
  events: [orderPlaced],
  initialState: {} as { readonly kind: "empty" } | { readonly kind: "placed"; readonly orderId: string },
  handlers: {
    OrderPlaced: (state) => ({ kind: "placed", orderId: state.kind === "empty" ? "" : state.orderId }),
  },
});

command({
  id: "bad-command",
  input: z.object({ orderId: z.string() }),
  reads: (input) => read(orderProjector, order.of(input.orderId)),
  handle: async (input, context) => {
    // @ts-expect-error a reservation-family tag cannot be read from an order projector.
    await context.state(orderProjector, reservation.of(input.orderId));
    // @ts-expect-error append accepts only the branded payload returned by event.make().
    context.append(orderPlaced, { orderId: input.orderId });
    return done();
  },
});
