// Calcul détaillé de la consommation le long du trajet : vitesse réelle par
// tronçon (limitations/trafic TomTom), relief (altitudes Open-Meteo) et
// météo à l'heure de passage (température, pluie, vent -- Open-Meteo).
// Le modèle physique n'impose que la FORME de la consommation ; son niveau
// est calé sur la consommation déclarée dans le profil du véhicule.

import {
  PHYSIQUE,
  MULTIPLICATEURS_SAISON,
  MULTIPLICATEUR_CHARGE_LOURDE,
  PALIERS_TEMPERATURE,
  NB_MAX_ECHANTILLONS,
  NB_POINTS_METEO,
} from "./config.js";
import { haversineKm } from "./geo.js";

const G = 9.81;
const rad = (d) => (d * Math.PI) / 180;

function capDegres(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function typeSection(s) {
  return String(s.sectionType || "").toUpperCase().replace(/_/g, "");
}

// ── Profil de vitesse, point de tracé par point de tracé ────────────────────

function profilVitesse(coords, cumKm, sections, summary) {
  const n = coords.length - 1;
  const limite = new Array(n).fill(null);
  const autoroute = new Array(n).fill(false);
  const urbain = new Array(n).fill(false);
  const tunnel = new Array(n).fill(false);
  const trafic = new Array(n).fill(null);

  for (const s of sections) {
    const debut = Math.max(0, s.startPointIndex ?? 0);
    const fin = Math.min(n, s.endPointIndex ?? 0);
    const type = typeSection(s);
    for (let i = debut; i < fin; i++) {
      if (type === "MOTORWAY") autoroute[i] = true;
      else if (type === "URBAN") urbain[i] = true;
      else if (type === "TUNNEL") tunnel[i] = true;
      else if (type === "SPEEDLIMIT" && s.maxSpeedLimitInKmh) limite[i] = s.maxSpeedLimitInKmh;
      else if (type === "TRAFFIC" && s.effectiveSpeedInKmh) trafic[i] = s.effectiveSpeedInKmh;
    }
  }

  const lim = limite.map((l, i) => l ?? (autoroute[i] ? 130 : urbain[i] ? 50 : 80));
  const croisiere = lim.map((l) => (l >= 110 ? l * 0.93 : l >= 70 ? l * 0.9 : l * 0.7));
  const vitesse = croisiere.map((v, i) => (trafic[i] ? Math.min(v, trafic[i]) : v));

  // Recale les tronçons hors bouchon pour retrouver le temps total TomTom
  // (qui intègre le trafic réel) : sans ça, le profil serait trop optimiste.
  let tempsFixe = 0;
  let tempsLibre = 0;
  for (let i = 0; i < n; i++) {
    const h = (cumKm[i + 1] - cumKm[i]) / Math.max(vitesse[i], 1);
    if (trafic[i]) tempsFixe += h;
    else tempsLibre += h;
  }
  const tempsCibleH = (summary.travelTimeInSeconds || 0) / 3600;
  if (tempsLibre > 0 && tempsCibleH - tempsFixe > 0.01) {
    const facteur = tempsLibre / (tempsCibleH - tempsFixe);
    for (let i = 0; i < n; i++) {
      if (!trafic[i]) vitesse[i] = Math.max(5, Math.min(lim[i] * 1.1, vitesse[i] * facteur));
    }
  }

  const cumSec = [0];
  for (let i = 0; i < n; i++) cumSec.push(cumSec[i] + ((cumKm[i + 1] - cumKm[i]) / Math.max(vitesse[i], 1)) * 3600);
  return { vitesse, tunnel, cumSec };
}

// ── Échantillonnage régulier du tracé ───────────────────────────────────────

function echantillonner(coords, cumKm, cumSec) {
  const total = cumKm[cumKm.length - 1];
  const nb = Math.min(NB_MAX_ECHANTILLONS, Math.max(20, Math.ceil(total / 0.5)));
  const pas = total / nb;
  const points = [];
  let i = 0;
  for (let j = 0; j <= nb; j++) {
    const d = j === nb ? total : j * pas;
    while (i < coords.length - 2 && cumKm[i + 1] < d) i++;
    const longueur = cumKm[i + 1] - cumKm[i];
    const r = longueur > 0 ? Math.max(0, Math.min(1, (d - cumKm[i]) / longueur)) : 0;
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    points.push({
      km: d,
      lat: latA + (latB - latA) * r,
      lon: lonA + (lonB - lonA) * r,
      t_s: cumSec[i] + (cumSec[i + 1] - cumSec[i]) * r,
      index: i,
    });
  }
  return points;
}

// Open-Meteo gratuit : ~600 points par minute, et un trajet en consomme
// ~260. Avec patienceMs, un refus 429 est retenté après une pause au lieu
// de dégrader le calcul (utile pour les itinéraires alternatifs, calculés
// en arrière-plan juste après le principal).
async function fetchOpenMeteo(url, patienceMs = 0) {
  const PAUSE_MS = 20000;
  let attendu = 0;
  for (;;) {
    const resp = await fetch(url);
    if (resp.status !== 429 || attendu + PAUSE_MS > patienceMs) return resp;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    attendu += PAUSE_MS;
  }
}

// ── Altitudes (Open-Meteo, gratuit, sans clé, 100 points par requête) ──────

async function altitudes(points, patienceMs) {
  const lots = [];
  for (let k = 0; k < points.length; k += 100) lots.push(points.slice(k, k + 100));
  try {
    const reponses = await Promise.all(
      lots.map(async (lot) => {
        const params = new URLSearchParams({
          latitude: lot.map((p) => p.lat.toFixed(5)).join(","),
          longitude: lot.map((p) => p.lon.toFixed(5)).join(","),
        });
        const resp = await fetchOpenMeteo(`https://api.open-meteo.com/v1/elevation?${params}`, patienceMs);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data.elevation) || data.elevation.length !== lot.length) throw new Error("réponse incomplète");
        return data.elevation;
      }),
    );
    return reponses.flat();
  } catch (e) {
    console.warn("[RELIEF] Altitudes indisponibles, trajet supposé plat", e);
    return null;
  }
}

