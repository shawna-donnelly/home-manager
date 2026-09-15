import { useEffect, useRef, useState } from "react";
import { callAllowed } from "./tapguard";
import type { LightConfig, LightState } from "./useEvents";

/**
 * Lights tab. Built for kids on a touch panel: one big on/off target per bulb,
 * a fat brightness slider, and a palette of tappable colour circles. Bulbs are
 * grouped into rooms (a room header sets every bulb in it at once), and named
 * themes save each bulb's state to re-apply with one tap. Room assignment and
 * theme deletion live behind an "Edit" toggle so day-to-day taps can't
 * reorganise anything by accident. Every change is optimistic and confirmed a
 * beat later when the server refetches the lights.
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

function post(url: string, body?: unknown): void {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    // A dropped command is harmless — the next SSE frame re-syncs the UI.
  });
}

function setLight(entityId: string, cmd: LightCommand): void {
  post(`/api/lights/${encodeURIComponent(entityId)}`, cmd);
}

const UNASSIGNED = "";

export default function Lights({
  lights,
  config,
}: {
  lights: LightState[];
  config?: LightConfig;
}) {
  const [editMode, setEditMode] = useState(false);
  const [modal, setModal] = useState<{
    title: string;
    placeholder: string;
    onSubmit: (value: string) => void;
  } | null>(null);

  const rooms = config?.rooms ?? {};
  const themes = config?.themes ?? [];
  const roomNames = Array.from(new Set(Object.values(rooms))).sort((a, b) =>
    a.localeCompare(b),
  );

  // Group bulbs by room, named rooms first (alphabetical), unassigned last.
  const groups: { room: string; lights: LightState[] }[] = [];
  for (const name of roomNames) {
    const inRoom = lights.filter((l) => rooms[l.entityId] === name);
    if (inRoom.length > 0) groups.push({ room: name, lights: inRoom });
  }
  const unassigned = lights.filter((l) => !rooms[l.entityId]);
  if (unassigned.length > 0) groups.push({ room: UNASSIGNED, lights: unassigned });

  const applyTheme = (id: string) => {
    if (!callAllowed(`theme-${id}`)) return;
    post(`/api/themes/${encodeURIComponent(id)}/apply`);
  };
  const deleteTheme = (id: string) => {
    fetch(`/api/themes/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
      () => {},
    );
  };
  const saveTheme = () =>
    setModal({
      title: "Save the current lights as a theme",
      placeholder: "e.g. Movie Night",
      onSubmit: (name) => {
        post("/api/themes", { name });
        setModal(null);
      },
    });

  const assignRoom = (entityId: string, value: string) => {
    if (value === "__new__") {
      setModal({
        title: "New room name",
        placeholder: "e.g. Living Room",
        onSubmit: (name) => {
          post("/api/rooms/assign", { entityId, room: name });
          setModal(null);
        },
      });
    } else {
      post("/api/rooms/assign", { entityId, room: value });
    }
  };

  if (lights.length === 0) {
    return <p className="lights__empty">No lights paired yet.</p>;
  }

  return (
    <div className="lightstab">
      <div className="lights__bar">
        <div className="themes">
          {themes.map((t) => (
            <span key={t.id} className="theme">
              <button
                type="button"
                className="theme__apply"
                onClick={() => applyTheme(t.id)}
              >
                {t.name}
              </button>
              {editMode && (
                <button
                  type="button"
                  className="theme__del"
                  onClick={() => deleteTheme(t.id)}
                  aria-label={`Delete ${t.name}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <button type="button" className="theme__save" onClick={saveTheme}>
            ＋ Save theme
          </button>
        </div>
        <button
          type="button"
          className={`lights__edit${editMode ? " lights__edit--on" : ""}`}
          onClick={() => setEditMode((m) => !m)}
        >
          {editMode ? "Done" : "Edit"}
        </button>
      </div>

      {groups.map((g) => (
        <section className="room" key={g.room || "__unassigned__"}>
          <div className="room__head">
            <h2 className="room__name">{g.room || "Unassigned"}</h2>
            {g.room && <RoomControls room={g.room} />}
          </div>
          <ul className="lights">
            {g.lights.map((light) => (
              <LightCard
                key={light.id}
                light={light}
                editMode={editMode}
                room={rooms[light.entityId] ?? UNASSIGNED}
                roomNames={roomNames}
                onAssign={assignRoom}
              />
            ))}
          </ul>
        </section>
      ))}

      {modal && (
        <NameModal
          title={modal.title}
          placeholder={modal.placeholder}
          onSubmit={modal.onSubmit}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/** Header controls that fan a single command out to every bulb in a room. */
