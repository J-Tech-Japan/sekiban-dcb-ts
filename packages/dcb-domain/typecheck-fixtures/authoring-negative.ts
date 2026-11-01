import { z } from "zod";
import {
  command,
  defineListQuery,
  defineQuery,
  defineQueryView,
  domain,
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

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const orders = defineQueryView({
  id: "orders",
  version: 1,
  row: z.strictObject({ orderId: z.string() }),
});
const queryParamsSchema = z.strictObject({ roomId: z.string() });
const queryResultSchema = z.strictObject({ count: z.number() });
const queryItemSchema = z.strictObject({ id: z.string() });
const countQuery = defineQuery({
  id: "reservation-count",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  result: queryResultSchema,
  handleQuery: (_projection, queryParams) => ({ count: queryParams.roomId.length }),
});
const listQuery = defineListQuery({
  id: "reservation-list",
  version: 2,
  source: orders,
  params: queryParamsSchema,
  item: queryItemSchema,
  handleFilter: (projection) => projection.rows.map((row) => ({ id: row.value.orderId })),
  handleSort: (items) => items,
});
const queryIdMatch: Equals<typeof countQuery.id, "reservation-count"> = true;
const queryVersionMatch: Equals<typeof countQuery.version, 1> = true;
const listIdMatch: Equals<typeof listQuery.id, "reservation-list"> = true;
const listVersionMatch: Equals<typeof listQuery.version, 2> = true;
const queryParamsMatch: Equals<Parameters<typeof countQuery.handleQuery>[1], Readonly<{ roomId: string }>> = true;
const queryResultMatch: Equals<ReturnType<typeof countQuery.handleQuery>, { count: number }> = true;
const queryItemMatch: Equals<ReturnType<typeof listQuery.handleFilter>[number], Readonly<{ id: string }>> = true;
const authoredQueries = domain({
  events: [orderPlaced],
  projectors: [orderProjector],
  views: [{ id: "orders", source: orderProjector.id }],
  queries: [countQuery, listQuery],
});
const authoredQueriesMatch: Equals<typeof authoredQueries.queries, readonly [typeof countQuery, typeof listQuery]> = true;
void authoredQueries;

defineQuery({
  id: "mutate-row",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  result: queryResultSchema,
  handleQuery: (projection, queryParams, context) => {
    // @ts-expect-error projection rows are readonly
    projection.rows.push(projection.rows[0]);
    const row = projection.rows[0];
    if (row !== undefined) {
      // @ts-expect-error row values are readonly
      row.value.orderId = "mutated";
    }
    // @ts-expect-error decoded params are readonly
    queryParams.roomId = "mutated";
    // @ts-expect-error handler context is readonly
    context.readHead = "mutated";
    return { count: queryParams.roomId.length };
  },
});

const filteredItems = listQuery.handleFilter({ rows: [] }, { roomId: "r" }, {});
// @ts-expect-error returned filter elements are readonly
filteredItems[0].id = "mutated";

defineListQuery({
  id: "mutate-sort",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  item: queryItemSchema,
  handleFilter: () => [{ id: "a" }],
  handleSort: (items) => {
    // @ts-expect-error sort input elements are readonly
    items[0].id = "mutated";
    const sortedItems = items.slice();
    // @ts-expect-error sort result elements are readonly
    sortedItems[0].id = "mutated";
    return sortedItems;
  },
});

defineQuery({
  id: "promise-query",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  result: queryResultSchema,
  // @ts-expect-error scalar handlers are synchronous
  handleQuery: async () => ({ count: 1 }),
});

defineListQuery({
  id: "promise-list",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  item: queryItemSchema,
  // @ts-expect-error list filters are synchronous
  handleFilter: async () => [{ id: "a" }],
  handleSort: (items) => items,
});

defineQuery({
  id: "wrong-result",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  result: queryResultSchema,
  // @ts-expect-error scalar results must match the decoded result schema
  handleQuery: () => ({ count: "nope" }),
});

defineListQuery({
  id: "wrong-item",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  item: queryItemSchema,
  // @ts-expect-error list items must match the decoded item schema
  handleFilter: () => [{ id: 1 }],
  handleSort: (items) => items,
});

defineQuery({
  id: "generic-handler",
  version: 1,
  source: orders,
  params: queryParamsSchema,
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
  // @ts-expect-error scalar definitions do not accept a generic handler option
  handler: () => ({ count: 1 }),
});

// @ts-expect-error contracts do not expose server handlers
countQuery.contract.handleQuery({ rows: [] }, { roomId: "r" }, {});

defineQuery({
  id: "reserved-page-number",
  version: 1,
  source: orders,
  // @ts-expect-error PageNumber is a reserved control name
  params: z.strictObject({ PageNumber: z.number() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-page-size",
  version: 1,
  source: orders,
  // @ts-expect-error PageSize is a reserved control name
  params: z.strictObject({ PageSize: z.number() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-newest-first",
  version: 1,
  source: orders,
  // @ts-expect-error NewestFirst is a reserved control name
  params: z.strictObject({ NewestFirst: z.boolean() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-consistency",
  version: 1,
  source: orders,
  // @ts-expect-error consistency is a reserved control name
  params: z.strictObject({ consistency: z.string() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-page-number-camel",
  version: 1,
  source: orders,
  // @ts-expect-error pageNumber is a reserved control name
  params: z.strictObject({ pageNumber: z.number() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-page-size-camel",
  version: 1,
  source: orders,
  // @ts-expect-error pageSize is a reserved control name
  params: z.strictObject({ pageSize: z.number() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-newest-first-camel",
  version: 1,
  source: orders,
  // @ts-expect-error newestFirst is a reserved control name
  params: z.strictObject({ newestFirst: z.boolean() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-descending",
  version: 1,
  source: orders,
  // @ts-expect-error descending is a reserved control name
  params: z.strictObject({ descending: z.boolean() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-wait",
  version: 1,
  source: orders,
  // @ts-expect-error waitForSortableUniqueId is a reserved control name
  params: z.strictObject({ waitForSortableUniqueId: z.string() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-signal",
  version: 1,
  source: orders,
  // @ts-expect-error signal is a reserved control name
  params: z.strictObject({ signal: z.string() }),
  result: queryResultSchema,
  handleQuery: () => ({ count: 1 }),
});

void [
  queryIdMatch,
  queryVersionMatch,
  listIdMatch,
  listVersionMatch,
  queryParamsMatch,
  queryResultMatch,
  queryItemMatch,
  authoredQueriesMatch,
];
