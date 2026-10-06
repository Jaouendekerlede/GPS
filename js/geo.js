// Géocodage (Nominatim/OpenStreetMap, gratuit, sans clé) + calcul de
// distance -- portés depuis jarvis_weather_runtime.geocode_lieu et
// jarvis_ev_charge_runtime.haversine_km.

export async function geocodeLieu(nomLieu) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(nomLieu)}&format=json&limit=1`;
  for (let tentative = 0; tentative < 2; tentative++) {
    try {
      const resp = await fetch(url, { headers: { "Accept-Language": "fr" } });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.length) {
          return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), nom: data[0].display_name || nomLieu };
        }
        return null;
      }
    } catch (e) {
      console.warn(`[GEO] Erreur géocodage "${nomLieu}" (tentative ${tentative + 1}/2)`, e);
    }
    if (tentative === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const MOTS_POSITION = ["ma position", "position actuelle", "ici", "gps"];

// Suggestions pendant la saisie : Photon (OpenStreetMap, fait pour ça ;
// Nominatim l'interdit). pres : { lat, lon } pour favoriser les lieux proches.
const lieuxChoisis = new Map();

export function memoriserLieu(libelle, lat, lon) {
  lieuxChoisis.set(libelle.trim().toLowerCase(), { lat, lon, nom: libelle });
}

export async function suggestionsLieux(texte, pres, signal) {
  const p = new URLSearchParams({ q: texte, lang: "fr", limit: "6" });
  if (pres && Number.isFinite(pres.lat)) {
    p.set("lat", pres.lat.toFixed(3));
    p.set("lon", pres.lon.toFixed(3));
  }
  try {
    const r = await fetch(`https://photon.komoot.io/api/?${p}`, { signal });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.features || [])
      .map((f) => {
        const q = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        const rue = [q.housenumber, q.street].filter(Boolean).join(" ");
        const nom = q.name || rue || q.city || "";
        const detail = [q.name && rue ? rue : "", q.postcode, q.city && q.city !== nom ? q.city : "", q.country && q.country !== "France" ? q.country : ""].filter(Boolean).join(", ");
        return { nom, detail, libelle: [nom, detail].filter(Boolean).join(", "), lat, lon };
      })
      .filter((s) => s.nom && Number.isFinite(s.lat));
  } catch {
    return [];
  }
}
const MOTS_DOMICILE = ["chez moi", "maison", "domicile", "à la maison", "a la maison"];
const MOTS_TRAVAIL = ["travail", "boulot", "bureau", "au travail"];

function positionGps() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ erreur: "La localisation GPS n'est pas disponible sur cet appareil." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, precision: pos.coords.accuracy, nom: "Ma position" }),
      (err) =>
        resolve({
          erreur:
            err.code === err.PERMISSION_DENIED
              ? "Accès à la position refusé. Autorise la localisation pour cette appli dans Chrome."
              : "Position GPS introuvable pour le moment. Réessaie ou saisis une adresse.",
        }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 },
    );
  });
}

// Même rôle que _resoudre_lieu_itineraire de JARVIS : "chez moi" et "ma
// position" sont des raccourcis, tout le reste passe par le géocodage.
// « Ma position » (ou champ vide) : résolu par le GPS, sans géocodage.
export function estMaPosition(nomLieu) {
  const cle = (nomLieu || "").trim().toLowerCase();
  return !cle || MOTS_POSITION.includes(cle);
}

export async function resoudreLieu(nomLieu, adresseDomicile, adresseTravail) {
  const brut = (nomLieu || "").trim();
  const cle = brut.toLowerCase();
  if (!brut || MOTS_POSITION.includes(cle)) return positionGps();
  const coordonnees = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(brut);
  if (coordonnees) return { lat: parseFloat(coordonnees[1]), lon: parseFloat(coordonnees[2]), nom: "Position actuelle" };
  // Adresse choisie dans les suggestions : position déjà connue.
  const choisi = lieuxChoisis.get(cle);
  if (choisi) return choisi;
  if (MOTS_DOMICILE.includes(cle)) {
    if (!adresseDomicile) {
      return { erreur: "Adresse du domicile non renseignée. Ajoute-la dans Menu › Domicile et voix, ou utilise « Ma position »." };
    }
    const lieu = await geocodeLieu(adresseDomicile);
    return lieu ? { ...lieu, nom: `Chez moi (${lieu.nom})` } : { erreur: `Adresse du domicile introuvable : "${adresseDomicile}".` };
  }
  if (MOTS_TRAVAIL.includes(cle)) {
    if (!adresseTravail) return { erreur: "Adresse du travail non renseignée. Ajoute-la dans 🚗 Profil." };
    const lieuTravail = await geocodeLieu(adresseTravail);
    return lieuTravail ? { ...lieuTravail, nom: `Travail (${lieuTravail.nom})` } : { erreur: `Adresse du travail introuvable : "${adresseTravail}".` };
  }
  const lieu = await geocodeLieu(brut);
  return lieu || { erreur: `Lieu introuvable : "${brut}".` };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rayonTerreKm = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlambda / 2) ** 2;
  return rayonTerreKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// coords : liste de [lon, lat] (format TomTom). Trouve le point situé à
