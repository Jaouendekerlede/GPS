// Parkings autour de la zone regardée : données OpenStreetMap interrogées via
// le service public Overpass (gratuit, sans clé). On ne garde que les
// parkings utiles à un automobiliste : ouverts au public, et nommés, grands,
// souterrains ou à étages (pas les petits parkings privés d'immeuble).

import { avecMemoire } from "./util.js";

// Serveurs Overpass publics, gratuits mais parfois saturés : le principal
// d'abord, un secours s'il ne répond pas assez vite.
const SERVEURS = [
  { url: "https://overpass-api.de/api/interpreter", delaiMs: 10000 },
  { url: "https://maps.mail.ru/osm/tools/overpass/api/interpreter", delaiMs: 25000 },
  { url: "https://overpass.private.coffee/api/interpreter", delaiMs: 25000 },
];
const DUREE_MEMOIRE_MS = 30 * 60 * 1000;
const MAX_RESULTATS = 150;
const ACCES_EXCLUS = /^(private|no|permit|residents|delivery)$/;
const TYPES = {
  underground: "souterrain",
  "multi-storey": "à étages",
  surface: "en surface",
  rooftop: "sur le toit",
  street_side: "le long de la rue",
  lane: "le long de la rue",
};

function nombre(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parkingDepuisOsm(e) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat == null || lon == null) return null;
  const places = nombre(t.capacity);
  const type = t.parking || "";
  const utile = t.name || (places ?? 0) >= 30 || type === "underground" || type === "multi-storey";
  if (!utile || ACCES_EXCLUS.test(t.access || "")) return null;
  return {
    id: `${e.type}/${e.id}`,
    nom: t.name || (type === "underground" ? "Parking souterrain" : type === "multi-storey" ? "Parking à étages" : "Parking"),
    lat,
    lon,
    type: TYPES[type] || "",
    places,
    places_recharge: nombre(t["capacity:charging"]),
    places_pmr: nombre(t["capacity:disabled"]),
    payant: t.fee === "yes" ? "oui" : t.fee === "no" ? "non" : null,
    horaires: t.opening_hours || "",
    clients: t.access === "customers",
    hauteur_max: t.maxheight || "",
    operateur: t.operator || "",
  };
}

// Réponses gardées (Cache Storage) : les trajets reviennent souvent, et le
// service est souvent saturé. Au-delà de `dureeJours`, on redemande ; si le
// service ne répond pas, on reprend quand même la dernière réponse connue.
const CACHE_OSM = "trajetve-osm";
const enCours = new Map();

function cleRequete(requete) {
  let h = 5381;
  for (let i = 0; i < requete.length; i++) h = ((h * 33) ^ requete.charCodeAt(i)) >>> 0;
  return `https://cache.trajetve/osm/${h.toString(36)}-${requete.length}`;
}

async function lireCacheOsm(requete) {
  if (typeof caches === "undefined") return null;
  try {
    const r = await (await caches.open(CACHE_OSM)).match(cleRequete(requete));
    return r ? { date: Number(r.headers.get("x-date")) || 0, elements: (await r.json()).elements || [] } : null;
  } catch {
    return null;
  }
}

async function ecrireCacheOsm(requete, elements) {
  if (typeof caches === "undefined") return;
  try {
    await (await caches.open(CACHE_OSM)).put(cleRequete(requete), new Response(JSON.stringify({ elements }), { headers: { "Content-Type": "application/json", "x-date": String(Date.now()) } }));
  } catch {
    // Stockage plein : tant pis, pas de mémoire.
  }
}

// Requête Overpass (avec mémoire), sur le serveur principal puis les
// secours. Renvoie { ok, elements } ou { ok: false, erreur }.
export async function interrogerOverpass(requete, { dureeJours = 30 } = {}) {
  const garde = await lireCacheOsm(requete);
  if (garde && Date.now() - garde.date < dureeJours * 86400000) return { ok: true, elements: garde.elements, memoire: true };
  // Même requête déjà partie : on attend sa réponse.
  if (enCours.has(requete)) return enCours.get(requete);
  const promesse = interrogerServeurs(requete).then(async (r) => {
    enCours.delete(requete);
    if (r.ok) await ecrireCacheOsm(requete, r.elements);
    else if (garde) return { ok: true, elements: garde.elements, memoire: true, ancien: true };
    return r;
  });
  enCours.set(requete, promesse);
  return promesse;
}

async function interrogerServeurs(requete) {
  let erreur = "";
  for (const { url, delaiMs } of SERVEURS) {
    try {
      const resp = await fetch(url, { method: "POST", body: new URLSearchParams({ data: requete }), signal: AbortSignal.timeout(delaiMs) });
      if (!resp.ok) {
        erreur = resp.status === 429 ? "service OpenStreetMap surchargé, réessaie dans une minute" : `HTTP ${resp.status}`;
        continue;
      }
      return { ok: true, elements: (await resp.json()).elements || [] };
    } catch (e) {
      erreur = e.name === "TimeoutError" ? "service OpenStreetMap trop lent" : `réseau (${e.message})`;
    }
  }
  return { ok: false, erreur };
}

// Zone : { sud, ouest, nord, est } en degrés. Renvoie { ok, parkings } ou
// { ok: false, erreur }.
export async function rechercherParkings(zone) {
  const r = (x) => x.toFixed(3);
  const cle = `parkings|${r(zone.sud)}|${r(zone.ouest)}|${r(zone.nord)}|${r(zone.est)}`;
  return avecMemoire(cle, DUREE_MEMOIRE_MS, async () => {
    const requete = `[out:json][timeout:20];nwr["amenity"="parking"](${zone.sud},${zone.ouest},${zone.nord},${zone.est});out center tags ${MAX_RESULTATS * 3};`;
    const res = await interrogerOverpass(requete, { dureeJours: 7 });
    if (!res.ok) return { ok: false, erreur: res.erreur.replace("OpenStreetMap", "des parkings") };
    return { ok: true, parkings: res.elements.map(parkingDepuisOsm).filter(Boolean).slice(0, MAX_RESULTATS) };
  });
}
