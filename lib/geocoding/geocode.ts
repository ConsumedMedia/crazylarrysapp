import "server-only";

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Server-only, secret key — never sent to the browser. Distinct from
 * NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY / NEXT_PUBLIC_GOOGLE_MAPS_JS_API_KEY,
 * which are public-by-design and protected by HTTP-referrer restriction
 * instead. This one should be restricted to the Geocoding API only.
 */
const API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;

/**
 * Geocodes one address. Returns null on any failure (bad address, API
 * error, key not configured) — callers skip the pin rather than throw, so
 * one bad address never breaks the whole map. Never retried automatically
 * by the caller beyond "try again next time this booking has no cached
 * coordinates," which in practice is rare at this fleet's scale.
 */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  if (!API_KEY) {
    console.error("[geocodeAddress] GOOGLE_GEOCODING_API_KEY not configured");
    return null;
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.error(`[geocodeAddress] HTTP ${res.status} for "${address}"`);
      return null;
    }
    const data = (await res.json()) as {
      status: string;
      results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };
    if (data.status !== "OK" || data.results.length === 0) {
      console.error(`[geocodeAddress] ${data.status} for "${address}"`);
      return null;
    }
    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng };
  } catch (e) {
    console.error(`[geocodeAddress] fetch failed for "${address}":`, e);
    return null;
  }
}
