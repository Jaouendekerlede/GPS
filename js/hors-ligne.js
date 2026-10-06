// Préparer un trajet pour rouler sans réseau : on télécharge à l'avance la
// carte OpenFreeMap le long du tracé (le service worker la garde), ce qu'il
// faut pour l'afficher en 3D (style, polices, icônes, moteur), et le guidage
// TomTom (instructions, voies), rangé à part pour la navigation.

import { rectanglesZonesEvitees } from "./storage.js";
import { getApiKeys } from "./config.js";
import { calculerItineraireTomTom } from "./tomtom.js";
import { haversineKm } from "./geo.js";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAPLIBRE = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl";
const POLICES = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"];
// Latin de base et accents, puis ponctuation (’ « »…).
const PLAGES_GLYPHES = ["0-255", "256-511", "8192-8447"];
const ZOOM_MIN = 6;
const ZOOM_MAX = 14;
// Au-delà, zoom trop fin pour élargir autour du tracé (trop de tuiles).
const ZOOM_MAX_VOISINES = 12;
const TAILLE_MOYENNE_TUILE_KO = 25;
const TELECHARGEMENTS_SIMULTANES = 6;
const CLE_GUIDAGE = "tve_guidage_hors_ligne";

function tuile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

// Tuiles couvrant le tracé à chaque zoom : bande d'une tuile de large aux
// zooms fins, élargie d'une tuile de chaque côté aux zooms larges (carte
// inclinée : on voit loin sur les côtés).
export function tuilesDuTrace(coords) {
  const tuiles = new Set();
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
    const marge = z <= ZOOM_MAX_VOISINES ? 1 : 0;
    // Pas d'échantillonnage : un point par demi-tuile environ.
    const pasKm = (40075 / 2 ** z) * 0.5;
    let depuis = Infinity;
    let precedent = null;
    for (const [lon, lat] of coords) {
      if (precedent) depuis += haversineKm(precedent[1], precedent[0], lat, lon);
      precedent = [lon, lat];
      if (depuis < pasKm) continue;
      depuis = 0;
      const [x, y] = tuile(lat, lon, z);
      for (let dx = -marge; dx <= marge; dx++) for (let dy = -marge; dy <= marge; dy++) tuiles.add(`${z}/${x + dx}/${y + dy}`);
    }
    const [lon, lat] = coords[coords.length - 1];
    const [x, y] = tuile(lat, lon, z);
    tuiles.add(`${z}/${x}/${y}`);
  }
  return [...tuiles];
}

export function estimerPreparation(plan) {
  const n = tuilesDuTrace(plan.coords).length;
  return { tuiles: n, mo: Math.round((n * TAILLE_MOYENNE_TUILE_KO) / 1024) };
}

async function telecharger(urls, onProgres, depart = 0, total = urls.length) {
  let fait = depart;
  let ok = 0;
  const file = [...urls];
  async function ouvrier() {
    while (file.length) {
      const url = file.shift();
      try {
        const r = await fetch(url);
        if (r.ok || r.type === "opaque") ok++;
      } catch {
        // Tuile manquée : le reste de la carte reste utilisable.
      }
      onProgres?.(++fait, total);
    }
  }
  await Promise.all(Array.from({ length: TELECHARGEMENTS_SIMULTANES }, ouvrier));
  return ok;
}

// Guidage complet du trajet (via les bornes prévues), gardé pour démarrer ou
// recalculer la navigation sans réseau.
export async function preparerGuidage(plan) {
  const arrets = (plan.arrets || []).map((a) => ({ lat: a.lat, lon: a.lon }));
  const r = await calculerItineraireTomTom(getApiKeys().tomtom, plan.from_lat, plan.from_lon, plan.to_lat, plan.to_lon, { etapes: arrets, instructions: true, zonesEvitees: rectanglesZonesEvitees() });
  if (r.erreur) return false;
  localStorage.setItem(CLE_GUIDAGE, JSON.stringify({ ts: Date.now(), to_lat: plan.to_lat, to_lon: plan.to_lon, nb_arrets: arrets.length, route: r }));
  return true;
}

// Trajet préparé pour le hors ligne : { ts, nbArrets }, ou null.
export function guidagePrepare() {
  try {
    const g = JSON.parse(localStorage.getItem(CLE_GUIDAGE));
    return g?.route ? { ts: g.ts, nbArrets: g.nb_arrets } : null;
  } catch {
    return null;
  }
}

// Guidage gardé pour cette destination et ce nombre de bornes restantes.
export function guidageHorsLigne(lat, lon, nbArrets) {
  try {
    const g = JSON.parse(localStorage.getItem(CLE_GUIDAGE));
    if (!g || g.nb_arrets !== nbArrets || haversineKm(g.to_lat, g.to_lon, lat, lon) > 0.3) return null;
    return g.route;
  } catch {
    return null;
  }
}

// Style, moteur, icônes et polices + adresses des tuiles (à télécharger).
async function ressourcesCarte() {
  const style = await (await fetch(STYLE)).json();
  const tileJson = await (await fetch(style.sources.openmaptiles.url)).json();
  const modele = tileJson.tiles[0];
  const annexes = [
    `${MAPLIBRE}.js`,
    `${MAPLIBRE}.css`,
    ...["", "@2x"].flatMap((d) => [`${style.sprite}${d}.json`, `${style.sprite}${d}.png`]),
    ...POLICES.flatMap((p) => PLAGES_GLYPHES.map((plage) => style.glyphs.replace("{fontstack}", encodeURIComponent(p)).replace("{range}", plage))),
  ];
  const adresse = (t) => {
    const [z, x, y] = t.split("/");
    return modele.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  };
  return { annexes, adresse };
}

