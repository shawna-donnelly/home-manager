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

/**
 * One day of weather forecast, normalized from the backend (Home Assistant's
 * built-in met.no integration; any weather entity works).
 */
export interface ForecastDay {
  sourceId: string;
  /** Local calendar date, YYYY-MM-DD, computed in the server's timezone. */
  date: string;
  /** Backend condition slug: "sunny", "partlycloudy", "rainy", "snowy", … */
  condition: string;
  /** Daily high; `low` is absent when the backend doesn't provide one. */
  high: number;
  low?: number;
  /** e.g. "°F". */
  unit: string;
}

/**
 * Where a family member is, normalized from the backend's person/device
 * tracker. Coordinates are optional: a person exists the moment Home Assistant
 * knows about them, but has no position until their phone reports one — the
 * map should list them as "no location yet" rather than drop them.
 */
export interface PersonLocation {
  /** Stable across polls. `${sourceId}:${entityId}`. */
  id: string;
  sourceId: string;
  /** Backend-native identifier, e.g. `person.shawna`. */
  entityId: string;
  /** Display name, e.g. "Shawna". */
  name: string;
  /**
   * The backend's zone state: "home", "not_home", or a named zone
   * ("School", "Work"). The UI maps home/not_home to friendlier words.
   */
  zone: string;
  latitude?: number;
  longitude?: number;
  /** Metres, when the backend reports GPS accuracy. */
  gpsAccuracy?: number;
  /** When the backend last saw this person's state change. UTC ISO. */
  updatedAt: string;
  /** True when the backend reports the tracker unavailable or unknown. */
  stale: boolean;
}

/**
 * A controllable light, normalized from the backend (Home Assistant `light.*`
 * entities). Unlike a SensorReading this is read/write: the wall shows its
 * state and offers on/off, brightness, and colour. Capability flags come from
 * the backend's supported_color_modes so the UI only shows controls the bulb
 * actually has.
 */
export interface LightState {
  /** Stable across polls. `${sourceId}:${entityId}`. */
  id: string;
  sourceId: string;
  /** Backend-native identifier, e.g. `light.lightbulb_1`. */
  entityId: string;
  /** Display name, e.g. "Lightbulb 1". */
  name: string;
  on: boolean;
  /** 0–255 when the backend reports it; absent for on/off-only bulbs. */
  brightness?: number;
  /** Current colour as [r, g, b], 0–255, when the bulb is showing one. */
  rgb?: [number, number, number];
  /** True if the bulb can show colours (rgb/xy/hs). */
  supportsColor: boolean;
  /** True if the bulb can do tunable white (colour temperature). */
  supportsColorTemp: boolean;
  /** False when the backend reports the bulb unavailable/unknown. */
  reachable: boolean;
  /** When the backend last saw this light's state change. UTC ISO. */
  updatedAt: string;
}
