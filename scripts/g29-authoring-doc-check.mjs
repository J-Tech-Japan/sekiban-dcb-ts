#!/usr/bin/env node
import { readFileSync } from "node:fs";

const document = readFileSync("docs/domain-authoring.md", "utf8");
const anchors = [
  "Sekiban@4fbd867",
  "EquipmentReservationCancelled.cs",
  "public record EquipmentReservationCancelled(",
  "EventPayloadWithTags GetEventWithTags()",
  "public static void Validate(this EquipmentReservationState.EquipmentReservationCheckedOut state)",
  "public static EquipmentReservationState Evolve(this EquipmentReservationState state, EquipmentReservationCancelled cancelled)",
  "public interface ICommandWithHandler<TSelf>",
  "public interface ICommandContext : ICoreCommandContext",
  "public record EventOrNone(EventPayloadWithTags? EventPayloadWithTags, bool HasEvent)",
  "public static EventOrNone Empty => new(default, false)",
  "const reservationCancelled = event(\"ReservationCancelled\"",
  "validateCancelReservation",
  "evolveReservationCancelled",
  "cancelReservationCommand",
  "const state = await context.state(reservationProjector, reservationTag(input.reservationId));",
  "context.append(reservationCancelled, reservationCancelled.make({ reservationId: input.reservationId }))",
  "return none(\"room is already released\")",
  "reservationProjector = projector({ id: \"ReservationProjector\"",
];
for (const anchor of anchors) {
  if (!document.includes(anchor)) throw new Error(`G29 authoring correspondence anchor missing: ${anchor}`);
}
const pinnedSources = [
  "templates/Sekiban.Dcb.Templates/content/Sekiban.Dcb.Orleans.Decider/SekibanDcbDecider.MeetingRoomModels/Events/EquipmentReservation/EquipmentReservationCancelled.cs",
  "templates/Sekiban.Dcb.Templates/content/Sekiban.Dcb.Orleans.Decider/SekibanDcbDecider.MeetingRoomModels/States/EquipmentReservation/Deciders/EquipmentReservationCancelledDecider.cs",
  "dcb/src/Sekiban.Dcb.WithResult.Model/Commands/ICommandWithHandler.cs",
  "dcb/src/Sekiban.Dcb.WithResult.Model/Commands/ICommandContext.cs",
  "dcb/src/Sekiban.Dcb.Core.Model/Events/EventOrNone.cs",
];
for (const source of pinnedSources) {
  if (!document.includes(`https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/${source}`)) {
    throw new Error(`G29 authoring correspondence source is not pinned: ${source}`);
  }
}
if (!document.includes("https://github.com/J-Tech-Japan/Sekiban/blob/4fbd8679b3a2eb2ef2e0694bc3152a59e6dda411/")) {
  throw new Error("G29 authoring correspondence is not pinned to the reviewed C# commit");
}
console.log(JSON.stringify({ anchors: anchors.length, pinnedSources: pinnedSources.length, pinnedCommit: "4fbd867", outcome: "passed" }, null, 2));
