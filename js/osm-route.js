// Radars fixes et feux tricolores le long d'un itinéraire, d'après
// OpenStreetMap (service Overpass, gratuit, sans clé).

import { interrogerOverpass } from "./parkings.js";
import { haversineKm } from "./geo.js";

// Un point tous les `pasM` mètres : une ligne « around » de milliers de
// points ralentirait Overpass.
function allegerM(coords, pasM) {
  if (coords.length < 2) return coords;
  const garde = [coords[0]];
  let cumul = 0;
  for (let i = 1; i < coords.length; i++) {
    cumul += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]) * 1000;
    if (cumul >= pasM) {
      garde.push(coords[i]);
      cumul = 0;
    }
  }
  if (garde[garde.length - 1] !== coords[coords.length - 1]) garde.push(coords[coords.length - 1]);
  return garde;
}

const ligne = (pts) => pts.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",");

// Radars fixes près du tracé : recherche par petits rectangles (~15 km de
// route chacun), bien plus rapide pour Overpass qu'une longue ligne ; le
// tri fin (à moins de 40 m de la route) se fait ensuite. Renvoie
// { ok, radars } ou { ok: false, erreur }.
const POINTS_PAR_RECTANGLE = 100;
const MARGE_RECTANGLE_DEG = 0.001;

function rectanglesLeLongDu(coords, marge = MARGE_RECTANGLE_DEG, parRectangle = POINTS_PAR_RECTANGLE) {
  const pts = allegerM(coords, 150);
  const rectangles = [];
  for (let i = 0; i < pts.length - 1; i += parRectangle) {
    const m = pts.slice(i, i + parRectangle + 1);
    const lats = m.map((p) => p[1]);
    const lons = m.map((p) => p[0]);
    const f = (x) => x.toFixed(4);
    rectangles.push(`${f(Math.min(...lats) - marge)},${f(Math.min(...lons) - marge)},${f(Math.max(...lats) + marge)},${f(Math.max(...lons) + marge)}`);
  }
  return rectangles;
}

// Complément à OpenStreetMap : liste officielle "Radars fixes en France"
// (data.gouv.fr, ministère de l'Intérieur), mise à jour en décembre 2025
// (bien plus récente que l'ancien jeu figé depuis 2018 utilisé avant --
// l'utilisateur a trouvé ce lien le 2026-09-27). CORS ouvert (vérifié),
// contrairement au site radars.securite-routiere.gouv.fr (l'outil officiel
// "temps réel", lui bloqué pour une appli sans serveur). Fichier
// point-virgule, encodage Latin-1 -- sans conséquence ici : aucune des
// colonnes utilisées (Type de radar, VMA, Latitude, Longitude) ne contient
// de caractère accentué, seul "Numéro de radar" (non utilisé) en a.
// Secours si l'API du dataset (ci-dessous) est indisponible : le fichier
// connu au moment d'écrire ce code (décembre 2025).
const URL_RADARS_GOUV_SECOURS = "https://static.data.gouv.fr/resources/liste-des-radars-fixes-en-france/20251230-134204/jeu-de-donnees-liste-des-radars-fixes-en-france-12-2025.csv";
// Chaque nouvelle publication du fichier a une URL différente (le chemin
// contient la date) -- impossible de la deviner à l'avance. On interroge
// donc l'API du jeu de données lui-même (CORS ouvert, vérifié) pour
// retrouver la ressource CSV la plus récente, plutôt que de dépendre d'une
// URL figée qui finirait par pointer sur une version périmée.
const URL_DATASET_RADARS_GOUV = "https://www.data.gouv.fr/api/1/datasets/liste-des-radars-fixes-en-france/";
const CACHE_RADARS_GOUV = "trajetve-radars-gouv";
// Demande explicite de l'utilisateur : revérifier une mise à jour tous les
// 6 mois (le fichier lui-même n'est republié qu'une à deux fois par an).
const DUREE_RADARS_GOUV_MS = 6 * 30 * 24 * 3600 * 1000;

async function urlRadarsGouvActuelle() {
  try {
    const resp = await fetch(URL_DATASET_RADARS_GOUV);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const dataset = await resp.json();
    const csv = (dataset.resources || [])
      .filter((r) => r.format === "csv")
      .sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified))[0];
    return csv?.url || URL_RADARS_GOUV_SECOURS;
  } catch (e) {
    console.warn("[RADARS_GOUV] Recherche de mise à jour impossible, secours utilisé", e);
    return URL_RADARS_GOUV_SECOURS;
  }
}
let radarsGouv = null;
let chargementRadarsGouv = null;

