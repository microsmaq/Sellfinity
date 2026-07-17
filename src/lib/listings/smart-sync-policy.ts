export const SMART_SYNC_RECOVERABLE_END_REASONS = [
  "SOURCE_UNAVAILABLE",
  "MANUAL",
] as const;

export type SmartSyncRecoverableEndReason =
  (typeof SMART_SYNC_RECOVERABLE_END_REASONS)[number];

export function isSmartSyncRecoverableEndReason(
  reason: string | null,
): reason is SmartSyncRecoverableEndReason {
  return SMART_SYNC_RECOVERABLE_END_REASONS.includes(
    reason as SmartSyncRecoverableEndReason,
  );
}
