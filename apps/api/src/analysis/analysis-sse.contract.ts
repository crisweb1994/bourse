// The wire contract lives in @bourse/shared-types (KISS C3-1: the map was
// previously duplicated between this file and the web stream-state hook and
// had already drifted). Re-exported here so the module's existing imports
// keep working; treat this file as the API-side seam per local AGENTS.md.
export type {
  AnalysisSsePayloadMap,
  AnalysisSseEventName,
  AnalysisSseEvent,
  AnalysisSseCallback,
} from '@bourse/shared-types';
export { isAnalysisSseEventName } from '@bourse/shared-types';