// `distanceCibleKm` du début du tracé, par interpolation linéaire entre
// les deux points qui l'encadrent.
export function pointADistanceSurTrace(coords, distanceCibleKm) {
  if (!coords || !coords.length || distanceCibleKm <= 0) {
    return coords && coords.length ? { lat: coords[0][1], lon: coords[0][0] } : null;
  }
  let cumulKm = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    const segmentKm = haversineKm(latA, lonA, latB, lonB);
    if (cumulKm + segmentKm >= distanceCibleKm) {
      if (segmentKm <= 0) return { lat: latA, lon: lonA };
      const ratio = (distanceCibleKm - cumulKm) / segmentKm;
      return { lat: latA + (latB - latA) * ratio, lon: lonA + (lonB - lonA) * ratio };
    }
    cumulKm += segmentKm;
  }
  const dernier = coords[coords.length - 1];
  return { lat: dernier[1], lon: dernier[0] };
}

// Carrés (format « avoidAreas » de TomTom) centrés sur le tracé, aux
// distances données (m) après `offset`. cum : distances cumulées (m) des
// points de coords ([lon, lat]). Les distances au-delà du tracé sont ignorées.
export function carresSurTrace(coords, cum, offset, distances, demiCoteM) {
  const carres = [];
  const total = cum[cum.length - 1];
  let i = 0;
  for (const d of distances) {
    const cible = offset + d;
    if (cible > total || coords.length < 2) break;
    while (i < cum.length - 2 && cum[i + 1] < cible) i++;
    const t = cum[i + 1] > cum[i] ? Math.max(0, Math.min(1, (cible - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
    const lon = coords[i][0] + t * (coords[i + 1][0] - coords[i][0]);
    const lat = coords[i][1] + t * (coords[i + 1][1] - coords[i][1]);
    const dLat = demiCoteM / 111320;
    const dLon = demiCoteM / (111320 * Math.cos((lat * Math.PI) / 180));
    carres.push({ southWestCorner: { latitude: lat - dLat, longitude: lon - dLon }, northEastCorner: { latitude: lat + dLat, longitude: lon + dLon } });
  }
  return carres;
}

// Le tracé ([lon, lat]) passe-t-il dans l'un des carrés ? Chaque segment
// est parcouru par pas de 10 m au plus (les points peuvent être espacés).
export function traceTraverseCarres(coords, carres) {
  const dedans = (lon, lat) => carres.some((c) => lat >= c.southWestCorner.latitude && lat <= c.northEastCorner.latitude && lon >= c.southWestCorner.longitude && lon <= c.northEastCorner.longitude);
  for (let i = 0; i < coords.length; i++) {
    const [lonA, latA] = coords[i];
    if (dedans(lonA, latA)) return true;
    if (i === coords.length - 1) break;
    const [lonB, latB] = coords[i + 1];
    const pas = Math.ceil((haversineKm(latA, lonA, latB, lonB) * 1000) / 10);
    for (let k = 1; k < pas; k++) if (dedans(lonA + ((lonB - lonA) * k) / pas, latA + ((latB - latA) * k) / pas)) return true;
  }
  return false;
}

// Flèche de manœuvre dessinée sur la route (comme les GPS) : le tracé de
// `avantM` avant à `apresM` après le point de la manœuvre (offset, m), et
// une pointe triangulaire au bout. Renvoie { ligne, pointe } en [lon, lat].
export function flecheManoeuvre(coords, cum, offset, { avantM = 35, apresM = 28, pointeM = 8, demiLargeurM = 5 } = {}) {
  const total = cum[cum.length - 1];
  if (coords.length < 2 || !(total > 0)) return null;
  const debut = Math.max(0, offset - avantM);
  const fin = Math.min(total, offset + apresM);
  if (fin - debut < 5) return null;
  const point = (d) => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const t = cum[i + 1] > cum[i] ? Math.max(0, Math.min(1, (d - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
    return [coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), coords[i][1] + t * (coords[i + 1][1] - coords[i][1])];
  };
  const ligne = [point(debut)];
  for (let i = 0; i < cum.length; i++) if (cum[i] > debut && cum[i] < fin) ligne.push(coords[i]);
  ligne.push(point(fin));
  // Coins arrondis : une flèche qui épouse la route, sans angles.
  const lissee = lisser(ligne);
  // Direction du dernier morceau (au moins 3 m, pour un sens fiable).
  const [lonF, latF] = ligne[ligne.length - 1];
  const [lonP, latP] = point(Math.max(debut, fin - 3));
  const kx = 111320 * Math.cos((latF * Math.PI) / 180);
  const ky = 110540;
  let dx = (lonF - lonP) * kx;
  let dy = (latF - latP) * ky;
  const n = Math.hypot(dx, dy) || 1;
  dx /= n;
  dy /= n;
  const versLonLat = (x, y) => [lonF + x / kx, latF + y / ky];
  const pointe = [versLonLat(-dy * demiLargeurM, dx * demiLargeurM), versLonLat(dx * pointeM, dy * pointeM), versLonLat(dy * demiLargeurM, -dx * demiLargeurM)];
  return { ligne: lissee, pointe };
}

// Sortie réelle d'un rond-point, d'après le tracé : dans l'anneau on tourne
// à gauche (sens giratoire), et on en sort en tournant à droite. Renvoie
// { offset, angle } (angle de sortie en degrés par rapport à l'arrivée,
// positif à droite), ou null (mini rond-point, tracé trop court).
export function sortieRondPoint(coords, cum, offsetEntree) {
  const total = cum[cum.length - 1];
  if (coords.length < 2 || !(total > 0)) return null;
  const point = (d) => {
    d = Math.max(0, Math.min(total, d));
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const t = cum[i + 1] > cum[i] ? (d - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    return [coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), coords[i][1] + t * (coords[i + 1][1] - coords[i][1])];
  };
  const cap = (d1, d2) => {
    const [lon1, lat1] = point(d1);
    const [lon2, lat2] = point(d2);
    return (Math.atan2((lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180), lat2 - lat1) * 180) / Math.PI;
  };
  const ecart = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const capArrivee = cap(offsetEntree - 25, offsetEntree - 5);
  let gauche = 0;
  let precedent = cap(offsetEntree, offsetEntree + 6);
  for (let d = offsetEntree + 3; d < offsetEntree + 250 && d < total - 12; d += 3) {
    const c = cap(d, d + 6);
    const t = ecart(c - precedent);
    precedent = c;
    if (t < 0) gauche -= t;
    else if (gauche > 25 && ecart(cap(d + 3, d + 12) - cap(d - 9, d)) > 15) {
      return { offset: d, angle: ecart(cap(d + 8, d + 28) - capArrivee) };
    }
  }
  return null;
}

// Lissage (coins arrondis) d'une ligne de points [x, y] : méthode de
// Chaikin, les extrémités restent en place.
export function lisser(points, passes = 2) {
  let pts = points;
  for (let p = 0; p < passes && pts.length > 2; p++) {
    const suivants = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      suivants.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    suivants.push(pts[pts.length - 1]);
    pts = suivants;
  }
  return pts;
}

// Un point au moins tous les `pasM` mètres (pour suivre un rond-point).
export function densifier(coords, pasM) {
  if (coords.length < 2) return coords.slice();
  const res = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lonA, latA] = coords[i - 1];
    const [lonB, latB] = coords[i];
    const n = Math.ceil((haversineKm(latA, lonA, latB, lonB) * 1000) / pasM);
    for (let k = 1; k <= n; k++) res.push([lonA + ((lonB - lonA) * k) / n, latA + ((latB - latA) * k) / n]);
  }
  return res;
}

// Recale chaque point sur la route dessinée la plus proche (à moins de
// `ecartMaxM`), orientée à peu près comme le tracé (pas sur une rue qui
// croise). segments : [[lon, lat], [lon, lat]][].
export function recalerSurRoutes(points, segments, ecartMaxM) {
  if (!segments.length) return points.slice();
  return points.map(([lon, lat], i) => {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 110540;
    const [p0, p1] = [points[Math.max(0, i - 1)], points[Math.min(points.length - 1, i + 1)]];
    let [tx, ty] = [(p1[0] - p0[0]) * kx, (p1[1] - p0[1]) * ky];
    const nt = Math.hypot(tx, ty) || 1;
    [tx, ty] = [tx / nt, ty / nt];
    let meilleur = null;
    let dMin = ecartMaxM;
    for (const [a, b] of segments) {
      const ax = (a[0] - lon) * kx;
      const ay = (a[1] - lat) * ky;
      const dx = (b[0] - a[0]) * kx;
      const dy = (b[1] - a[1]) * ky;
      // Tronçon entièrement d'un côté, loin : inutile de calculer.
      if ((ax > 200 && ax + dx > 200) || (ax < -200 && ax + dx < -200) || (ay > 200 && ay + dy > 200) || (ay < -200 && ay + dy < -200)) continue;
      const l2 = dx * dx + dy * dy;
      if (!l2) continue;
      // Direction : |cos| ≥ 0,7 (le sens de la voie OSM est quelconque).
      if (Math.abs((dx * tx + dy * ty) / Math.sqrt(l2)) < 0.7) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < dMin) {
        dMin = d;
        meilleur = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      }
    }
    return meilleur || [lon, lat];
  });
}

// Point le plus proche sur une ligne (à moins de `ecartMaxM`), ou null.
export function pointSurLigne(lat, lon, ligne, ecartMaxM) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  let meilleur = null;
  let dMin = ecartMaxM;
  for (let i = 1; i < ligne.length; i++) {
    const [a, b] = [ligne[i - 1], ligne[i]];
    const ax = (a[0] - lon) * kx;
    const ay = (a[1] - lat) * ky;
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < dMin) {
      dMin = d;
      meilleur = { lat: a[1] + t * (b[1] - a[1]), lon: a[0] + t * (b[0] - a[0]) };
    }
  }
  return meilleur;
}
