import type {
  ForecastDay,
  PersonLocation,
  SensorReading,
} from "../readings.js";
import type { SensorSource } from "./types.js";

export interface HomeAssistantConfig {
  id: string;
  label: string;
  /** Base URL, e.g. http://localhost:8123 — no trailing slash needed. */
  url: string;
  /** Long-lived access token: HA profile > Security > Long-lived tokens. */
  token: string;
  /**
   * Entity ids to show, in display order. Empty means no sensor strip at
   * all: a live HA instance ships dozens of diagnostic sensors (sun times,
   * backup state, ~20 per phone with the companion app), so "show all" is
   * never what the wall wants. Curate explicitly.
   */
  entities: string[];
  /**
   * Entity ids to show on the family map, in display order. Usually
   * `person.*` entities (which follow whichever tracker HA trusts most), but
   * a raw `device_tracker.*` works too. Empty means every `person.*` entity.
   */
  people: string[];
  /**
   * A weather entity (e.g. `weather.forecast_home`, created automatically by
   * HA's default met.no integration) for the calendar's daily forecast.
   * Unset means no forecast.
   */
  weatherEntity?: string;
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
    latitude?: number;
    longitude?: number;
    gps_accuracy?: number;
    temperature_unit?: string;
  };
}

/** One entry of weather.get_forecasts' daily response. */
interface HaForecastItem {
  datetime: string;
  condition?: string;
  temperature?: number;
  templow?: number;
}

export function createHomeAssistantSource(
  config: HomeAssistantConfig,
): SensorSource {
  const base = config.url.replace(/\/+$/, "");

  const fetchStates = async (): Promise<HaState[]> => {
    const response = await fetch(`${base}/api/states`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`home assistant returned ${response.status}`);
    }
    return (await response.json()) as HaState[];
  };

  return {
    id: config.id,
    label: config.label,

    async fetch(): Promise<SensorReading[]> {
      if (config.entities.length === 0) return [];
      const states = await fetchStates();

      const wanted = states.filter((s) =>
        config.entities.includes(s.entity_id),
      );

      const readings = wanted.map((s) => toReading(config.id, s));

      // Preserve the configured order — it's the display order on the wall.
      readings.sort(
        (a, b) =>
          config.entities.indexOf(a.entityId) -
          config.entities.indexOf(b.entityId),
      );
      return readings;
    },

    async fetchLocations(): Promise<PersonLocation[]> {
      const states = await fetchStates();

      const wanted = states.filter((s) =>
        config.people.length > 0
          ? config.people.includes(s.entity_id)
          : s.entity_id.startsWith("person."),
      );

      const locations = wanted.map((s) => toLocation(config.id, s));

      if (config.people.length > 0) {
        locations.sort(
          (a, b) =>
            config.people.indexOf(a.entityId) -
            config.people.indexOf(b.entityId),
        );
      }
      return locations;
    },

    ...(config.weatherEntity
      ? { fetchForecast: makeFetchForecast(base, config, config.weatherEntity) }
      : {}),
  };
}

function makeFetchForecast(
  base: string,
  config: HomeAssistantConfig,
  entity: string,
): () => Promise<ForecastDay[]> {
  return async () => {
    const headers = { Authorization: `Bearer ${config.token}` };

    // The unit lives on the entity; the forecast comes from a service call
    // (HA removed the forecast attribute from entity state in 2024).
    const stateRes = await fetch(`${base}/api/states/${entity}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!stateRes.ok) {
      throw new Error(`weather entity returned ${stateRes.status}`);
    }
    const unit =
      ((await stateRes.json()) as HaState).attributes.temperature_unit ?? "°";

    const res = await fetch(
      `${base}/api/services/weather/get_forecasts?return_response`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entity, type: "daily" }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`weather forecast returned ${res.status}`);
    }
    const payload = (await res.json()) as {
      service_response?: Record<string, { forecast?: HaForecastItem[] }>;
    };
    const items = payload.service_response?.[entity]?.forecast ?? [];

    return items.flatMap((item) => {
      if (typeof item.temperature !== "number" || !item.condition) return [];
      return [
        {
          sourceId: config.id,
          date: localDateKey(new Date(item.datetime)),
          condition: item.condition,
          high: item.temperature,
          ...(typeof item.templow === "number" ? { low: item.templow } : {}),
          unit,
        },
      ];
    });
  };
}

export interface ShoppingItem {
  uid: string;
  summary: string;
  done: boolean;
}

export interface ShoppingList {
  getItems(): Promise<ShoppingItem[]>;
  add(summary: string): Promise<void>;
  setStatus(uid: string, done: boolean): Promise<void>;
  remove(uid: string): Promise<void>;
}

/**
 * Home Assistant's todo list as the family shopping list. HA is the owner so
 * phones (HA companion app) and the wall edit the same list; this server is
 * just another client. Every method throws on failure — routes surface it.
 */
export function createShoppingList(config: {
  url: string;
  token: string;
  /** e.g. `todo.shopping_list`, created by HA's Shopping list integration. */
  entity: string;
}): ShoppingList {
  const base = config.url.replace(/\/+$/, "");

  // HA 400s when return_response is requested from a service that returns
  // nothing, so only get_items asks for one.
  const call = async (
    service: string,
    body: object,
    wantsResponse = false,
  ): Promise<unknown> => {
    const response = await fetch(
      `${base}/api/services/todo/${service}${wantsResponse ? "?return_response" : ""}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entity_id: config.entity, ...body }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`shopping list ${service} returned ${response.status}`);
    }
    return response.json();
  };

  return {
    async getItems(): Promise<ShoppingItem[]> {
      const payload = (await call("get_items", {}, true)) as {
        service_response?: Record<
          string,
          { items?: { uid: string; summary: string; status: string }[] }
        >;
      };
      const items = payload.service_response?.[config.entity]?.items ?? [];
      return items.map((i) => ({
        uid: i.uid,
        summary: i.summary,
        done: i.status === "completed",
      }));
    },
    async add(summary: string): Promise<void> {
      await call("add_item", { item: summary });
    },
    async setStatus(uid: string, done: boolean): Promise<void> {
      await call("update_item", {
        item: uid,
        status: done ? "completed" : "needs_action",
      });
    },
    async remove(uid: string): Promise<void> {
      await call("remove_item", { item: uid });
    },
  };
}

/** YYYY-MM-DD in the server's local timezone — the display's timezone too. */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

function toLocation(sourceId: string, state: HaState): PersonLocation {
  const { latitude, longitude, gps_accuracy } = state.attributes;
  const hasFix =
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude);

  return {
    id: `${sourceId}:${state.entity_id}`,
    sourceId,
    entityId: state.entity_id,
    name:
      state.attributes.friendly_name ??
      state.entity_id.replace(/^[^.]+\./, ""),
    zone: state.state,
    ...(hasFix ? { latitude, longitude } : {}),
    ...(hasFix && typeof gps_accuracy === "number"
      ? { gpsAccuracy: gps_accuracy }
      : {}),
    updatedAt: new Date(state.last_updated).toISOString(),
    stale: state.state === "unavailable" || state.state === "unknown",
  };
}
