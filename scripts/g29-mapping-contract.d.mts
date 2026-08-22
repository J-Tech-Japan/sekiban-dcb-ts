export interface G29MappingRow {
  readonly rowId: string;
  readonly [column: string]: string;
}
export interface G29Mapping {
  readonly schemaVersion: number;
  readonly columns: readonly string[];
  readonly rows: readonly G29MappingRow[];
}
export declare function validateMapping(value: unknown): G29Mapping;
export declare function assertMappingContract(actual: Record<string, Record<string, string>>, mapping?: G29Mapping): { rows: number; columns: number };
export declare function mutateMapping(actual: Record<string, Record<string, string>>, rowId: string, column: string): Record<string, Record<string, string>>;
