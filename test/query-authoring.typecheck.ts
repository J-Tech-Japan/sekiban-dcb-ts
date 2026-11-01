import { z } from "zod";
import {
  defineListQuery,
  defineQuery,
  defineQueryView,
  domain,
  event,
  projector,
  tagFamily,
} from "@sekiban/dcb-domain";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const order = tagFamily("order");
const placed = event("OrderPlaced", z.object({ orderId: z.string() }), {
  tags: (payload) => [order.of(payload.orderId)],
});
const orderProjector = projector({
  id: "order-projector",
  tag: order,
  events: [placed],
  initialState: { kind: "placed" as const },
  handlers: { OrderPlaced: () => ({ kind: "placed" as const }) },
});

const orders = defineQueryView({
  id: "orders",
  version: 1,
  row: z.strictObject({ orderId: z.string() }),
});
const params = z.strictObject({ roomId: z.string(), limit: z.number() });
const result = z.strictObject({ count: z.number() });
const item = z.strictObject({ id: z.string() });

const countQuery = defineQuery({
  id: "reservation-count",
  version: 1,
  source: orders,
  params,
  result,
  handleQuery: (_projection, queryParams) => ({ count: queryParams.limit }),
});
const listQuery = defineListQuery({
  id: "reservation-list",
  version: 2,
  source: orders,
  params,
  item,
  handleFilter: () => [{ id: "a" }],
  handleSort: (items) => items,
});

const paramsMatch: Equals<Parameters<typeof countQuery.handleQuery>[1], Readonly<{ roomId: string; limit: number }>> = true;
const resultMatch: Equals<ReturnType<typeof countQuery.handleQuery>, { count: number }> = true;
const listParamsMatch: Equals<Parameters<typeof listQuery.handleFilter>[1], Readonly<{ roomId: string; limit: number }>> = true;
const itemMatch: Equals<ReturnType<typeof listQuery.handleFilter>[number], Readonly<{ id: string }>> = true;
const rowMatch: Equals<Parameters<typeof countQuery.handleQuery>[0]["rows"][number]["value"], Readonly<{ orderId: string }>> = true;
const queryIdMatch: Equals<typeof countQuery.id, "reservation-count"> = true;
const queryVersionMatch: Equals<typeof countQuery.version, 1> = true;
const listIdMatch: Equals<typeof listQuery.id, "reservation-list"> = true;
const listVersionMatch: Equals<typeof listQuery.version, 2> = true;
const viewIdMatch: Equals<typeof orders.id, "orders"> = true;

const authored = domain({
  events: [placed],
  projectors: [orderProjector],
  views: [{ id: "orders", source: orderProjector.id }],
  queries: [countQuery, listQuery],
});
const queriesMatch: Equals<typeof authored.queries, readonly [typeof countQuery, typeof listQuery]> = true;
void authored;

void [
  paramsMatch,
  resultMatch,
  listParamsMatch,
  itemMatch,
  rowMatch,
  queryIdMatch,
  queryVersionMatch,
  listIdMatch,
  listVersionMatch,
  viewIdMatch,
  queriesMatch,
];

defineQuery({
  id: "mutate-row",
  version: 1,
  source: orders,
  params,
  result,
  handleQuery: (projection, queryParams, context) => {
    // @ts-expect-error projection rows are readonly
    projection.rows.push(projection.rows[0]);
    const row = projection.rows[0];
    if (row !== undefined) {
      // @ts-expect-error row values are readonly
      row.value.orderId = "mutated";
      // @ts-expect-error row keys are readonly
      row.key = "mutated";
    }
    // @ts-expect-error decoded params are readonly
    queryParams.roomId = "mutated";
    // @ts-expect-error handler context is readonly
    context.readHead = "mutated";
    return { count: queryParams.limit };
  },
});

