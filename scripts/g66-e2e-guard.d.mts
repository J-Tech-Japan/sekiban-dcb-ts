export interface G66ReceiptResult {
  readonly shape: "pass";
  readonly acceptance: {
    readonly allAccepted: boolean;
    readonly allUnsafeWithinBound: boolean;
    readonly allSafeWithinBound: boolean;
    readonly continuousPacedWrites: boolean;
    readonly tagStateAndQueryReads: boolean;
    readonly coverageAndFrontierObserved: boolean;
    readonly observedResponseRelativeReads: boolean;
    readonly finalQueryConsistency: boolean;
  };
  readonly passed: boolean;
}

export declare function inspectG66Receipt(receipt: unknown): G66ReceiptResult;
export declare function createG66GuardFixture(): unknown;
