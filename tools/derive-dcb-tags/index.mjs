#!/usr/bin/env node
import { readFileSync } from "node:fs";

const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000n;
const TICKS_PER_MILLISECOND = 10000n;
const DOTNET_MAX_TICKS = 3155378975999999999n;

function fail(message) {
  throw new Error(`derive-dcb-tags: ${message}`);
}

export function parseSortableUniqueId(value) {
  if (typeof value !== "string" || !/^[0-9]{30}$/.test(value)) fail("sortableUniqueId must be exactly 30 ASCII digits");
  const ticks = BigInt(value.slice(0, 19));
  if (ticks > DOTNET_MAX_TICKS) fail("sortableUniqueId ticks exceed the .NET DateTime range");
  return Object.freeze({ value, ticks });
}

export function tagGroup(tag) {
  if (typeof tag !== "string" || tag.length === 0) fail("tag must be a non-empty string");
  const separator = tag.indexOf(":");
  return separator < 0 ? tag : tag.slice(0, separator);
}

function binaryCompare(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function csharpSortableUniqueIdDateTime(suid) {
  const { ticks } = parseSortableUniqueId(suid);
  const delta = ticks - DOTNET_UNIX_EPOCH_TICKS;
  if (delta < 0n) fail("sortableUniqueId predates the Unix epoch and cannot be emitted as UTC JSON");
  const milliseconds = delta / TICKS_PER_MILLISECOND;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) fail("sortableUniqueId UTC time exceeds JavaScript Date range");
  const fractionalTicks = (delta % TICKS_PER_MILLISECOND).toString().padStart(4, "0");
  const iso = new Date(Number(milliseconds)).toISOString();
  return iso.replace(/\.(\d{3})Z$/, `.$1${fractionalTicks}Z`);
}

function eventsFrom(value) {
  const events = Array.isArray(value) ? value : value?.events;
  if (!Array.isArray(events)) fail("input must be an event array or { events } object");
  return events.map((event, index) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) fail(`event ${index} must be an object`);
    const { serviceId, id, sortableUniqueId, eventType, tags, timestamp } = event;
    if (typeof serviceId !== "string" || !serviceId || typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || typeof eventType !== "string" || !eventType || eventType.includes(":") || typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{4})?Z$/.test(timestamp) || !Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag.length > 0)) {
      fail(`event ${index} is not a G32 logical record`);
    }
    parseSortableUniqueId(sortableUniqueId);
    return { serviceId, id, sortableUniqueId, eventType, tags, timestamp };
  });
}

/** Derive rebuildable C# tag rows without reading a wall clock. */
export function deriveDcbTags(value, provider) {
  if (provider !== "postgres" && provider !== "sqlite" && provider !== "cosmos") fail("provider must be postgres, sqlite, or cosmos");
  const rows = [];
  for (const event of eventsFrom(value)) {
    for (const tag of [...new Set(event.tags)]) {
      rows.push({ event, tag });
    }
  }
  rows.sort((left, right) =>
    binaryCompare(left.event.sortableUniqueId, right.event.sortableUniqueId) ||
    binaryCompare(left.tag, right.tag) ||
    binaryCompare(left.event.id, right.event.id),
  );
  return Object.freeze(rows.map(({ event, tag }, index) => {
    const common = Object.freeze({
      serviceId: event.serviceId,
      tag,
      tagGroup: tagGroup(tag),
      eventType: event.eventType,
      sortableUniqueId: event.sortableUniqueId,
      eventId: event.id,
    });
    if (provider === "cosmos") {
      return Object.freeze({
        pk: `${event.serviceId}|${tag}`,
        id: event.id,
        ...common,
        createdAt: csharpSortableUniqueIdDateTime(event.sortableUniqueId),
      });
    }
    return Object.freeze({
      id: index + 1,
      ...common,
      createdAt: event.timestamp,
    });
  }));
}

function main() {
  const [provider, path] = process.argv.slice(2);
  if (provider === undefined || path === undefined || process.argv.length !== 4) {
    fail("usage: derive-dcb-tags <postgres|sqlite|cosmos> <events.json>");
  }
  const source = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(`${JSON.stringify(deriveDcbTags(source, provider), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
