// Actions « près de moi » sous la recherche : station-service, aire de repos, parking, restaurant.
// Cherche autour de la position, affiche le plus proche (distance) et centre la carte dessus.
import { resoudreLieu, haversineKm } from "./geo.js";
import { centrer } from "./carte.js";
import { toast } from "./ui-commun.js";
import { interrogerOverpass } from "./parkings.js";

const RECHERCHES = {
  essence: { libelle: "Station-service", filtre: '["amenity"="fuel"]' },
  repos: { libelle: "Aire de repos", filtre: '["highway"~"^(services|rest_area)$"]' },
  parking: { libelle: "Parking", filtre: '["amenity"="parking"]' },
  restaurant: { libelle: "Restaurant", filtre: '["amenity"~"^(restaurant|cafe)$"]' },
};
const RAYON_M = 10000;

export async function chercherPresDeMoi(type) {
  const recherche = RECHERCHES[type];
  if (!recherche) return;
  toast(`🔎 ${recherche.libelle} : recherche autour de toi…`);
  const pos = await resoudreLieu("ma position");
  if (pos.erreur) return toast(pos.erreur);
  const requete = `[out:json][timeout:20];nwr${recherche.filtre}(around:${RAYON_M},${pos.lat},${pos.lon});out center 60;`;
  // Mémoire d'un jour et serveurs de secours : même service que les parkings.
  const r = await interrogerOverpass(requete, { dureeJours: 1 });
  if (!r.ok) return toast(`${recherche.libelle} : ${r.erreur}. Réessaie dans une minute.`);
  const lieux = r.elements
    .map((e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, nom: e.tags?.name || e.tags?.brand || "" }))
    .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon))
    .map((l) => ({ ...l, d: haversineKm(pos.lat, pos.lon, l.lat, l.lon) }))
    .sort((a, b) => a.d - b.d);
  if (!lieux.length) return toast(`Aucun ${recherche.libelle.toLowerCase()} trouvé dans les ${RAYON_M / 1000} km.`);
  const p = lieux[0];
  const dist = p.d < 1 ? `${Math.round(p.d * 1000)} m` : `${p.d.toFixed(1).replace(".", ",")} km`;
  centrer(p.lat, p.lon, 14);
  toast(`${recherche.libelle} la plus proche${p.nom ? " : " + p.nom : ""} : ${dist}.`);
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