// Dans un tunnel, le modèle de terrain donne l'altitude de la montagne au-
// dessus : on relie simplement l'entrée et la sortie. Puis léger lissage.
function corrigerAltitudes(alt, points, tunnel) {
  const dansTunnel = points.map((p) => tunnel[p.index]);
  let j = 0;
  while (j < alt.length) {
    if (!dansTunnel[j]) {
      j++;
      continue;
    }
    const debut = Math.max(0, j - 1);
    let fin = j;
    while (fin < alt.length && dansTunnel[fin]) fin++;
    fin = Math.min(alt.length - 1, fin);
    for (let k = debut + 1; k < fin; k++) {
      const r = (points[k].km - points[debut].km) / Math.max(1e-6, points[fin].km - points[debut].km);
      alt[k] = alt[debut] + (alt[fin] - alt[debut]) * r;
    }
    j = fin + 1;
  }
  return alt.map((a, k) => (k === 0 || k === alt.length - 1 ? a : (alt[k - 1] + a + alt[k + 1]) / 3));
}

// ── Météo à l'heure de passage (Open-Meteo, gratuit, sans clé) ─────────────

async function meteoLeLongDuTrajet(points, departMs, patienceMs) {
  const indices = [];
  for (let k = 0; k < NB_POINTS_METEO; k++) indices.push(Math.round((k * (points.length - 1)) / (NB_POINTS_METEO - 1)));
  const lieux = [...new Set(indices)].map((idx) => points[idx]);

  const finMs = departMs + points[points.length - 1].t_s * 1000;
  const debutJour = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const jours = Math.ceil((finMs - debutJour) / 86400000) + 1;
  if (jours > 16) return null; // au-delà, Open-Meteo ne prévoit plus rien

  try {
    const params = new URLSearchParams({
      latitude: lieux.map((p) => p.lat.toFixed(4)).join(","),
      longitude: lieux.map((p) => p.lon.toFixed(4)).join(","),
      hourly: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m",
      timeformat: "unixtime",
      forecast_days: String(Math.max(1, jours)),
    });
    const resp = await fetchOpenMeteo(`https://api.open-meteo.com/v1/forecast?${params}`, patienceMs);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    let data = await resp.json();
    if (!Array.isArray(data)) data = [data];
    return lieux.map((p, k) => ({ km: p.km, hourly: data[k].hourly }));
  } catch (e) {
    console.warn("[METEO] Météo du trajet indisponible", e);
    return null;
  }
}

