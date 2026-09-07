"use client";

import { useEffect, useRef, useState } from "react";
import type { DeployedUnit } from "@/lib/fleet/map";

declare global {
  interface Window {
    google?: typeof google;
  }
}

const COLUMBUS = { lat: 39.9612, lng: -82.9988 };

let scriptPromise: Promise<void> | null = null;
let callbackCounter = 0;

/**
 * Loads the Maps JS API script once, no matter how many times this mounts.
 * Uses the classic `callback=` param rather than `loading=async` — the
 * latter needs Google's own inline bootstrap-loader snippet to actually
 * signal readiness; a plain <script> tag's `onload` fires once the file has
 * downloaded, not once `google.maps.Map` exists, so `new google.maps.Map`
 * right after onload can (and did, here) throw "not a constructor."
 * `callback=` is fired by the script itself only once the API is truly
 * ready, so it doesn't have that race.
 */
function loadGoogleMaps(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const callbackName = `__clGoogleMapsLoaded${callbackCounter++}`;
    (window as unknown as Record<string, () => void>)[callbackName] = () => resolve();

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function DeployedMap({
  pins: allUnits,
  apiKey,
  heightClassName = "h-[360px]",
}: {
  pins: DeployedUnit[];
  apiKey: string | null;
  /** Tailwind height class for the map box — dashboard uses a shorter card than a dedicated page would. */
  heightClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pins = allUnits.filter(
    (u): u is DeployedUnit & { lat: number; lng: number } => u.lat !== null && u.lng !== null,
  );

  useEffect(() => {
    if (!apiKey || !containerRef.current) return;
    let cancelled = false;

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !containerRef.current || !window.google) return;

        const map = new window.google.maps.Map(containerRef.current, {
          center: COLUMBUS,
          zoom: 11,
        });

        if (pins.length === 0) return;

        const bounds = new window.google.maps.LatLngBounds();
        const infoWindow = new window.google.maps.InfoWindow();

        for (const pin of pins) {
          const position = { lat: pin.lat, lng: pin.lng };
          bounds.extend(position);

          const marker = new window.google.maps.Marker({
            map,
            position,
            title: `${pin.unitNumber} · ${pin.customerName}`,
          });

          marker.addListener("click", () => {
            infoWindow.setContent(
              `<div style="font-family: 'Archivo', system-ui, sans-serif; padding: 2px 4px;">
                <div style="font-weight: 900; font-size: 13px;">${pin.unitNumber} · ${pin.size.replace("yd", " yd")}</div>
                <div style="font-size: 12px; margin-top: 2px;">${pin.customerName}</div>
                <div style="font-size: 12px; color: #5c636e;">${pin.deliveryAddress}</div>
              </div>`,
            );
            infoWindow.open({ map, anchor: marker });
          });
        }

        if (pins.length === 1) {
          map.setCenter(bounds.getCenter());
          map.setZoom(14);
        } else {
          map.fitBounds(bounds, 48);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, allUnits]);

  if (!apiKey) {
    return (
      <div
        className={`flex ${heightClassName} flex-col items-center justify-center gap-1 border-2 border-dashed border-line-strong bg-surface-2 p-4 text-center`}
      >
        <div className="text-[13px] font-bold text-ink-2">Map not configured yet</div>
        <div className="text-[12px] text-ink-3">
          Set NEXT_PUBLIC_GOOGLE_MAPS_JS_API_KEY to show deployed units here.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={`flex ${heightClassName} flex-col items-center justify-center gap-1 border-2 border-line-strong bg-surface-2 p-4 text-center`}
      >
        <p className="text-[13px] font-semibold text-orange-tint-ink">{error}</p>
      </div>
    );
  }

  return <div ref={containerRef} className={`${heightClassName} w-full border-2 border-line-strong`} />;
}
