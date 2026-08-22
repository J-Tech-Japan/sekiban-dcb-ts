export interface G29DeliveryRow {
  readonly rowId: string;
  readonly expectedStatus: string;
  readonly expectedViews: readonly string[];
}
export interface G29DeliveryMatrix {
  readonly schemaVersion: number;
  readonly rows: readonly G29DeliveryRow[];
}
export declare function loadDeliveryMatrix(value?: unknown): G29DeliveryMatrix;
export declare function assertDeliveryMatrix(actual: Record<string, { readonly status: string; readonly views: readonly string[] }>, expected?: G29DeliveryMatrix): { rows: number };
