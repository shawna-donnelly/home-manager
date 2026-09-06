import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { avatarUrl, type Avatars } from "./avatars";
import type { PersonLocation } from "./useEvents";

/** Marker colors, assigned by display order so each person keeps theirs. */
const PALETTE = [
  "#4c8dff",
  "#e91e63",
  "#2ecc71",
  "#f2994a",
  "#9b59b6",
  "#00bcd4",
];

const colorFor = (index: number) => PALETTE[index % PALETTE.length] as string;

/**
 * Family map: one marker per person from Home Assistant. Leaflet is driven
 * imperatively in effects — it owns its DOM and React must not touch it.
 */
export default function MapView({
  locations,
  now,
  avatars,
}: {
  locations: PersonLocation[];
  now: Date;
  avatars: Avatars;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef(
    new Map<string, { marker: L.Marker; hadAvatar: boolean }>(),
  );
  const fitSignatureRef = useRef("");

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
    });
    map.setView([39.7392, -104.9903], 10); // Placeholder until first fix.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapRef.current = map;
    // The container is sized by flex layout; measure again once it settles.
    requestAnimationFrame(() => map.invalidateSize());
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      fitSignatureRef.current = "";
    };
  }, []);

  const located = locations.filter(
    (p) => !p.stale && p.latitude !== undefined && p.longitude !== undefined,
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const markers = markersRef.current;
    const seen = new Set<string>();

    located.forEach((person) => {
      const lat = person.latitude as number;
      const lon = person.longitude as number;
      seen.add(person.id);

      const color = colorFor(locations.findIndex((p) => p.id === person.id));
      const avatar = avatarUrl(avatars, person.name);
      const makeIcon = () =>
        L.divIcon({
          className: "person-marker",
          html:
            (avatar
              ? `<img class="person-marker__img" style="border-color:${color}" src="${avatar}" alt="">`
              : `<span class="person-marker__dot" style="background:${color}"></span>`) +
            `<span class="person-marker__name">${escapeHtml(person.name)}</span>`,
          iconSize: [0, 0],
          iconAnchor: avatar ? [14, 14] : [8, 8],
        });

      const existing = markers.get(person.id);
      if (existing) {
        existing.marker.setLatLng([lat, lon]);
        // Upgrade in place when the avatar list loads after marker creation.
        if (existing.hadAvatar !== Boolean(avatar)) {
          existing.marker.setIcon(makeIcon());
          existing.hadAvatar = Boolean(avatar);
        }
        return;
      }
      markers.set(person.id, {
        marker: L.marker([lat, lon], { icon: makeIcon() }).addTo(map),
        hadAvatar: Boolean(avatar),
      });
    });

    for (const [id, entry] of markers) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.delete(id);
      }
    }

    // Refit only when someone actually moved (~100 m) or the set changed.
    // Frames also arrive for chore toggles; those must not yank the view.
    const signature = located
      .map((p) => `${p.id}:${p.latitude?.toFixed(3)}:${p.longitude?.toFixed(3)}`)
      .sort()
      .join("|");
    if (located.length > 0 && signature !== fitSignatureRef.current) {
      fitSignatureRef.current = signature;
      const bounds = L.latLngBounds(
        located.map((p) => [p.latitude as number, p.longitude as number]),
      );
      map.fitBounds(bounds.pad(0.3), { maxZoom: 16 });
    }
  }, [locations, located, avatars]);

  return (
    <div className="mapwrap">
      <div ref={containerRef} className="map" aria-label="Family map" />
      <ul className="people" aria-label="Family members">
        {locations.map((person, i) => (
          <li
            key={person.id}
            className={`person${person.stale ? " person--stale" : ""}`}
          >
            <span
              className="legend__dot"
              style={{ background: colorFor(i) }}
            />
            <span className="person__name">{person.name}</span>
            <span className="person__where">
              {describe(person)}
              {!person.stale && ` · ${timeAgo(person.updatedAt, now)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describe(person: PersonLocation): string {
  if (person.stale) return "No location";
  if (person.zone === "home") return "Home";
  if (person.zone === "not_home") return "Away";
  return person.zone;
}

function timeAgo(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}
