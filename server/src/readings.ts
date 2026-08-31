/**
 * The single reading shape every sensor source normalizes into — the sensor
 * counterpart of `CalendarEvent`. Adding a sensor backend means writing a
 * mapper to this type, never widening it with source-specific fields.
 */
export interface SensorReading {
  /** Stable across polls. `${sourceId}:${entityId}`. */
  id: string;
  sourceId: string;
  /** Backend-native identifier, e.g. a Home Assistant entity_id. */
  entityId: string;
  /** Display name, e.g. "Kitchen temperature". */
  label: string;
  /**
   * What the reading measures: "temperature", "humidity", "motion", "door",
   * "battery", … Comes from the backend's device class; "unknown" when the
   * backend doesn't say. The UI keys icons/formatting off this, so it renders
   * unrecognized kinds as plain text rather than dropping them.
   */
  kind: string;
  /** Raw state as reported, e.g. "21.4", "on", "open". */
  value: string;
  /** Parsed number when the state is numeric; absent for on/off, open/closed. */
  numericValue?: number;
  /** e.g. "°C", "%", "lx". */
  unit?: string;
  /** When the backend last saw this value change. UTC ISO. */
  updatedAt: string;
  /** True when the backend reports the device unavailable or unknown. */
  stale: boolean;
}
