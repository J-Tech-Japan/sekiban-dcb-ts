import { ClientError } from "./errors.js";

/** The largest delay a timer accepts; a larger or non-finite delay fires at once or never. */
export const MAX_TOTAL_BUDGET_MS = 2147483647;

/** Why a `totalBudgetMs` value is refused, or `undefined` when it is accepted. */
export function totalBudgetMsProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TOTAL_BUDGET_MS) return undefined;
  return `totalBudgetMs must be undefined or a finite number from 0 to ${MAX_TOTAL_BUDGET_MS}; received ${String(value)}`;
}

/**
 * Start `operation` only if the signal has not fired and the deadline has not
 * passed, then await it under both: an abort rejects with `aborted` and an
 * expiry rejects with `timeout`, without waiting for the operation to settle.
 */
export function awaitControlled<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new ClientError("aborted", "Execution was aborted"));
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) return Promise.reject(new ClientError("timeout", "Execution budget expired"));
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
  if (signal === undefined && remaining === undefined) return pending;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ClientError("aborted", "Execution was aborted"));
    };
    if (remaining !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new ClientError("timeout", "Execution budget expired"));
      }, remaining);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.then((value) => {
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}
