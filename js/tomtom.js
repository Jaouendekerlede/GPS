// Calcul d'itinéraire réel via l'API Routing de TomTom (clé gratuite) --
// porté depuis jarvis_tomtom_runtime.calculer_itineraire_tomtom, avec en
// plus : limitations de vitesse et zones urbaines (calcul détaillé),
// étapes intermédiaires (bornes de recharge), instructions de guidage en
// français (navigation), itinéraires alternatifs et suivi d'un tracé imposé.

import { haversineKm } from "./geo.js";

const SECTIONS_BASE = ["motorway", "tollRoad", "tunnel", "traffic"];
const SECTIONS_VITESSE = ["speedLimit", "urban"];
// Mesuré sur Paris -> Lyon : un point tous les ~450 m reconstruit
// exactement la route, un tous les ~1,8 km la fait dévier.
const ECART_POINTS_SUPPORT_KM = 0.25;

function allegerTrace(coords) {
  const garde = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const [lonA, latA] = garde[garde.length - 1];
    const [lon, lat] = coords[i];
    if (haversineKm(latA, lonA, lat, lon) >= ECART_POINTS_SUPPORT_KM) garde.push(coords[i]);
  }
  if (coords.length > 1) garde.push(coords[coords.length - 1]);
  return garde.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
}

async function requete(apiKey, points, options, sections, pointsSupport) {
  const chemin = points.map((p) => `${p.lat},${p.lon}`).join(":");
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${chemin}/json`;
  const params = new URLSearchParams({
    key: apiKey,
    routeRepresentation: "polyline",
    travelMode: "car",
    traffic: "true",
  });
  for (const s of sections) params.append("sectionType", s);
  if (options.departAt) params.set("departAt", options.departAt);
  if (options.instructions) {
    params.set("instructionsType", "text");
    params.set("language", "fr-FR");
  }
  if (options.maxAlternatives) params.set("maxAlternatives", String(options.maxAlternatives));
  // Direction actuelle de la voiture : évite un demi-tour absurde au recalcul.
  if (Number.isFinite(options.cap)) params.set("vehicleHeading", String(Math.round(((options.cap % 360) + 360) % 360)));

  // Le plus court plutôt que le plus rapide (TomTom : fastest par défaut).
  if (options.plusCourt) params.set("routeType", "shortest");
  if (options.eviterAutoroutes) params.append("avoid", "motorways");
  if (options.eviterPeages) params.append("avoid", "tollRoads");
  if (options.eviterFerries) params.append("avoid", "ferries");
  if (options.eviterZonesFaiblesEmissions) params.append("avoid", "lowEmissionZones");
  if (options.eviterRoutesNonRevetues) params.append("avoid", "unpavedRoads");

  // Tracé à suivre et zones à éviter (route barrée) : seulement en POST.
  const corps = {};
  if (pointsSupport) corps.supportingPoints = pointsSupport;
  if (options.zonesEvitees?.length) corps.avoidAreas = { rectangles: options.zonesEvitees };
  if (typeof localStorage !== "undefined") compterAppelTomTom();
  if (!Object.keys(corps).length) return fetch(`${url}?${params.toString()}`);
  return fetch(`${url}?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });
}

function lireRoute(route) {
  return {
    coords: route.legs.flatMap((leg) => leg.points.map((p) => [p.longitude, p.latitude])),
    summary: route.summary,
    sections: route.sections || [],
    guidance: route.guidance || null,
    legs: route.legs.map((leg) => ({ summary: leg.summary, nbPoints: leg.points.length })),
  };
}

// Texte d'explication d'un refus TomTom (JSON detailedError, ou page HTML
// du type « Developer Over Qps » pour un dépassement de quota).
export async function lireRefusTomTom(reponse) {
  try {
    const texte = await reponse.text();
    try {
      const j = JSON.parse(texte);
      return j.detailedError?.message || j.error?.description || j.errorText || texte.slice(0, 120);
    } catch {
      return texte.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    }
  } catch {
    return "";
  }
}

