// Actions « près de moi » sous la recherche : station-service, aire de repos, parking, restaurant.
// Cherche autour de la position, affiche le plus proche (distance) et centre la carte dessus.
import { resoudreLieu, haversineKm } from "./geo.js";
import { centrer } from "./carte.js";
import { toast } from "./ui-commun.js";

const RECHERCHES = {
  essence: { libelle: "Station-service", filtre: '["amenity"="fuel"]' },
  repos: { libelle: "Aire de repos", filtre: '["highway"~"^(services|rest_area)$"]' },
  parking: { libelle: "Parking", filtre: '["amenity"="parking"]' },
  restaurant: { libelle: "Restaurant", filtre: '["amenity"~"^(restaurant|cafe)$"]' },
  pharmacie: { libelle: "Pharmacie", filtre: '["amenity"="pharmacy"]' },
  urgences: { libelle: "Urgences hospitalières", filtre: '["amenity"="hospital"]' },
};
const RAYON_M = 10000;
const ENDPOINT = "https://overpass-api.de/api/interpreter";

export async function chercherPresDeMoi(type) {
  const recherche = RECHERCHES[type];
  if (!recherche) return;
  toast(`🔎 ${recherche.libelle} : recherche autour de toi…`);
  const pos = await resoudreLieu("ma position");
  if (pos.erreur) return toast(pos.erreur);
  const requete = `[out:json][timeout:20];nwr${recherche.filtre}(around:${RAYON_M},${pos.lat},${pos.lon});out center 60;`;
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ data: requete }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const lieux = (data.elements || [])
      .map((e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, nom: e.tags?.name || e.tags?.brand || "", d: 0 }))
      .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon))
      .map((l) => ({ ...l, d: haversineKm(pos.lat, pos.lon, l.lat, l.lon) }))
      .sort((a, b) => a.d - b.d);
    if (!lieux.length) return toast(`Aucun ${recherche.libelle.toLowerCase()} trouvé dans les ${RAYON_M / 1000} km.`);
    const p = lieux[0];
    const dist = p.d < 1 ? `${Math.round(p.d * 1000)} m` : `${p.d.toFixed(1).replace(".", ",")} km`;
    centrer(p.lat, p.lon, 14);
    toast(`${recherche.libelle} la plus proche${p.nom ? " : " + p.nom : ""} : ${dist}.`);
  } catch (e) {
    toast(`Recherche impossible : ${e.message}`);
  }
}

// Boutons « près de moi » : délégation (les boutons sont recréés à chaque retour sur l'accueil).
let branche = false;
export function cablerPresDeMoi() {
  if (branche) return;
  branche = true;
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-pres]");
    if (b) chercherPresDeMoi(b.dataset.pres);
  });
}
