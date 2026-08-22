export const POST_COMMIT_RESERVATION_PAGE_SIZE: number;

export function postCommitReservationListPath(commitSuid: string): string;

export function requestPostCommitReservationList(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  commitSuid: string,
): Promise<Response>;