defineListQuery({
  id: "mutate-items",
  version: 1,
  source: orders,
  params,
  item,
  handleFilter: (projection) => projection.rows.map((row) => ({ id: row.value.orderId })),
  handleSort: (items) => {
    // @ts-expect-error sort input elements are readonly
    items[0].id = "mutated";
    const sorted = items.slice();
    // @ts-expect-error sort result elements are readonly
    sorted[0].id = "mutated";
    return sorted;
  },
});

const filtered = listQuery.handleFilter({ rows: [] }, { roomId: "r", limit: 1 }, {});
// @ts-expect-error returned filter elements are readonly
filtered[0].id = "mutated";
const sorted = listQuery.handleSort(filtered, { roomId: "r", limit: 1 }, {});
// @ts-expect-error returned sort elements are readonly
sorted[0].id = "mutated";

defineQuery({
  id: "promise-query",
  version: 1,
  source: orders,
  params,
  result,
  // @ts-expect-error scalar handlers are synchronous
  handleQuery: async () => ({ count: 1 }),
});

defineListQuery({
  id: "promise-list",
  version: 1,
  source: orders,
  params,
  item,
  // @ts-expect-error list filters are synchronous
  handleFilter: async () => [{ id: "a" }],
  handleSort: (items) => items,
});

defineQuery({
  id: "wrong-result",
  version: 1,
  source: orders,
  params,
  result,
  // @ts-expect-error scalar results must match the decoded result schema
  handleQuery: () => ({ count: "nope" }),
});

defineListQuery({
  id: "wrong-item",
  version: 1,
  source: orders,
  params,
  item,
  // @ts-expect-error list items must match the decoded item schema
  handleFilter: () => [{ id: 1 }],
  handleSort: (items) => items,
});

defineQuery({
  id: "generic-handler",
  version: 1,
  source: orders,
  params,
  result,
  handleQuery: () => ({ count: 1 }),
  // @ts-expect-error scalar definitions do not accept a generic handler option
  handler: () => ({ count: 1 }),
});

// @ts-expect-error contracts do not expose server handlers
countQuery.contract.handleQuery({ rows: [] }, { roomId: "r", limit: 1 }, {});
// @ts-expect-error contracts do not expose server handlers
listQuery.contract.handleFilter({ rows: [] }, { roomId: "r", limit: 1 }, {});

defineQuery({
  id: "reserved-page-number",
  version: 1,
  source: orders,
  // @ts-expect-error PageNumber is a reserved control name
  params: z.strictObject({ PageNumber: z.number() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-page-size",
  version: 1,
  source: orders,
  // @ts-expect-error PageSize is a reserved control name
  params: z.strictObject({ PageSize: z.number() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-newest-first",
  version: 1,
  source: orders,
  // @ts-expect-error NewestFirst is a reserved control name
  params: z.strictObject({ NewestFirst: z.boolean() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-consistency",
  version: 1,
  source: orders,
  // @ts-expect-error consistency is a reserved control name
  params: z.strictObject({ consistency: z.string() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-page-number-camel",
  version: 1,
  source: orders,
  // @ts-expect-error pageNumber is a reserved control name
  params: z.strictObject({ pageNumber: z.number() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-page-size-camel",
  version: 1,
  source: orders,
  // @ts-expect-error pageSize is a reserved control name
  params: z.strictObject({ pageSize: z.number() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-newest-first-camel",
  version: 1,
  source: orders,
  // @ts-expect-error newestFirst is a reserved control name
  params: z.strictObject({ newestFirst: z.boolean() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-descending",
  version: 1,
  source: orders,
  // @ts-expect-error descending is a reserved control name
  params: z.strictObject({ descending: z.boolean() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-wait",
  version: 1,
  source: orders,
  // @ts-expect-error waitForSortableUniqueId is a reserved control name
  params: z.strictObject({ waitForSortableUniqueId: z.string() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
defineQuery({
  id: "reserved-signal",
  version: 1,
  source: orders,
  // @ts-expect-error signal is a reserved control name
  params: z.strictObject({ signal: z.string() }),
  result,
  handleQuery: () => ({ count: 1 }),
});