// onProgres(fait, total) pendant le téléchargement.
export async function preparerHorsLigne(plan, onProgres) {
  const { annexes, adresse } = await ressourcesCarte();
  const tuiles = tuilesDuTrace(plan.coords).map(adresse);
  const total = annexes.length + tuiles.length;
  const annexesOk = await telecharger(annexes, onProgres, 0, total);
  const tuilesOk = await telecharger(tuiles, onProgres, annexes.length, total);
  const guidage = await preparerGuidage(plan).catch(() => false);
  return { tuiles: tuilesOk, tuilesTotal: tuiles.length, annexes: annexesOk, annexesTotal: annexes.length, guidage };
}

// Ce que la préparation a réellement obtenu, et ce que l'appli saura faire
// ou non sans réseau. Rien n'est annoncé « prêt » sans avoir été téléchargé.
//   r : résultat de preparerHorsLigne.
// Renvoie { complet, titre, lignes }.
const PART_CARTE_SUFFISANTE = 0.97;
export function bilanPreparation(r) {
  const carteOk = r.tuilesTotal > 0 && r.tuiles / r.tuilesTotal >= PART_CARTE_SUFFISANTE && r.annexes === r.annexesTotal;
  const complet = carteOk && !!r.guidage;
  const lignes = [];
  lignes.push(
    carteOk
      ? "✅ Carte 3D le long du trajet : téléchargée."
      : `⚠️ Carte 3D incomplète : ${r.tuiles} morceaux sur ${r.tuilesTotal}${r.annexes === r.annexesTotal ? "" : ", et il manque des éléments du moteur de carte (icônes, polices)"}. Des zones pourront rester vides.`,
  );
  lignes.push(r.guidage ? "✅ Guidage (itinéraire, consignes vocales, bornes prévues) : enregistré." : "⚠️ Guidage non enregistré : sans réseau, la navigation ne pourra pas démarrer.");
  lignes.push(
    "",
    "Sans réseau, tu n'auras PAS :",
    "• de nouvel itinéraire si tu quittes la route prévue ou changes de borne ;",
    "• le trafic, les travaux, la météo ;",
    "• l'état des bornes (libre, occupée, en panne) ni la recherche de bornes ;",
    "• la carte à plat (2D) ni la recherche d'adresses.",
    "",
    "Le guidage enregistré vaut pour cette destination et ces bornes : relance la préparation si tu modifies le trajet.",
  );
  return { complet, titre: complet ? "✅ Trajet prêt pour rouler sans réseau" : "⚠️ Préparation hors ligne incomplète", lignes };
}

// ── Carte de la région (autour de la maison) ────────────────────────────────
// Toutes les tuiles jusqu'au zoom 13 dans le rayon choisi, et le zoom 14
// (détail des rues, ronds-points) tout près du centre. Le service worker
// garde ces tuiles : la carte 3D s'affiche alors partout dans la région,
// sans réseau (le guidage reste celui des trajets préparés).

const ZOOM_REGION_MAX = 13;
const RAYON_DETAIL_KM = 12;
const CLE_REGION = "tve_region_hors_ligne";
export const RAYONS_REGION_KM = [30, 50, 80];

// Tuiles d'un carré de demi-côté rayonKm autour du centre, du zoom 6 à zoomMax.
function tuilesCarre(lat, lon, rayonKm, zoomMax, zoomMin = ZOOM_MIN) {
  const dLat = rayonKm / 110.54;
  const dLon = rayonKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const liste = [];
  for (let z = zoomMin; z <= zoomMax; z++) {
    const [x0, y1] = tuile(lat - dLat, lon - dLon, z);
    const [x1, y0] = tuile(lat + dLat, lon + dLon, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) liste.push(`${z}/${x}/${y}`);
  }
  return liste;
}

export function tuilesDeLaRegion(lat, lon, rayonKm) {
  return [...tuilesCarre(lat, lon, rayonKm, ZOOM_REGION_MAX), ...tuilesCarre(lat, lon, RAYON_DETAIL_KM, ZOOM_MAX, ZOOM_REGION_MAX + 1)];
}

export function estimerRegion(lat, lon, rayonKm) {
  const n = tuilesDeLaRegion(lat, lon, rayonKm).length;
  return { tuiles: n, mo: Math.round((n * TAILLE_MOYENNE_TUILE_KO) / 1024) };
}

export function regionPreparee() {
  try {
    return JSON.parse(localStorage.getItem(CLE_REGION));
  } catch {
    return null;
  }
}

export async function preparerRegion(lat, lon, rayonKm, onProgres) {
  const { annexes, adresse } = await ressourcesCarte();
  const tuiles = tuilesDeLaRegion(lat, lon, rayonKm).map(adresse);
  const total = annexes.length + tuiles.length;
  await telecharger(annexes, onProgres, 0, total);
  const ok = await telecharger(tuiles, onProgres, annexes.length, total);
  const region = { lat, lon, rayon_km: rayonKm, tuiles: ok, total: tuiles.length, date: Date.now() };
  // Trop de tuiles manquées (réseau coupé en route) : pas « préparée ».
  if (ok >= tuiles.length * 0.95) localStorage.setItem(CLE_REGION, JSON.stringify(region));
  return region;
}
