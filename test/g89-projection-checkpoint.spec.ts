import { describe, expect, it } from "vitest";

import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
} from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import {
  ProjectionCheckpointCorruption,
  ProjectionRuntime,
  projectionIdFor,
} from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { PipelineStore, ProjectionCheckpoint } from "../packages/dcb-runtime/src/store/types";

const SERVICE_ID = "g89-checkpoint-service";
const TAG = "orders:g89-checkpoint";
const IDENTITY = tagStateIdentityFrom(`${TAG}:test-projector`, DEPLOYED_PROJECTOR_REGISTRY).value!;

describe("SDT-G89 projection checkpoint corruption", () => {
  it("AC9(b): maps checkpoint deserialize failures to ProjectionCheckpointCorruption", async () => {
    const checkpoint: ProjectionCheckpoint = {
      serviceId: SERVICE_ID,
      projectionId: projectionIdFor(IDENTITY),
      lastSuid: "g89-suid",
      stateJson: "not-json",
      version: 1,
      updatedAt: 0,
    };
    const store = {
      initialize: async (): Promise<void> => undefined,
      readAllEvents: async (): Promise<[]> => [],
      currentLagBound: async (): Promise<number> => 0,
      listProjectionTags: async (): Promise<string[]> => [TAG],
      readProjectionCheckpoint: async (): Promise<ProjectionCheckpoint> => checkpoint,
      advanceProjectionCheckpoint: async (): Promise<boolean> => true,
      projectionLag: async () => ({
        serviceId: SERVICE_ID,
        projectionId: checkpoint.projectionId,
        tag: TAG,
        checkpointSuid: checkpoint.lastSuid,
        headSuid: checkpoint.lastSuid,
        behindEvents: 0,
      }),
      appendDeliveryIncident: async (): Promise<void> => undefined,
    } as unknown as PipelineStore;
    const runtime = new ProjectionRuntime(store, DEPLOYED_PROJECTOR_REGISTRY);
    await expect(runtime.catchUp(SERVICE_ID, IDENTITY, 0)).rejects.toBeInstanceOf(ProjectionCheckpointCorruption);
  });
});
