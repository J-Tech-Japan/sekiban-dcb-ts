import { event } from "@sekiban/dcb-domain";
import { z } from "zod";

event("MissingTags", z.object({ id: z.string() }), {});
