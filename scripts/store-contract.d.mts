import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";

export function runPipelineContract(label: string, makeStore: () => Promise<PipelineStore>): Promise<void>;
export function runFaultSuite(): Promise<void>;