// Codes officiels -> libellé français, pour l'annonce vocale ("Radar de feu
// rouge dans 100 mètres" plutôt qu'un "Radar" générique). Seuls les codes
// dont le sens est sûr sont traduits ; les autres restent "radar" pour ne
// jamais annoncer un type incertain.
export const LABELS_TYPE_RADAR = {
  ETF: "radar fixe",
  ETD: "radar discriminant",
  ETT: "radar fixe nouvelle génération",
  ETU: "radar urbain nouvelle génération",
  ETVM: "radar de vitesse moyenne",
  ETFR: "radar de feu rouge",
  ETPN: "radar de passage à niveau",
};

export function lireRadarsGouvCsv(texte) {
  const lignes = texte.split("\n");
  const entete = lignes[0].split(";").map((c) => c.trim());
  const col = (nom) => entete.indexOf(nom);
  const [cLat, cLon, cType] = [col("Latitude"), col("Longitude"), col("Type de radar")];
  const radars = [];
  for (let i = 1; i < lignes.length; i++) {
    const v = lignes[i].split(";");
    if (v.length <= Math.max(cLat, cLon)) continue;
    const lat = Number(v[cLat]);
    const lon = Number(v[cLon]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) radars.push({ lat, lon, type: (v[cType] || "").trim() });
  }
  return radars;
}

async function chargerRadarsGouv() {
  if (radarsGouv) return radarsGouv;
  chargementRadarsGouv ??= (async () => {
    try {
      // L'appel à l'API du jeu de données est léger (JSON, pas le CSV entier)
      // : on le refait à chaque session pour savoir si le fichier officiel a
      // changé, même si le cache local n'a pas encore atteint 6 mois -- sans
      // ça, une nouvelle publication du fichier (ou un changement de format
      // dans une mise à jour de l'appli) resterait invisible jusqu'à
      // expiration du cache. Repéré le 2026-09-28 : un radar de feu rouge
      // bien présent dans le fichier officiel n'apparaissait pas, probable
      // cache figé sur une version antérieure au passage au fichier de
      // décembre 2025 (v68).
      const url = await urlRadarsGouvActuelle();
      const cache = typeof caches !== "undefined" ? await caches.open(CACHE_RADARS_GOUV) : null;
      const garde = await cache?.match("radars.json");
      const gardeDate = garde && Number(garde.headers.get("x-date"));
      if (garde && garde.headers.get("x-url") === url && gardeDate && Date.now() - gardeDate < DUREE_RADARS_GOUV_MS) {
        radarsGouv = await garde.json();
        return radarsGouv;
      }
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      radarsGouv = lireRadarsGouvCsv(await resp.text());
      await cache?.put("radars.json", new Response(JSON.stringify(radarsGouv), { headers: { "content-type": "application/json", "x-date": String(Date.now()), "x-url": url } }));
      return radarsGouv;
    } catch (e) {
      console.warn("[RADARS_GOUV] Liste officielle indisponible", e);
      chargementRadarsGouv = null;
      return [];
    }
  })();
  return chargementRadarsGouv;
}

// Ne garde que les radars officiels dans le rectangle englobant le tracé
// (+ marge) : évite de comparer les ~3 300 radars de France entière à
// chaque point du tracé.
async function radarsGouvPresDuTrace(coords, margeDeg = 0.05) {
  const tous = await chargerRadarsGouv();
  if (!tous.length) return [];
  const lats = coords.map(([, lat]) => lat);
  const lons = coords.map(([lon]) => lon);
  const [latMin, latMax] = [Math.min(...lats) - margeDeg, Math.max(...lats) + margeDeg];
  const [lonMin, lonMax] = [Math.min(...lons) - margeDeg, Math.max(...lons) + margeDeg];
  return tous.filter((r) => r.lat >= latMin && r.lat <= latMax && r.lon >= lonMin && r.lon <= lonMax);
}

// Même radar physique repéré par les deux sources : à moins de 100 m, on ne
// le garde qu'une fois -- en préférant la version officielle (avec son
// type précis, ETF/ETD/ETFR...) à celle d'OSM (position seule, sans type).
// Les radars uniquement dans OSM (installations trop récentes pour figurer
// dans le fichier officiel) restent inclus.
function fusionnerRadars(osm, gouv) {
  const osmSeuls = osm.filter((o) => !gouv.some((g) => haversineKm(o.lat, o.lon, g.lat, g.lon) < 0.1));
  return [...gouv, ...osmSeuls];
}

