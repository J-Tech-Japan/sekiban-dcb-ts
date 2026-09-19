import { AllocatorDurableObject } from "../packages/dcb-runtime/src/allocator/AllocatorDurableObject";

/** Process-local storage for the real allocator class. Ordinary issuance is unchanged. */
export function openAllocator(): AllocatorDurableObject {
  const data = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
    async transaction<T>(callback: (txn: typeof storage) => Promise<T>): Promise<T> {
      return callback(storage);
    },
  };
  return new AllocatorDurableObject({ storage } as never);
}
