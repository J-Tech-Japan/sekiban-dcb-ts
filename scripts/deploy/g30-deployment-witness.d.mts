export interface G30DeployedVersion {
  id: string;
  number: number;
  createdOn: string;
  source: string;
  message: string;
}

export interface G30DeploymentWitness {
  task: "SDT-G30";
  phase: "A" | "B" | "A-prime";
  sourceCommit: string;
  configDigest: string;
  placement: "off";
  serviceId: string;
  worker: string;
  deployedVersion: G30DeployedVersion;
  source: "wrangler-versions-list-json";
}

export function deploymentMessage(phase: "A" | "B" | "A-prime", commit: string, digest: string, serviceId: string): string;
export function selectDeployedVersion(versions: unknown, expectedMessage: string): G30DeployedVersion;
export function buildDeploymentWitness(input: {
  phase: "A" | "B" | "A-prime";
  sourceCommit: string;
  configDigest: string;
  serviceId: string;
  worker: string;
  versions: unknown;
}): G30DeploymentWitness;
export function selfTest(): Readonly<Record<string, unknown>>;