function meteoAuPoint(stations, km, instantMs) {
  let station = stations[0];
  for (const s of stations) if (Math.abs(s.km - km) < Math.abs(station.km - km)) station = s;
  const h = station.hourly;
  const t0 = h.time[0] * 1000;
  const idx = Math.max(0, Math.min(h.time.length - 1, Math.round((instantMs - t0) / 3600000)));
  return {
    temperature: h.temperature_2m[idx],
    pluie: h.precipitation[idx] ?? 0,
    vent_kmh: h.wind_speed_10m[idx] ?? 0,
    vent_de: h.wind_direction_10m[idx] ?? 0,
  };
}

function descriptionTemperature(temp) {
  for (const [seuil, mult, description] of PALIERS_TEMPERATURE) if (temp < seuil) return { multiplicateur: mult, description };
  return { multiplicateur: 1.05, description: "chaleur, climatisation" };
}

// ── Modèle physique ─────────────────────────────────────────────────────────

function masseVehicule(profil, chargeLourde) {
  return PHYSIQUE.masse_base_kg + PHYSIQUE.masse_par_kwh_batterie_kg * profil.capacite_kwh + PHYSIQUE.masse_conducteur_kg;
}

function energieSegmentKwh(dKm, dH, vKmh, temperature, pluie, ventFaceKmh, masse) {
  const P = PHYSIQUE;
  const v = vKmh / 3.6;
  const rho = (1.225 * 288.15) / (273.15 + temperature);
  const vAir = v + ventFaceKmh / 3.6;
  const fAero = 0.5 * rho * P.surface_trainee_m2 * vAir * Math.abs(vAir);
  const mouille = pluie > P.pluie_seuil_mm_h ? Math.min(P.pluie_roulement_max, P.pluie_roulement_base + P.pluie_roulement_par_mm * pluie) : 0;
  const fRoulement = P.coef_roulement * (1 + mouille) * masse * G;

  let traction = (fAero + fRoulement) * dKm * 1000;
  if (vKmh < 45) traction *= 1 + P.penalite_ville;
  const roue = traction + masse * G * dH;
  const batterie = roue > 0 ? roue / P.rendement_traction : roue * P.rendement_recuperation;

  let auxKw = P.puissance_auxiliaire_base_kw;
  if (temperature < 18) auxKw += Math.min(P.chauffage_max_kw, (18 - temperature) * P.chauffage_kw_par_degre);
  if (temperature > 24) auxKw += Math.min(P.clim_max_kw, (temperature - 24) * P.clim_kw_par_degre);
  if (mouille) auxKw += P.pluie_auxiliaire_kw;
  const dureeS = (dKm / Math.max(vKmh, 1)) * 3600;

  const froid = temperature < 10 ? 1 + Math.min(P.penalite_froid_max, (10 - temperature) * P.penalite_froid_par_degre) : 1;
  return ((batterie + auxKw * 1000 * dureeS) / 3.6e6) * froid;
}

// ── Fonctions d'énergie cumulée utilisées par le planificateur ─────────────

