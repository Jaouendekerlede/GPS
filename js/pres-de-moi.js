// Actions « près de moi » : station-service, aire de repos, parking, restaurant, pharmacie, urgences.
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
  pharmacie: { libelle: "Pharmacie", filtre: '["amenity"="pharmacy"]' },
  urgences: { libelle: "Urgences hospitalières", filtre: '["amenity"="hospital"]' },
};
const RAYON_M = 10000;
const RAYON_COURT_M = 3000;

export async function chercherPresDeMoi(type) {
  const recherche = RECHERCHES[type];
  if (!recherche) return;
  toast(`🔎 ${recherche.libelle} : recherche autour de toi…`);
  const pos = await resoudreLieu("ma position");
  if (pos.erreur) return toast(pos.erreur);
  // Mémoire d'un jour et serveurs de secours : même service que les parkings.
  // Si le service est lent, on refait une recherche plus courte (beaucoup plus légère).
  let r = null;
  let rayon = RAYON_M;
  for (const essai of [RAYON_M, RAYON_COURT_M]) {
    rayon = essai;
    const requete = `[out:json][timeout:20];nwr${recherche.filtre}(around:${essai},${pos.lat},${pos.lon});out center 60;`;
    r = await interrogerOverpass(requete, { dureeJours: 1 });
    if (r.ok) break;
  }
  if (!r.ok) return toast(`${recherche.libelle} : ${r.erreur}. Réessaie dans une minute.`);
  const lieux = r.elements
    .map((e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, nom: e.tags?.name || e.tags?.brand || "" }))
    .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon))
    .map((l) => ({ ...l, d: haversineKm(pos.lat, pos.lon, l.lat, l.lon) }))
    .sort((a, b) => a.d - b.d);
  if (!lieux.length) return toast(`Aucun ${recherche.libelle.toLowerCase()} trouvé dans les ${rayon / 1000} km.`);
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
