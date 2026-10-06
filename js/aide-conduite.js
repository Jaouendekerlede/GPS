// Aide à la conduite : virages serrés repérés sur le tracé lui-même (pas de réseau),
// puis passages à niveau, stops et cédez-le-passage placés sur le tracé.
// Chaque alerte est { offset (m depuis le départ), type, texte }.
import { positionsSurTrace } from "./alertes-route.js";

// Virage serré : le cap change d'au moins ANGLE_VIRAGE_DEG sur FENETRE_M
// autour d'un point du tracé. Au-delà, une route normale ne tourne presque jamais.
const ANGLE_VIRAGE_DEG = 40;
const FENETRE_M = 40;
const PAS_M = 10;
const FUSION_M = 100;
// Les ronds-points tournent en continu : on ne les prend pas pour des virages.
const APRES_ROND_POINT_M = 150;

// Point [lon, lat] à `s` mètres du départ (interpolé entre les sommets).
function pointA(coords, cum, s) {
  const n = cum.length;
  if (s <= 0) return coords[0];
  if (s >= cum[n - 1]) return coords[n - 1];
  let a = 0, b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (cum[m] <= s) a = m;
    else b = m;
  }
  const l = cum[b] - cum[a] || 1;
  const f = (s - cum[a]) / l;
  return [coords[a][0] + (coords[b][0] - coords[a][0]) * f, coords[a][1] + (coords[b][1] - coords[a][1]) * f];
}

// Cap en degrés (0 = nord, 90 = est) du point p vers q, corrigé de la latitude.
function cap(p, q) {
  const dy = q[1] - p[1];
  const dx = (q[0] - p[0]) * Math.cos((p[1] * Math.PI) / 180);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

// Différence signée entre deux caps, dans [-180, 180] (positif = à droite).
function ecartCap(c1, c2) {
  return ((c2 - c1 + 540) % 360) - 180;
}

// Virages serrés : { offset, angle } (angle signé, positif = à droite).
export function virages(route) {
  const { coords, cum, total } = route;
  if (!coords || coords.length < 3 || !cum || !total) return [];
  const finsRondsPoints = (route.instructions || [])
    .filter((i) => i.jonction === "ROUNDABOUT" || /ROUNDABOUT/.test(i.manoeuvre || ""))
    .map((i) => i.offset);
  const brut = [];
  for (let s = FENETRE_M; s < total - FENETRE_M; s += PAS_M) {
    if (finsRondsPoints.some((o) => s >= o && s <= o + APRES_ROND_POINT_M)) continue;
    const a = pointA(coords, cum, s - FENETRE_M);
    const b = pointA(coords, cum, s);
    const c = pointA(coords, cum, s + FENETRE_M);
    if ((a[0] === b[0] && a[1] === b[1]) || (b[0] === c[0] && b[1] === c[1])) continue;
    const angle = ecartCap(cap(a, b), cap(b, c));
    if (Math.abs(angle) >= ANGLE_VIRAGE_DEG) brut.push({ offset: s, angle });
  }
  // Un même virage donne plusieurs points consécutifs : on garde le plus serré.
  const groupes = [];
  for (const p of brut) {
    const dernier = groupes[groupes.length - 1];
    if (dernier && p.offset - dernier.fin <= FUSION_M) {
      dernier.fin = p.offset;
      if (Math.abs(p.angle) > Math.abs(dernier.angle)) {
        dernier.offset = p.offset;
        dernier.angle = p.angle;
      }
    } else groupes.push({ offset: p.offset, angle: p.angle, fin: p.offset });
  }
  return groupes.map(({ offset, angle }) => ({ offset, angle }));
}

// Texte annoncé pour un virage serré.
export function texteVirage(angle) {
  return `Virage serré à ${angle > 0 ? "droite" : "gauche"}`;
}

// Alertes placées sur le tracé à partir des points trouvés (OpenStreetMap).
// `points` : { lat, lon, type } avec type « passage », « stop » ou « cedez ».
export function alertesSurTrace(points, route) {
  const retour = [];
  const types = { passage: "passage", stop: "stop", cedez: "cedez" };
  for (const type of Object.keys(types)) {
    const pts = points.filter((p) => p.type === type);
    if (!pts.length) continue;
    for (const offset of positionsSurTrace(pts, route.coords, route.cum, 25)) retour.push({ offset, type });
  }
  return retour;
}

