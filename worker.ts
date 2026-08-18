/**
 * Consumer Worker entrypoint.  The deployment consumes the runtime package
 * through its public export surface so a self-hosted Worker follows the same
 * Durable Object re-export pattern as downstream applications.
 */
import runtimeWorker, {
  AllocatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  handleDownstreamQueue,
  stabilizeDownstream,
} from "@sekiban/dcb-runtime";

export { AllocatorDurableObject, JournalDurableObject, TagDurableObject, handleDownstreamQueue, stabilizeDownstream };
export default runtimeWorker;
