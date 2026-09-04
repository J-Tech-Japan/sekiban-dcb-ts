import fs from "node:fs";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? ".artifacts/sdt-g61-w148-public-cohort-compact.json";

if (!inputPath) {
  throw new Error(
    "usage: node .artifacts/g61-w148-compact.mjs <expanded-json> [compact-json]",
  );
}

const receipt = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const deployReceipt = JSON.parse(
  fs.readFileSync(".artifacts/sdt-g61-w148-deploy.json", "utf8"),
);
const healthProbe = JSON.parse(
  fs.readFileSync(".artifacts/sdt-g61-w148-health-probe.json", "utf8"),
);

const compact = {
  schema: "sdt-g61-w148-public-cohort-compact/v1",
  task: receipt.task,
  runId: receipt.runId,
  sourceHead: receipt.sourceHead,
  baseUrl: receipt.baseUrl,
  serviceId: receipt.serviceId,
  protocol: receipt.protocol,
  cohort: {
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    roomId: receipt.roomId,
    roomCommitSuid: receipt.setupRoom?.suid ?? null,
    finalCohortSuid: receipt.proof?.finalProjectorHeads?.RoomProjector ?? null,
    sampleCount: receipt.reservations?.length ?? 0,
    healthSnapshotCount: receipt.healthSnapshots?.length ?? 0,
    publicReadReceiptCount: receipt.publicReadReceipts?.length ?? 0,
    scheduledTickCount: receipt.scheduledPolls?.length ?? 0,
  },
  deployment: receipt.deployment,
  cloudflare: {
    deployCommand: deployReceipt.command,
    strippedEnvironmentNames: deployReceipt.strippedEnvironmentNames,
    deployExitCode: deployReceipt.exitCode,
    deploySignal: deployReceipt.signal,
    deployError: deployReceipt.error,
    deployStdout: deployReceipt.stdout,
    deployStderr: deployReceipt.stderr,
    conformanceHealthProbeStatus: healthProbe.status,
    conformanceHealthProbeResponseMs: healthProbe.responseMs,
    apiAuthorizationFailure: false,
    resourceCreationAttempted: false,
  },
  timing: receipt.timing,
  samples: receipt.reservations.map((sample) => ({
    ordinal: sample.ordinal,
    reservationId: sample.reservationId,
    suid: sample.suid,
    commit: {
      receivedAtMs: sample.commit.receivedAtMs,
      receivedAt: sample.commit.receivedAt,
      responseMs: sample.commit.responseMs,
    },
    pacing: sample.pacing,
    unsafe: {
      boundMs: sample.unsafe.boundMs,
      boundCheckedAtMs: sample.unsafe.boundCheckedAtMs,
      censoredAtBound: sample.unsafe.censoredAtBound,
      firstVisibleAtMs: sample.unsafe.firstVisibleAtMs,
      firstVisibleAt: sample.unsafe.firstVisibleAt,
      firstVisibleCommitToUnsafeMs: sample.unsafe.firstVisibleCommitToUnsafeMs,
      disposition: sample.unsafe.disposition,
    },
    projectorSafe: {
      reachedAtMs: sample.finalProjectorHeadReachedAtMs,
      reachedAt: sample.finalProjectorHeadReachedAt,
      commitToFinalHeadMs:
        sample.finalProjectorHeadReachedAtMs - sample.commit.receivedAtMs,
      finalHead: receipt.proof?.finalProjectorHeads ?? null,
    },
    tagStateSafe: {
      reachedAtMs: sample.tagStateReachedAtMs,
      reachedAt: sample.tagStateReachedAt,
      commitToTagStateMs:
        sample.tagStateReachedAtMs - sample.commit.receivedAtMs,
    },
  })),
  scheduledTicks: receipt.scheduledPolls.map((tick) => ({
    tickId: tick.tickId,
    observedAt: tick.observedAt,
    observedAtIso: tick.observedAtIso,
    coverage: {
      kind: tick.coverage?.kind ?? null,
      reason: tick.coverage?.reason ?? null,
      partitionTag: tick.coverage?.partitionTag ?? null,
      frontierSuid: tick.coverage?.frontierSuid ?? null,
    },
    projectors: tick.projectors.map((projector) => ({
      projectorId: projector.projectorId,
      attempted: projector.attempted,
      attemptedAt: projector.attemptedAt,
      outcome: projector.outcome,
      rawOutcome: projector.rawOutcome,
      reason: projector.reason ?? null,
      head: projector.head ?? null,
      headAgeMs: projector.headAgeMs ?? null,
    })),
    everyRegisteredProjectorAttempted: tick.everyRegisteredProjectorAttempted,
  })),
  tagStateReadSummary: {
    rawReadReceiptCount: receipt.tagStateReads?.length ?? 0,
    successfulRawReadCount:
      receipt.tagStateReads?.filter((read) => read.ok).length ?? 0,
    finalProofCount: receipt.proof?.finalTagStates?.length ?? 0,
  },
  tagStates: (receipt.proof?.finalTagStates ?? []).map((tagState) => ({
    tagStateId: tagState.tagStateId,
    expectedSuid: tagState.expectedSuid,
    lastSortedUniqueId: tagState.lastSortedUniqueId,
    version: tagState.version,
    observedAtMs: tagState.observedAtMs,
    observedAt: tagState.observedAt,
  })),
  proof: {
    status: receipt.proof?.status,
    completedAtMs: receipt.proof?.completedAtMs,
    completedAt: receipt.proof?.completedAt,
    finalProjectorHeads: receipt.proof?.finalProjectorHeads,
    everyProjectorReachedFinalSuid: receipt.proof?.everyProjectorReachedFinalSuid,
    everyCohortTagReturnedCommittedVersion:
      receipt.proof?.everyCohortTagReturnedCommittedVersion,
    within180Seconds: receipt.proof?.within180Seconds,
  },
  failures: receipt.failures,
};

fs.writeFileSync(outputPath, `${JSON.stringify(compact, null, 2)}\n`, {
  mode: 0o600,
});
fs.chmodSync(outputPath, 0o600);
