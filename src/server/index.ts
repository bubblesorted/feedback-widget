export { assetFileName, createFeedbackHandler, errorResponse, sameOrigin, verifyAsset, type FeedbackHandler } from "./handler";
// For a site with its own transport (the widget's `submit` prop): check the manifest, verify each file's bytes, then
// deliver with sendCapture. Its journal makes a retry reuse uploads; the capture id makes the issue idempotent.
export {
  sendCapture,
  type AssetJournal,
  type CaptureAsset,
  type CaptureContext,
  type Delivered,
  type LinearAccess,
  type SendOptions,
} from "./linear";
export { linearUrl } from "./config";
export { checkManifest } from "../contract";
export { LINEAR_GRAPHQL_URL, type Authorization, type FeedbackServerConfig, type LinearDestination, type Reporter } from "./config";
export { FeedbackError, KEY_FORBIDDEN, KEY_REJECTED, type FeedbackCode } from "./linear";
