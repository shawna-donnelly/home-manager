import type { SensorReading } from "../readings.js";
import type { SensorSource } from "./types.js";

export interface HomeAssistantConfig {
  id: string;
  label: string;
  /** Base URL, e.g. http://localhost:8123 — no trailing slash needed. */
  url: string;
  /** Long-lived access token: HA profile > Security > Long-lived tokens. */
  token: string;
  /**
   * Entity ids to show, in display order. Empty means every `sensor.*` and
   * `binary_sensor.*` entity — fine for a first look, but HA accumulates
   * diagnostic noise (update checkers, signal strength), so list what the
   * wall should actually show once things are paired.
   */
  entities: string[];
}

/** The subset of HA's /api/states response this adapter reads. */
interface HaState {
  entity_id: string;
  state: string;
  last_updated: string;
  attributes: {
    friendly_name?: string;
    device_class?: string;
    unit_of_measurement?: string;
  };
}

export function createHomeAssistantSource(
  config: HomeAssistantConfig,
): SensorSource {
  const base = config.url.replace(/\/+$/, "");

  return {
    id: config.id,
    label: config.label,

    async fetch(): Promise<SensorReading[]> {
      const response = await fetch(`${base}/api/states`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`home assistant returned ${response.status}`);
      }
      const states = (await response.json()) as HaState[];

      const wanted = states.filter((s) =>
        config.entities.length > 0
          ? config.entities.includes(s.entity_id)
          : /^(sensor|binary_sensor)\./.test(s.entity_id),
      );

      const readings = wanted.map((s) => toReading(config.id, s));

      // Preserve the configured order — it's the display order on the wall.
      if (config.entities.length > 0) {
        readings.sort(
          (a, b) =>
            config.entities.indexOf(a.entityId) -
            config.entities.indexOf(b.entityId),
        );
      }
      return readings;
    },
  };
}

function toReading(sourceId: string, state: HaState): SensorReading {
  const numeric = Number(state.state);
  const stale = state.state === "unavailable" || state.state === "unknown";

  return {
    id: `${sourceId}:${state.entity_id}`,
    sourceId,
    entityId: state.entity_id,
    label: state.attributes.friendly_name ?? state.entity_id,
    kind: state.attributes.device_class ?? "unknown",
    value: state.state,
    ...(Number.isFinite(numeric) && state.state.trim() !== ""
      ? { numericValue: numeric }
      : {}),
    ...(state.attributes.unit_of_measurement
      ? { unit: state.attributes.unit_of_measurement }
      : {}),
    updatedAt: new Date(state.last_updated).toISOString(),
    stale,
  };
}
