// Parkings sur la carte (puce « 🅿️ Parkings »), en 2D comme en 3D.

import { $, toast } from "./ui-commun.js";
import { escapeHtml, lienGoogleMaps } from "./util.js";
import { lireReglages, sauverReglages } from "./storage.js";
import { rechercherParkings } from "./parkings.js";
import { afficherParkings, montrerParkings, limitesVisibles, rayonVisibleKm, afficherTrafic } from "./carte.js";
import { getApiKeys } from "./config.js";
import { navigationActive } from "./navigation.js";

const RAYON_MAX_PARKINGS_KM = 6;
let parkingsActifs = false;
let jetonParkings = 0;
let minuteurParkings = null;

function ficheParkingHtml(p) {
  const infos = [
    p.type ? `Parking ${p.type}` : "",
    p.places != null ? `${p.places} places` : "",
    p.payant === "oui" ? "💶 Payant" : p.payant === "non" ? "🎁 Gratuit" : "",
    p.places_recharge ? `⚡ ${p.places_recharge} place${p.places_recharge > 1 ? "s" : ""} avec recharge` : "",
    p.places_pmr ? `♿ ${p.places_pmr}` : "",
    p.hauteur_max ? `↕️ Hauteur max ${p.hauteur_max} m` : "",
    p.clients ? "Réservé aux clients" : "",
  ].filter(Boolean);
  return `<div class="gps-fiche-parking">
    <strong>🅿️ ${escapeHtml(p.nom)}</strong>
    ${infos.length ? `<div>${infos.map(escapeHtml).join(" · ")}</div>` : ""}
    ${p.horaires ? `<div>🕐 ${escapeHtml(p.horaires)}</div>` : ""}
    ${p.operateur ? `<div>${escapeHtml(p.operateur)}</div>` : ""}
    <a href="${escapeHtml(lienGoogleMaps(p.lat, p.lon))}" target="_blank" rel="noopener">🧭 Y aller</a>
  </div>`;
}

async function chargerParkings() {
  if (!parkingsActifs || navigationActive()) return;
  if (rayonVisibleKm() > RAYON_MAX_PARKINGS_KM) {
    afficherParkings([]);
    return;
  }
  const jeton = ++jetonParkings;
  const r = await rechercherParkings(limitesVisibles());
  if (jeton !== jetonParkings || !parkingsActifs) return;
  if (!r.ok) return toast(`🅿️ Parkings indisponibles : ${r.erreur}`);
  afficherParkings(r.parkings.map((p) => ({ parking: p, html: ficheParkingHtml(p) })));
}

export function cablerParkings() {
  const chip = $("gps-parkings-chip");
  const appliquer = (actif) => {
    parkingsActifs = actif;
    chip.classList.toggle("actif", actif);
    montrerParkings(actif);
  };
  appliquer(!!lireReglages().parkings);
  chip.addEventListener("click", () => {
    appliquer(!parkingsActifs);
    sauverReglages({ parkings: parkingsActifs });
    if (!parkingsActifs) return;
    if (rayonVisibleKm() > RAYON_MAX_PARKINGS_KM) toast("🅿️ Zoome sur la carte pour voir les parkings");
    chargerParkings();
  });
}

// Carte déplacée : nouvelle recherche, un peu différée (le doigt bouge encore).
export function planifierParkings() {
  if (!parkingsActifs) return;
  clearTimeout(minuteurParkings);
  minuteurParkings = setTimeout(chargerParkings, 800);
}

// Puce « 🚦 Trafic » : routes en vert, orange, rouge selon la circulation.
export function cablerTrafic() {
  const chip = $("gps-trafic-chip");
  const appliquer = (actif) => {
    chip.classList.toggle("actif", actif);
    afficherTrafic(actif);
  };
  appliquer(!!lireReglages().trafic_carte);
  chip.addEventListener("click", () => {
    const actif = !chip.classList.contains("actif");
    if (actif && !getApiKeys().tomtom) return toast("🚦 Clé TomTom nécessaire (Menu › Clés API)");
    sauverReglages({ trafic_carte: actif });
    appliquer(actif);
  });
}
