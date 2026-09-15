import { useEffect, useRef, useState } from "react";
import { callAllowed } from "./tapguard";
import type { LightState } from "./useEvents";

/**
 * Lights tab. Built for kids on a touch panel: one big on/off target per bulb,
 * a fat brightness slider, and a palette of tappable colour circles. Every
 * change is optimistic (the UI moves on tap) and confirmed a beat later when
 * the server refetches the light and the SSE frame comes back.
 */

const COLORS: { name: string; rgb: [number, number, number] }[] = [
  { name: "Red", rgb: [255, 41, 41] },
  { name: "Orange", rgb: [255, 128, 0] },
  { name: "Yellow", rgb: [255, 214, 0] },
  { name: "Green", rgb: [40, 200, 64] },
  { name: "Teal", rgb: [0, 200, 180] },
  { name: "Sky", rgb: [0, 160, 255] },
  { name: "Blue", rgb: [50, 70, 255] },
  { name: "Purple", rgb: [160, 70, 255] },
  { name: "Pink", rgb: [255, 90, 200] },
  { name: "Magenta", rgb: [255, 0, 120] },
];

const WHITES: { name: string; kelvin: number }[] = [
  { name: "Warm", kelvin: 2700 },
  { name: "Soft", kelvin: 3500 },
  { name: "Bright", kelvin: 5000 },
  { name: "Daylight", kelvin: 6500 },
];

interface LightCommand {
  on?: boolean;
  brightness?: number;
  rgb?: [number, number, number];
  kelvin?: number;
}

function post(entityId: string, cmd: LightCommand): void {
  fetch(`/api/lights/${encodeURIComponent(entityId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  }).catch(() => {
    // A dropped command is harmless — the next SSE frame re-syncs the UI.
  });
}

export default function Lights({ lights }: { lights: LightState[] }) {
  if (lights.length === 0) {
    return <p className="lights__empty">No lights paired yet.</p>;
  }
  return (
    <ul className="lights">
      {lights.map((light) => (
        <LightCard key={light.id} light={light} />
      ))}
    </ul>
  );
}

function LightCard({ light }: { light: LightState }) {
  const [on, setOn] = useState(light.on);
  const [bri, setBri] = useState(light.brightness ?? 255);
  // While a finger is on the slider, don't let an incoming frame yank it back.
  const dragging = useRef(false);

  useEffect(() => setOn(light.on), [light.on]);
  useEffect(() => {
    if (!dragging.current && typeof light.brightness === "number") {
      setBri(light.brightness);
    }
  }, [light.brightness]);

  const toggle = () => {
    if (!callAllowed(`light-toggle-${light.entityId}`)) return;
    const next = !on;
    setOn(next);
    post(light.entityId, { on: next });
  };

  const slideBri = (v: number) => {
    setBri(v);
    setOn(true);
    // Throttle the stream of slider events; the final value is sent on release.
    if (callAllowed(`light-bri-${light.entityId}`, 200)) {
      post(light.entityId, { brightness: v, on: true });
    }
  };
  const commitBri = () => {
    if (!dragging.current) return;
    dragging.current = false;
    post(light.entityId, { brightness: bri, on: true });
  };

  const pickColor = (rgb: [number, number, number]) => {
    if (!callAllowed(`light-color-${light.entityId}`)) return;
    setOn(true);
    post(light.entityId, { rgb, on: true });
  };
  const pickWhite = (kelvin: number) => {
    if (!callAllowed(`light-white-${light.entityId}`)) return;
    setOn(true);
    post(light.entityId, { kelvin, on: true });
  };

  const glow =
    on && light.rgb
      ? `rgb(${light.rgb[0]}, ${light.rgb[1]}, ${light.rgb[2]})`
      : on
        ? "#ffcf6b"
        : "#c9cdd6";
  const pct = Math.round((bri / 255) * 100);

  return (
    <li className={`light${on ? " light--on" : ""}${light.reachable ? "" : " light--off-grid"}`}>
      <div className="light__head">
        <button
          type="button"
          className="light__bulb"
          style={{ "--glow": glow } as React.CSSProperties}
          onClick={toggle}
          disabled={!light.reachable}
          aria-pressed={on}
          aria-label={`${light.name}: turn ${on ? "off" : "on"}`}
        >
          <span aria-hidden>💡</span>
        </button>
        <div className="light__meta">
          <span className="light__name">{light.name}</span>
          <span className="light__state">
            {!light.reachable ? "Offline" : on ? `On · ${pct}%` : "Off"}
          </span>
        </div>
      </div>

      {light.reachable && on && light.brightness !== undefined && (
        <input
          className="light__slider"
          type="range"
          min={5}
          max={255}
          value={bri}
          aria-label={`${light.name} brightness`}
          onPointerDown={() => (dragging.current = true)}
          onChange={(e) => slideBri(Number(e.target.value))}
          onPointerUp={commitBri}
          onPointerCancel={commitBri}
        />
      )}

      {light.reachable && light.supportsColor && (
        <div className="light__swatches" role="group" aria-label={`${light.name} colours`}>
          {COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              className="swatch"
              style={{ background: `rgb(${c.rgb.join(",")})` }}
              onClick={() => pickColor(c.rgb)}
              aria-label={c.name}
              title={c.name}
            />
          ))}
        </div>
      )}

      {light.reachable && (light.supportsColorTemp || light.supportsColor) && (
        <div className="light__whites" role="group" aria-label={`${light.name} white`}>
          {WHITES.map((w) => (
            <button
              key={w.name}
              type="button"
              className="light__white"
              onClick={() => pickWhite(w.kelvin)}
            >
              {w.name}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