export async function radarsLeLongDu(coords) {
  const rectangles = rectanglesLeLongDu(coords);
  const requete = `[out:json][timeout:25];(${rectangles.map((b) => `node["highway"="speed_camera"](${b});`).join("")});out;`;
  const [r, gouv] = await Promise.all([interrogerOverpass(requete), radarsGouvPresDuTrace(coords)]);
  const osm = r.ok ? r.elements.map((e) => ({ lat: e.lat, lon: e.lon })) : [];
  if (!r.ok && !gouv.length) return r;
  return { ok: true, radars: fusionnerRadars(osm, gouv) };
}

// Feux tricolores à moins de 20 m des morceaux de tracé donnés ([lon, lat][]).
export async function feuxLeLongDe(morceaux) {
  const utiles = morceaux.filter((m) => m.length >= 2);
  if (!utiles.length) return { ok: true, feux: [] };
  const requete = `[out:json][timeout:25];(${utiles.map((m) => `node["highway"="traffic_signals"](around:20,${ligne(m)});`).join("")});out;`;
  const r = await interrogerOverpass(requete);
  return r.ok ? { ok: true, feux: r.elements.map((e) => ({ lat: e.lat, lon: e.lon })) } : r;
}

// Routes (pour voitures) autour de chaque point : de quoi dessiner le
// carrefour vu de dessus. Renvoie { ok, routes } avec, pour chaque point,
// ses routes en [lon, lat][] (coupées à `rayonM` + 40 m), ou { ok: false, erreur }.
const TYPES_ROUTES = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$";

export async function routesAutourDe(points, rayonM) {
  if (!points.length) return { ok: true, routes: [] };
  const requete = `[out:json][timeout:25];${points.map((p) => `way["highway"~"${TYPES_ROUTES}"](around:${rayonM},${p.lat.toFixed(5)},${p.lon.toFixed(5)});out geom;`).join("")}`;
  const r = await interrogerOverpass(requete);
  if (!r.ok) return r;
  const garde = rayonM + 40;
  const routes = points.map((p) => {
    const proche = ({ lat, lon }) => haversineKm(p.lat, p.lon, lat, lon) * 1000 <= garde;
    const morceaux = [];
    for (const w of r.elements) {
      let courant = [];
      for (const n of w.geometry || []) {
        if (proche(n)) courant.push([n.lon, n.lat]);
        else {
          if (courant.length >= 2) morceaux.push(courant);
          courant = [];
        }
      }
      if (courant.length >= 2) morceaux.push(courant);
    }
    return morceaux;
  });
  return { ok: true, routes };
}

// Aires de service, aires de repos et bornes sur les tronçons rapides
// (morceaux de tracé [lon, lat][]). Renvoie { ok, lieux: [{ type, nom,
// lat, lon, puissance_kw }] } ou { ok: false, erreur }.
// Stations-service et aires de repos le long du tracé (pour l'affichage discret en navigation).
export async function servicesLeLongDe(morceaux) {
  const rectangles = morceaux.filter((m) => m.length >= 2).flatMap((m) => rectanglesLeLongDu(m, 0.004, 40));
  if (!rectangles.length) return { ok: true, essence: [], repos: [] };
  const requete = `[out:json][timeout:25];(${rectangles.map((b) => `nwr["amenity"="fuel"](${b});nwr["highway"~"^(services|rest_area)$"](${b});`).join("")});out center tags;`;
  const r = await interrogerOverpass(requete);
  if (!r.ok) return r;
  const vus = new Set();
  const essence = [];
  const repos = [];
  for (const e of r.elements) {
    const cle = `${e.type}/${e.id}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const t = e.tags || {};
    if (t.amenity === "fuel") essence.push({ lat, lon, nom: t.name || t.brand || "" });
    else repos.push({ lat, lon, nom: t.name || "", type: t.highway === "services" ? "service" : "repos" });
  }
  return { ok: true, essence, repos };
}

// Passages à niveau, stops et cédez-le-passage le long du tracé (aide à la conduite).
// Renvoie { ok, points } avec points = [{ lat, lon, type }] (type : passage, stop, cedez).
export async function alertesLeLongDu(coords) {
  const rectangles = rectanglesLeLongDu(coords);
  const requete = `[out:json][timeout:25];(${rectangles.map((b) => `node["railway"="level_crossing"](${b});node["highway"="stop"](${b});node["highway"="give_way"](${b});`).join("")});out;`;
  const r = await interrogerOverpass(requete);
  if (!r.ok) return r;
  const points = r.elements.map((e) => {
    const t = e.tags || {};
    const type = t.railway === "level_crossing" ? "passage" : t.highway === "stop" ? "stop" : "cedez";
    return { lat: e.lat, lon: e.lon, type };
  });
  return { ok: true, points };
}