function RoomControls({ room }: { room: string }) {
  const apply = (cmd: LightCommand) => {
    if (!callAllowed(`room-${room}-${JSON.stringify(cmd)}`)) return;
    post("/api/rooms/apply", { room, ...cmd });
  };
  return (
    <div className="room__controls">
      <button type="button" className="room__btn" onClick={() => apply({ on: true })}>
        All on
      </button>
      <button
        type="button"
        className="room__btn"
        onClick={() => apply({ on: false })}
      >
        All off
      </button>
      <div className="room__swatches" role="group" aria-label={`${room} colour`}>
        {COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            className="swatch swatch--sm"
            style={{ background: `rgb(${c.rgb.join(",")})` }}
            onClick={() => apply({ rgb: c.rgb, on: true })}
            aria-label={c.name}
            title={c.name}
          />
        ))}
        {WHITES.map((w) => (
          <button
            key={w.name}
            type="button"
            className="room__white"
            onClick={() => apply({ kelvin: w.kelvin, on: true })}
          >
            {w.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function LightCard({
  light,
  editMode,
  room,
  roomNames,
  onAssign,
}: {
  light: LightState;
  editMode: boolean;
  room: string;
  roomNames: string[];
  onAssign: (entityId: string, value: string) => void;
}) {
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
    setLight(light.entityId, { on: next });
  };

  const slideBri = (v: number) => {
    setBri(v);
    setOn(true);
    if (callAllowed(`light-bri-${light.entityId}`, 200)) {
      setLight(light.entityId, { brightness: v, on: true });
    }
  };
  const commitBri = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setLight(light.entityId, { brightness: bri, on: true });
  };

  const pickColor = (rgb: [number, number, number]) => {
    if (!callAllowed(`light-color-${light.entityId}`)) return;
    setOn(true);
    setLight(light.entityId, { rgb, on: true });
  };
  const pickWhite = (kelvin: number) => {
    if (!callAllowed(`light-white-${light.entityId}`)) return;
    setOn(true);
    setLight(light.entityId, { kelvin, on: true });
  };

  const glow =
    on && light.rgb
      ? `rgb(${light.rgb[0]}, ${light.rgb[1]}, ${light.rgb[2]})`
      : on
        ? "#ffcf6b"
        : "#c9cdd6";
  const pct = Math.round((bri / 255) * 100);

  return (
    <li
      className={`light${on ? " light--on" : ""}${light.reachable ? "" : " light--off-grid"}`}
    >
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
        <div
          className="light__swatches"
          role="group"
          aria-label={`${light.name} colours`}
        >
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
        <div
          className="light__whites"
          role="group"
          aria-label={`${light.name} white`}
        >
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

      {editMode && (
        <label className="light__room">
          Room
          <select
            value={roomNames.includes(room) ? room : ""}
            onChange={(e) => onAssign(light.entityId, e.target.value)}
          >
            <option value="">Unassigned</option>
            {roomNames.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value="__new__">New room…</option>
          </select>
        </label>
      )}
    </li>
  );
}

function NameModal({
  title,
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };
  return (
    <div className="lmodal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lmodal__box" onClick={(e) => e.stopPropagation()}>
        <h3 className="lmodal__title">{title}</h3>
        <input
          className="lmodal__input"
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div className="lmodal__row">
          <button type="button" className="lmodal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="lmodal__save"
            disabled={!value.trim()}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
