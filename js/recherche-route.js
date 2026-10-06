import { compterAppelTomTom } from "./tomtom.js";

// Recherche « le long du trajet » (café, boulangerie, toilettes…) : service
// TomTom qui renvoie les lieux proches de la route avec le détour en temps.

export const CATEGORIES_TRAJET = [
  { icone: "☕", nom: "Café", requete: "café" },
  { icone: "🥖", nom: "Boulangerie", requete: "boulangerie" },
  { icone: "🍽️", nom: "Restaurant", requete: "restaurant" },
  { icone: "🛒", nom: "Supermarché", requete: "supermarché" },
  { icone: "🚻", nom: "Toilettes", requete: "toilettes" },
  { icone: "🧼", nom: "Lavage auto", requete: "lavage auto" },
];

const MAX_POINTS_ROUTE = 400;
const DETOUR_MAX_S = 900;

// coords : tracé restant [lon, lat]. Renvoie { ok, lieux: [{ nom, adresse,
// lat, lon, detour_min }] } triés par détour, ou { ok: false, erreur }.
export async function rechercherLeLongDu(cle, coords, requete) {
  if (!cle) return { ok: false, erreur: "clé TomTom manquante" };
  const pas = Math.max(1, Math.ceil(coords.length / MAX_POINTS_ROUTE));
  const points = coords.filter((_, i) => i % pas === 0 || i === coords.length - 1).map(([lon, lat]) => ({ lat, lon }));
  if (points.length < 2) return { ok: true, lieux: [] };
  const url = `https://api.tomtom.com/search/2/searchAlongRoute/${encodeURIComponent(requete)}.json?key=${encodeURIComponent(cle)}&maxDetourTime=${DETOUR_MAX_S}&limit=10&language=fr-FR`;
  try {
    compterAppelTomTom();
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ route: { points } }) });
    if (!r.ok) return { ok: false, erreur: `HTTP ${r.status}` };
    const j = await r.json();
    const lieux = (j.results || [])
      .filter((x) => x.position)
      .map((x) => ({ nom: x.poi?.name || x.address?.freeformAddress || requete, adresse: x.address?.freeformAddress || "", lat: x.position.lat, lon: x.position.lon, detour_min: Math.max(0, Math.round((x.detourTime || 0) / 60)) }))
      .sort((a, b) => a.detour_min - b.detour_min);
    return { ok: true, lieux };
  } catch (e) {
    return { ok: false, erreur: `réseau (${e.message})` };
  }
}
