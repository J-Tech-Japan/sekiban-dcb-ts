import type { DecisionLog } from "@sekiban/dcb-domain";

declare const log: DecisionLog;
void log.events[0]?.eventId;
