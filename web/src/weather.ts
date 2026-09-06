import type { ForecastDay } from "./useEvents";

/**
 * Home Assistant's condition slugs. Unrecognized ones render without an icon
 * rather than hiding the temperatures.
 */
export const CONDITION_EMOJI: Record<string, string> = {
  sunny: "☀️",
  "clear-night": "🌙",
  partlycloudy: "⛅",
  cloudy: "☁️",
  fog: "🌫️",
  windy: "💨",
  "windy-variant": "💨",
  rainy: "🌦️",
  pouring: "🌧️",
  lightning: "🌩️",
  "lightning-rainy": "⛈️",
  hail: "🌨️",
  snowy: "❄️",
  "snowy-rainy": "🌨️",
  exceptional: "⚠️",
};

export function forecastFor(
  forecast: ForecastDay[],
  day: Date,
): ForecastDay | undefined {
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  return forecast.find((f) => f.date === key);
}