export function fonctionsEnergie(km, ecum) {
  const energieA = (d) => {
    if (d <= km[0]) return ecum[0];
    if (d >= km[km.length - 1]) return ecum[ecum.length - 1];
    let bas = 0;
    let haut = km.length - 1;
    while (haut - bas > 1) {
      const milieu = (bas + haut) >> 1;
      if (km[milieu] <= d) bas = milieu;
      else haut = milieu;
    }
    const r = (d - km[bas]) / Math.max(1e-9, km[haut] - km[bas]);
    return ecum[bas] + (ecum[haut] - ecum[bas]) * r;
  };
  // Première distance (après d0) où l'énergie consommée depuis d0 atteint
  // `budgetKwh` -- la récupération en descente peut faire baisser l'énergie
  // cumulée, d'où un parcours plutôt qu'une simple inversion.
  const distanceMax = (d0, budgetKwh) => {
    if (budgetKwh <= 0) return d0;
    const e0 = energieA(d0);
    let precKm = d0;
    let precE = 0;
    for (let j = 0; j < km.length; j++) {
      if (km[j] <= d0) continue;
      const e = ecum[j] - e0;
      if (e >= budgetKwh) return precKm + ((budgetKwh - precE) / Math.max(1e-9, e - precE)) * (km[j] - precKm);
      precKm = km[j];
      precE = e;
    }
    return Infinity;
  };
  return { energieA, distanceMax };
}

export function fonctionsEnergieConstante(consoKwh100km) {
  return {
    energieA: (d) => (d * consoKwh100km) / 100,
    distanceMax: (d0, budgetKwh) => (budgetKwh <= 0 ? d0 : d0 + (budgetKwh / consoKwh100km) * 100),
  };
}

// ── Construction du profil complet ──────────────────────────────────────────

