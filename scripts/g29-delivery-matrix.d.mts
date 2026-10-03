export interface G29DeliveryDescriptor {
  readonly [viewId: string]: string;
}

export interface G29DeliveryExpectedDescriptor {
  readonly domainClass: string;
  readonly viewClasses: G29DeliveryDescriptor;
}

export interface G29DeliveryRow {
  readonly rowId: string;
  readonly domainClass: string;
  readonly deployment: string;
  readonly allowlist: string;
  readonly expectedDescriptor: G29DeliveryExpectedDescriptor;
  readonly expectedStatus: string;
  readonly expectedReason: string;
  readonly expectedViews: readonly string[];
  readonly directInvocations: number;
  readonly queueInvocations: number;
}

export interface G29DeliveryMatrix {
  readonly schemaVersion: number;
  readonly descriptor: G29DeliveryDescriptor;
  readonly rows: readonly G29DeliveryRow[];
}

export interface G29DeliveryActualValue {
  readonly descriptor: G29DeliveryExpectedDescriptor;
  readonly status: string;
  readonly reason: string;
  readonly views: readonly string[];
  readonly directInvocations: number;
  readonly queueInvocations: number;
}

export type G29DeliveryMatrixReader = (file: string) => string;

export declare function loadDeliveryMatrix(read?: G29DeliveryMatrixReader): G29DeliveryMatrix;
export declare function assertDeliveryMatrix(
  actual: Readonly<Record<string, G29DeliveryActualValue>>,
  expected?: G29DeliveryMatrix,
): { rows: number };
