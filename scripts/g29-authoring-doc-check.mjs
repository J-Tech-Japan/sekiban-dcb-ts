#!/usr/bin/env node
import { readFileSync } from "node:fs";

const document = readFileSync("docs/domain-authoring.md", "utf8");
const anchors = [
  "Sekiban@4fbd867",
  "EquipmentReservationCancelled.cs",
  "public record EquipmentReservationCancelled(",
  "EventPayloadWithTags GetEventWithTags()",
  "const reservationCancelled = event(\"ReservationCancelled\"",
  "validateCancelReservation",
  "evolveReservationCancelled",
  "cancelReservationCommand",
  "reservationProjector = projector({ id: \"ReservationProjector\"",
];
for (const anchor of anchors) {
  if (!document.includes(anchor)) throw new Error(`G29 authoring correspondence anchor missing: ${anchor}`);
}
if (!document.includes("https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/")) {
  throw new Error("G29 authoring correspondence is not pinned to the reviewed C# commit");
}
console.log(JSON.stringify({ anchors: anchors.length, pinnedCommit: "4fbd867", outcome: "passed" }, null, 2));
