import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENABLED = process.env.SDT_G77_AC6_EMIT_REPORT === "1";
const ARTIFACT_DIR = resolve(process.cwd(), ".artifacts");

export default class G77Ac6VitestReporter {
  onTestCaseResult(testCase) {
    if (!ENABLED) return;
    const meta = testCase.task?.meta?.g77Ac6Report ?? testCase.meta?.g77Ac6Report;
    if (meta === undefined) return;
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const label = String(meta.label ?? testCase.name).replace(/[^a-zA-Z0-9._-]+/g, "-");
    writeFileSync(resolve(ARTIFACT_DIR, `g77-ac6-${label}.json`), JSON.stringify(meta, null, 2));
  }
}
