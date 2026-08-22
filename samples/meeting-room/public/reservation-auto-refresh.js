/**
 * The post-commit reservation read is one server-side waitFor query. Keeping
 * its URL construction outside app.js gives the UI fixture a browser-free
 * way to prove that this path never starts a client polling loop.
 */
export const POST_COMMIT_RESERVATION_PAGE_SIZE = 20;

export function postCommitReservationListPath(commitSuid) {
  if (typeof commitSuid !== "string" || commitSuid.length === 0) {
    throw new TypeError("commitSuid must be a non-empty string");
  }
  return "/api/read/reservations?pageNumber=1&pageSize=" + POST_COMMIT_RESERVATION_PAGE_SIZE +
    "&newestFirst=true&waitForSortableUniqueId=" + encodeURIComponent(commitSuid);
}

export function requestPostCommitReservationList(fetchImpl, commitSuid) {
  return fetchImpl(postCommitReservationListPath(commitSuid), {
    headers: { Accept: "application/json" },
  });
}