// Vérifie, l'un après l'autre, chaque service TomTom utilisé par l'appli.
export async function diagnostiquerCleTomTom(cle) {
  const k = encodeURIComponent(cle);
  const services = [
    ["Itinéraires", `https://api.tomtom.com/routing/1/calculateRoute/48.1110,-1.6800:48.1200,-1.6600/json?key=${k}`],
    ["Cartes 2D", `https://api.tomtom.com/map/1/tile/basic/night/10/505/355.png?key=${k}&tileSize=512`],
    ["Style de la carte 3D", `https://api.tomtom.com/style/1/style/*?map=2/basic_street-dark&key=${k}`],
    ["Cartes 3D", `https://api.tomtom.com/map/2/tile/basic/10/505/355.pbf?key=${k}`],
  ];
  const resultats = [];
  for (const [service, url] of services) {
    try {
      const r = await fetch(url);
      resultats.push({ service, ok: r.ok, statut: r.status, message: r.ok ? "" : await lireRefusTomTom(r) });
    } catch (e) {
      resultats.push({ service, ok: false, statut: 0, message: `réseau : ${e.message}` });
    }
  }
  return resultats;
}

// options.traceImposee ([lon, lat][]) : TomTom reconstruit cette route au
// lieu de choisir la plus rapide. Incompatible avec des étapes (refus de
// l'API), donc ignorée s'il y en a.
// options.zonesEvitees : rectangles { southWestCorner, northEastCorner }
// ({ latitude, longitude }) que la route ne doit pas traverser (10 au plus).
// Traduit une manœuvre OpenStreetMap (OSRM) dans le vocabulaire TomTom utilisé par le guidage.
function traduireManoeuvre(type, modifier, exit) {
  if (type === "arrive") return { code: "ARRIVE", message: "Vous êtes arrivé à destination." };
  if (type === "roundabout" || type === "rotary") {
    const sortie = exit ? `Au rond-point, prenez la ${exit}${exit === 1 ? "re" : "e"} sortie.` : "Au rond-point, continuez.";
    return { code: "ROUNDABOUT_CROSS", message: sortie };
  }
  if (modifier === "uturn") return { code: "U_TURN", message: "Faites demi-tour." };
  if (type === "off ramp" || type === "exit roundabout") {
    const cote = modifier && modifier.includes("left") ? "LEFT" : "RIGHT";
    return { code: `EXIT_${cote}`, message: `Prenez la sortie à ${cote === "LEFT" ? "gauche" : "droite"}.` };
  }
  if (modifier === "sharp left") return { code: "SHARP_LEFT", message: "Tournez franchement à gauche." };
  if (modifier === "sharp right") return { code: "SHARP_RIGHT", message: "Tournez franchement à droite." };
  if (modifier === "left") return { code: "TURN_LEFT", message: "Tournez à gauche." };
  if (modifier === "right") return { code: "TURN_RIGHT", message: "Tournez à droite." };
  if (modifier === "slight left") return { code: "BEAR_LEFT", message: "Restez à gauche." };
  if (modifier === "slight right") return { code: "BEAR_RIGHT", message: "Restez à droite." };
  return { code: "STRAIGHT", message: "Continuez tout droit." };
}

// Instructions de guidage à partir des étapes OSRM : position sur le tracé (pointIndex) et message.
function instructionsOsm(legs, coords) {
  const sortie = [];
  for (const leg of legs || []) {
    for (const etape of leg.steps || []) {
      const m = etape.maneuver || {};
      if (m.type === "depart" || !Array.isArray(m.location)) continue;
      const [lon, lat] = m.location;
      let meilleur = 0;
      let distMin = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const dx = coords[i][0] - lon;
        const dy = coords[i][1] - lat;
        const d = dx * dx + dy * dy;
        if (d < distMin) { distMin = d; meilleur = i; }
      }
      const { code, message } = traduireManoeuvre(m.type, m.modifier, m.exit);
      sortie.push({
        pointIndex: meilleur,
        message,
        maneuver: code,
        instructionType: code.startsWith("ROUNDABOUT") ? "ROUNDABOUT" : "TURN",
        junctionType: "",
        street: etape.name || "",
        roadNumbers: etape.ref ? etape.ref.split(/[;\s]+/).filter(Boolean) : [],
        exitNumber: m.exit ? String(m.exit) : "",
        roundaboutExitNumber: m.type === "roundabout" || m.type === "rotary" ? (m.exit ?? null) : null,
      });
    }
  }
  return sortie;
}