export async function construireProfilEnergie(itin, profil, options) {
  const { coords } = itin;
  const cumBrut = [0];
  for (let i = 1; i < coords.length; i++) {
    cumBrut.push(cumBrut[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  // Recale sur la distance officielle TomTom, utilisée partout ailleurs.
  const echelle = itin.distance_km / Math.max(1e-6, cumBrut[cumBrut.length - 1]);
  const cumKm = cumBrut.map((d) => d * echelle);

  const { vitesse, tunnel, cumSec: cumSecLibre } = profilVitesse(coords, cumKm, itin._sections || [], itin._summary || {});
  // Simulation « et si je roulais moins vite ? » : la vitesse est plafonnée,
  // le temps de route s'allonge d'autant (secondes_en_plus).
  let cumSec = cumSecLibre;
  if (options.vitesse_max_kmh > 0) {
    cumSec = [0];
    for (let i = 0; i < vitesse.length; i++) cumSec.push(cumSec[i] + ((cumKm[i + 1] - cumKm[i]) / Math.max(Math.min(vitesse[i], options.vitesse_max_kmh), 1)) * 3600);
  }
  const secondesEnPlus = cumSec[cumSec.length - 1] - cumSecLibre[cumSecLibre.length - 1];
  const points = echantillonner(coords, cumKm, cumSec);

  const [altBrutes, stations] = await Promise.all([
    altitudes(points, options.patience_ms),
    options.ajuster_meteo ? meteoLeLongDuTrajet(points, options.depart_ms, options.patience_ms) : Promise.resolve(null),
  ]);
  const reliefOk = !!altBrutes;
  const alt = reliefOk ? corrigerAltitudes(altBrutes.slice(), points, tunnel) : points.map(() => 0);
  const meteoOk = !!stations;

  const masse = masseVehicule(profil);
  const calibrage =
    profil.consommation_kwh_100km / 100 /
    energieSegmentKwh(1, 0, PHYSIQUE.vitesse_calibrage_kmh, PHYSIQUE.temperature_calibrage_c, 0, 0, masse);
  // Sans météo réelle : le réglage saisonnier du profil (comme JARVIS).
  const multSaison = meteoOk ? 1 : MULTIPLICATEURS_SAISON[profil.saison] ?? 1;
  const multLourde = options.charge_lourde ? MULTIPLICATEUR_CHARGE_LOURDE : 1;

  const segments = [];
  const km = [points[0].km];
  const ecum = [0];
  for (let j = 0; j < points.length - 1; j++) {
    const a = points[j];
    const b = points[j + 1];
    const dKm = b.km - a.km;
    const dureeS = Math.max(1, b.t_s - a.t_s);
    const vKmh = (dKm / dureeS) * 3600;
    const cap = capDegres(a.lat, a.lon, b.lat, b.lon);

    let temperature = PHYSIQUE.temperature_calibrage_c;
    let pluie = 0;
    let ventFace = 0;
    let ventKmh = null;
    if (meteoOk) {
      const m = meteoAuPoint(stations, (a.km + b.km) / 2, options.depart_ms + ((a.t_s + b.t_s) / 2) * 1000);
      temperature = m.temperature;
      pluie = m.pluie;
      ventKmh = m.vent_kmh;
      // direction météo = d'où vient le vent ; positif = vent de face
      ventFace = m.vent_kmh * PHYSIQUE.facteur_vent_sol * Math.cos(rad(m.vent_de - cap));
    }

    const energie = energieSegmentKwh(dKm, alt[j + 1] - alt[j], vKmh, temperature, pluie, ventFace, masse) * calibrage * multSaison * multLourde;
    segments.push({
      km_debut: a.km,
      km_fin: b.km,
      vitesse: vKmh,
      altitude: alt[j],
      energie_kwh: energie,
      conso_kwh100: dKm > 0 ? (energie / dKm) * 100 : 0,
      temperature: meteoOk ? temperature : null,
      pluie: meteoOk ? pluie : null,
      vent_kmh: ventKmh,
      vent_face: meteoOk ? ventFace : null,
    });
    km.push(b.km);
    ecum.push(ecum[j] + energie);
  }

  let denivelePos = 0;
  let deniveleNeg = 0;
  for (let j = 1; j < alt.length; j++) {
    const d = alt[j] - alt[j - 1];
    if (d > 0) denivelePos += d;
    else deniveleNeg -= d;
  }
  const energieTotale = ecum[ecum.length - 1];
  const temps = segments.filter((s) => s.temperature !== null).map((s) => s.temperature);
  const kmPluie = segments.filter((s) => s.pluie !== null && s.pluie > PHYSIQUE.pluie_seuil_mm_h).reduce((t, s) => t + (s.km_fin - s.km_debut), 0);
  const ventFaceMoyen = meteoOk ? segments.reduce((t, s) => t + (s.vent_face || 0) * (s.km_fin - s.km_debut), 0) / Math.max(1e-6, itin.distance_km) : null;

  let meteoDepart = null;
  if (meteoOk) {
    const m = meteoAuPoint(stations, 0, options.depart_ms);
    meteoDepart = { ok: true, temperature_c: m.temperature, ...descriptionTemperature(m.temperature) };
  }

  return {
    segments,
    altitude_fin: alt[alt.length - 1],
    km,
    ecum,
    relief_ok: reliefOk,
    meteo_ok: meteoOk,
    meteo_depart: meteoDepart,
    secondes_en_plus: secondesEnPlus,
    stats: {
      conso_moyenne_kwh100: itin.distance_km > 0 ? (energieTotale / itin.distance_km) * 100 : 0,
      energie_totale_kwh: energieTotale,
      denivele_positif_m: reliefOk ? denivelePos : null,
      denivele_negatif_m: reliefOk ? deniveleNeg : null,
      altitude_max_m: reliefOk ? Math.max(...alt) : null,
      vitesse_moyenne_kmh: itin.duree_min > 0 ? itin.distance_km / (itin.duree_min / 60) : null,
      temperature_min: temps.length ? Math.min(...temps) : null,
      temperature_max: temps.length ? Math.max(...temps) : null,
      km_sous_la_pluie: meteoOk ? kmPluie : null,
      vent_face_moyen_kmh: ventFaceMoyen,
    },
  };
}

// Consommation à `vKmh` rapportée à celle à 90 km/h (vitesse de référence
// du profil), à plat, 15 °C : ~1,4 à 130 km/h pour une Kona.
export function facteurVitesse(profil, vKmh) {
  const masse = masseVehicule(profil);
  return energieSegmentKwh(1, 0, vKmh, 15, 0, 0, masse) / energieSegmentKwh(1, 0, 90, 15, 0, 0, masse);
}
