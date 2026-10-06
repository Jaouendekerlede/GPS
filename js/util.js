// Réponses réseau gardées un moment (même zone redemandée : comparatif des
// modes, alternatives, recalculs en route). Seuls les succès sont gardés, et
// chaque appel reçoit sa propre copie (les appelants complètent les objets).
const MEMOIRE = new Map();
const TAILLE_MAX_MEMOIRE = 150;

export async function avecMemoire(cle, dureeMs, calculer) {
  const entree = MEMOIRE.get(cle);
  if (entree && Date.now() - entree.t < dureeMs) return structuredClone(entree.valeur);
  const valeur = await calculer();
  if (valeur?.ok) {
    MEMOIRE.set(cle, { t: Date.now(), valeur: structuredClone(valeur) });
    if (MEMOIRE.size > TAILLE_MAX_MEMOIRE) MEMOIRE.delete(MEMOIRE.keys().next().value);
  }
  return valeur;
}

export function viderMemoire() {
  MEMOIRE.clear();
}

// Hauteur du soleil (en degrés) à cet instant et à cet endroit — formules
// astronomiques simplifiées, précises à quelques minutes près pour le
// lever et le coucher, ce qui suffit pour basculer la carte nuit / jour.
export function hauteurSoleil(date, lat, lon) {
  const rad = Math.PI / 180;
  const jours = date.getTime() / 86400000 - 10957.5; // depuis le 1er janvier 2000 à midi (UTC)
  const anomalie = (357.529 + 0.98560028 * jours) * rad;
  const longMoy = 280.459 + 0.98564736 * jours;
  const longEcl = (longMoy + 1.915 * Math.sin(anomalie) + 0.02 * Math.sin(2 * anomalie)) * rad;
  const obliquite = (23.439 - 0.00000036 * jours) * rad;
  const ascDroite = Math.atan2(Math.cos(obliquite) * Math.sin(longEcl), Math.cos(longEcl));
  const declinaison = Math.asin(Math.sin(obliquite) * Math.sin(longEcl));
  const tempsSideral = ((18.697374558 + 24.06570982441908 * jours) % 24) * 15;
  const angleHoraire = (tempsSideral + lon) * rad - ascDroite;
  return Math.asin(Math.sin(lat * rad) * Math.sin(declinaison) + Math.cos(lat * rad) * Math.cos(declinaison) * Math.cos(angleHoraire)) / rad;
}

// Nuit dès que le soleil est un peu sous l'horizon (fin du crépuscule clair).
export function estNuit(lat, lon, date = new Date()) {
  return hauteurSoleil(date, lat, lon) < -2;
}

export function escapeHtml(valeur) {
  return String(valeur ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function lienGoogleMaps(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
}

export function lienWaze(lat, lon) {
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}

export function lienAPied(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`;
}