// Sans clé TomTom : itinéraire OpenStreetMap (OSRM), renvoyé dans la même forme que TomTom.
async function itineraireOsm(points, options) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const alternatives = options.maxAlternatives === 0 ? "false" : "true";
  const profil = { voiture: "routed-car", velo: "routed-bike", pieton: "routed-foot" }[options.mode] || "routed-car";
  const url = `https://routing.openstreetmap.de/${profil}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { erreur: `osm_${resp.status}` };
    const data = await resp.json();
    const routes = (data.routes || []).map((r) => ({
      coords: r.geometry.coordinates,
      summary: { lengthInMeters: r.distance, travelTimeInSeconds: r.duration, trafficDelayInSeconds: 0 },
      sections: [],
      guidance: { instructions: instructionsOsm(r.legs, r.geometry.coordinates) },
      legs: [{ summary: { travelTimeInSeconds: r.duration }, nbPoints: r.geometry.coordinates.length }],
    }));
    if (!routes.length) return { erreur: "aucun_itineraire" };
    return { ...routes[0], alternatives: routes.slice(1), traceSuivie: false, erreur: null };
  } catch (e) {
    console.warn("[OSM] Erreur calcul itinéraire", e);
    return { erreur: "reseau" };
  }
}

export async function calculerItineraireTomTom(apiKey, lat1, lon1, lat2, lon2, options = {}) {
  const etapes = options.etapes || [];
  const points = [{ lat: lat1, lon: lon1 }, ...etapes, { lat: lat2, lon: lon2 }];
  // TomTom ne traite que la voiture ici : vélo et piéton passent par OpenStreetMap.
  if (!apiKey || (options.mode && options.mode !== "voiture")) return itineraireOsm(points, options);
  const support = !etapes.length && options.traceImposee?.length >= 2 ? allegerTrace(options.traceImposee) : null;
  try {
    // Filets de sécurité : sans les sections de vitesse (requête d'origine
    // de JARVIS), puis sans le tracé imposé, plutôt que d'échouer.
    // Voies de circulation : seulement pour le guidage (navigation).
    const detail = [...SECTIONS_BASE, ...SECTIONS_VITESSE, ...(options.instructions ? ["lanes"] : [])];
    const essais = [
      [detail, support],
      [SECTIONS_BASE, support],
    ];
    if (support) essais.push([detail, null], [SECTIONS_BASE, null]);
    let resp;
    let traceSuivie = false;
    for (const [sections, pts] of essais) {
      resp = await requete(apiKey, points, options, sections, pts);
      traceSuivie = !!pts;
      if (resp.status !== 400) break;
    }
    if (!resp.ok) {
      console.warn(`[TOMTOM] Erreur HTTP ${resp.status}`);
      return { erreur: `http_${resp.status}` };
    }
    const data = await resp.json();
    const routes = (data.routes || []).map(lireRoute);
    if (!routes.length) return { erreur: "aucun_itineraire" };
    if (support && !traceSuivie) console.warn("[TOMTOM] Tracé imposé refusé, itinéraire le plus rapide utilisé");
    return { ...routes[0], alternatives: routes.slice(1), traceSuivie, erreur: null };
  } catch (e) {
    console.warn("[TOMTOM] Erreur calcul itinéraire", e);
    return { erreur: "reseau" };
  }
}

// Appels du jour aux services TomTom payants au-delà du gratuit (itinéraires,
// recherches) : ~2 500 par jour sur un compte gratuit.
const CLE_QUOTA = "tve_quota_tomtom";
export const QUOTA_TOMTOM_JOUR = 2500;

export function compterAppelTomTom() {
  const jour = new Date().toDateString();
  let q = { jour, n: 0 };
  try {
    const lu = JSON.parse(localStorage.getItem(CLE_QUOTA));
    if (lu?.jour === jour) q = lu;
  } catch {
    // compteur illisible : repart de zéro
  }
  q.n++;
  try {
    localStorage.setItem(CLE_QUOTA, JSON.stringify(q));
  } catch {
    // stockage plein : pas de compteur
  }
  return q.n;
}

export function appelsTomTomDuJour() {
  try {
    const q = JSON.parse(localStorage.getItem(CLE_QUOTA));
    return q?.jour === new Date().toDateString() ? q.n : 0;
  } catch {
    return 0;
  }
}
