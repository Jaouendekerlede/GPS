// Zoom de la carte pendant la navigation, comme un GPS : large sur
// autoroute, rapproché en ville, et encore plus près là où il faut bien
// voir : ronds-points, grands carrefours, sorties d'autoroute (voie de
// décélération puis bretelle) et entrées (bretelle puis voie d'accélération).
// Module sans carte ni écran : testé à part.

// Zoom selon la vitesse : une courbe continue entre ces repères (plus on va
// vite, plus on voit loin), au lieu de paliers. À 130 km/h le champ est plus
// large qu'à 110.
export const REPERES_ZOOM = [
  { kmh: 20, zoom: 18 },
  { kmh: 50, zoom: 17 },
  { kmh: 80, zoom: 16 },
  { kmh: 110, zoom: 15 },
  { kmh: 130, zoom: 14.6 },
];
// Le zoom de vitesse ne bouge que si l'écart dépasse cette valeur : la carte
// ne respire pas à chaque petite variation de vitesse.
const ECART_MIN_ZOOM = 0.2;

export function zoomPourVitesse(kmh) {
  const r = REPERES_ZOOM;
  if (!(kmh > r[0].kmh)) return r[0].zoom;
  for (let i = 1; i < r.length; i++) {
    if (kmh <= r[i].kmh) return r[i - 1].zoom + ((kmh - r[i - 1].kmh) / (r[i].kmh - r[i - 1].kmh)) * (r[i].zoom - r[i - 1].zoom);
  }
  return r[r.length - 1].zoom;
}

// ── Vitesse retenue pour le zoom ─────────────────────────────────────────────
// La vitesse du GPS saute parfois (une mesure fausse) et tombe à zéro à
// chaque feu : prise telle quelle, elle ferait pomper la carte.
//   - variation bornée à ce qu'une voiture peut faire (accélération, freinage) ;
//   - moyenne glissante sur environ 3 secondes ;
//   - plancher lié à la limitation de la route : à l'arrêt à un feu, ou dans
//     un bouchon sur autoroute, la vue reste celle de la route.
const ACCELERATION_MAX_KMH_S = 15;
const FREINAGE_MAX_KMH_S = 30;
const LISSAGE_VITESSE_S = 3;
const PART_LIMITE_PLANCHER = 0.6;

// suivi : { kmh, bornee, t } rendu par l'appel précédent (ou null).
// Renvoie { kmh (lissée), bornee (dernière vitesse plausible), kmhZoom (avec plancher), t }.
export function vitessePourZoom(suivi, { kmh, t, limite = null }) {
  const plancher = limite ? limite * PART_LIMITE_PLANCHER : 0;
  if (!suivi || !Number.isFinite(suivi.kmh)) {
    const depart = Number.isFinite(kmh) && kmh >= 0 ? Math.min(kmh, 150) : 0;
    return { kmh: depart, bornee: depart, kmhZoom: Math.max(depart, plancher), t };
  }
  const dt = Math.min(5, Math.max(0, (t - suivi.t) / 1000));
  // Vitesse absente ou négative : la moyenne en cours tient lieu de mesure.
  const recue = Number.isFinite(kmh) && kmh >= 0 ? kmh : suivi.kmh;
  // La borne s'applique à la vitesse reçue (pas à la moyenne, qu'elle
  // étoufferait) : une vraie accélération passe, un pic isolé non.
  const bornee = Math.min(suivi.bornee + ACCELERATION_MAX_KMH_S * dt, Math.max(suivi.bornee - FREINAGE_MAX_KMH_S * dt, recue));
  const lissee = suivi.kmh + (bornee - suivi.kmh) * (1 - Math.exp(-dt / LISSAGE_VITESSE_S));
  return { kmh: lissee, bornee, kmhZoom: Math.max(lissee, plancher), t };
}

// Par type de manœuvre : zoom, début avant (secondes de trajet, bornées en
// mètres) et maintien après le point de la manœuvre (m).
export const REGLES_ZOOM = {
  // Tout le tour du rond-point reste zoomé (la manœuvre est à l'entrée).
  rondpoint: { zoom: 19, secondes: 14, avantMin: 200, avantMax: 450, apres: 160 },
  carrefour: { zoom: 18.5, secondes: 12, avantMin: 150, avantMax: 400, apres: 60 },
  // Voie de décélération (jusqu'à ~900 m avant à 130 km/h), puis bretelle.
  sortie: { zoom: 17, secondes: 25, avantMin: 400, avantMax: 900, apres: 500 },
  // Bretelle, puis voie d'accélération jusqu'à l'insertion.
  entree: { zoom: 17, secondes: 12, avantMin: 200, avantMax: 400, apres: 700 },
  simple: { zoom: 18, secondes: 12, avantMin: 150, avantMax: 350, apres: 30 },
};
const ZOOM_MAX = 19;

const SORTIES = /TAKE_EXIT|MOTORWAY_EXIT/;
// Voie rapide (voie express, rocade, autoroute) et écart de limitation qui
// signale une bretelle quand TomTom ne le dit pas (« prenez la sortie sur
// N136 » au sortir d'un rond-point, par exemple).
const VITESSE_RAPIDE = 90;
const ECART_BRETELLE = 20;
const ENTREES = /ENTER_(MOTORWAY|FREEWAY|HIGHWAY)|ENTRANCE_RAMP/;
const DELICATES = /U_?TURN|SHARP_/;
const ENCHAINEMENT_M = 200;
const VOIES_GRAND_CARREFOUR = 3;

// Limitations autour d'une manœuvre : juste avant (100 m), et la plus
// haute entre 200 et 700 m après (la bretelle mène à la voie rapide).
// limites : limitation (km/h ou null) de chaque point ; cum : distances (m).
export function vitessesAutour(offset, cum, limites) {
  const indice = (d) => {
    let bas = 0;
    let haut = cum.length - 1;
    while (bas < haut) {
      const milieu = (bas + haut + 1) >> 1;
      if (cum[milieu] <= d) bas = milieu;
      else haut = milieu - 1;
    }
    return bas;
  };
  const avant = limites[indice(Math.max(0, offset - 100))] || null;
  let apres = null;
  for (let i = indice(offset + 200); i < cum.length && cum[i] <= offset + 700; i++) if (limites[i] && limites[i] > (apres || 0)) apres = limites[i];
  return { avant, apres };
}

export function estEntreeVoieRapide(instr) {
  return !!(instr.vitesseApres >= VITESSE_RAPIDE && instr.vitesseAvant && instr.vitesseAvant <= instr.vitesseApres - ECART_BRETELLE);
}

function estSortieVoieRapide(instr) {
  return !!(instr.vitesseAvant >= VITESSE_RAPIDE && instr.vitesseApres && instr.vitesseApres <= instr.vitesseAvant - ECART_BRETELLE);
}

// instr : { offset, manoeuvre, jonction, vitesseAvant, vitesseApres } ;
// voies : sections « lanes » ({ offset, lanes }) ; suivante : instruction
// d'après (ou null).
export function typeManoeuvre(instr, voies = [], suivante = null) {
  const m = instr.manoeuvre || "";
  if (/ROUNDABOUT/.test(m) || instr.jonction === "ROUNDABOUT") return "rondpoint";
  if (SORTIES.test(m) || estSortieVoieRapide(instr)) return "sortie";
  if (ENTREES.test(m) || estEntreeVoieRapide(instr)) return "entree";
  // Bifurcation sur voie rapide (« tenez la droite vers A84 ») : comme une
  // sortie ; en ville, c'est un carrefour.
  if (instr.jonction === "BIFURCATION" && /KEEP_|BEAR_/.test(m)) return (instr.vitesseAvant || 0) >= VITESSE_RAPIDE ? "sortie" : "carrefour";
  const section = voies.find((v) => Math.abs(v.offset - instr.offset) < 40);
  if (section && section.lanes.length >= VOIES_GRAND_CARREFOUR) return "carrefour";
  if (DELICATES.test(m)) return "carrefour";
  if (suivante && suivante.offset - instr.offset < ENCHAINEMENT_M) return "carrefour";
  return "simple";
}

// Zoom voulu autour d'une manœuvre à `distance` m devant (négative : déjà
// passée), ou null si elle est trop loin.
export function zoomManoeuvre(type, distance, kmh) {
  const r = REGLES_ZOOM[type];
  const avant = Math.min(r.avantMax, Math.max(r.avantMin, (kmh / 3.6) * r.secondes));
  if (distance > avant || distance < -r.apres) return null;
  // Sur une bretelle, on se rapproche encore quand on ralentit.
  const bonus = type === "sortie" || type === "entree" ? (kmh < 50 ? 1 : kmh < 80 ? 0.5 : 0) : 0;
  return Math.min(ZOOM_MAX, r.zoom + bonus);
}

function zoomVitesse(kmh, zoomActuel, sortieDeManoeuvre) {
  const cible = Math.round(zoomPourVitesse(kmh) * 20) / 20;
  if (!Number.isFinite(zoomActuel) || sortieDeManoeuvre) return cible;
  return Math.abs(cible - zoomActuel) >= ECART_MIN_ZOOM ? cible : zoomActuel;
}

// ── Rond-point : zoom à sa taille ────────────────────────────────────────────
// L'entrée, la sortie à prendre et le début de la suite doivent tenir dans la
// partie libre de l'écran. `longueur` : mètres de tracé entre l'entrée et la
// sortie (connue par l'itinéraire). Sans elle : zoom au plus près, comme avant.
const ROND_POINT_ZOOM_MIN = 18;
const MARGE_ROND_POINT_M = 50; // l'approche et les premiers mètres de la suite
const PART_ECRAN_LIBRE = 0.45; // le reste est pris par la consigne et le bandeau
// Mètres par pixel au zoom 0, à la latitude de la France (tuiles de 256 px).
const METRES_PAR_PIXEL_ZOOM_0 = 106700;

export function zoomRondPoint(longueur, hauteurEcran = 800) {
  if (!(longueur > 0)) return REGLES_ZOOM.rondpoint.zoom;
  // Un arc de cercle s'étend moins que sa longueur : environ 70 %.
  const etendue = longueur * 0.7 + MARGE_ROND_POINT_M;
  const zoom = Math.log2((METRES_PAR_PIXEL_ZOOM_0 * hauteurEcran * PART_ECRAN_LIBRE) / etendue);
  return Math.min(REGLES_ZOOM.rondpoint.zoom, Math.max(ROND_POINT_ZOOM_MIN, Math.round(zoom * 10) / 10));
}

// instructions triées par offset ({ offset, manoeuvre, type, jonction,
// offsetSortie pour un rond-point }).
// kmh : vitesse (lissée) qui fixe l'anticipation des manœuvres ; kmhZoom :
// celle qui fixe le zoom hors manœuvre (avec son plancher), kmh par défaut.
// Renvoie { zoom, manoeuvre } : manoeuvre = type qui impose le zoom, ou null.
// renforce = false : même zoom modéré pour toutes les manœuvres (réglage).
export function zoomNavigation({ kmh, kmhZoom = kmh, offset, instructions, voies = [], zoomActuel, enManoeuvre = false, renforce = true, hauteurEcran = 800 }) {
  let meilleur = null;
  let type = null;
  const utiles = instructions.filter((i) => i.type !== "LOCATION_DEPARTURE" && !/WAYPOINT|ARRIVE/.test(i.manoeuvre || ""));
  for (let k = 0; k < utiles.length; k++) {
    const instr = utiles[k];
    const distance = instr.offset - offset;
    if (distance < -REGLES_ZOOM.entree.apres) continue;
    if (distance > REGLES_ZOOM.sortie.avantMax) break;
    const types = [renforce ? typeManoeuvre(instr, voies, utiles[k + 1] || null) : "simple"];
    // Rond-point dont la sortie est une bretelle : puis voie d'accélération.
    if (renforce && types[0] === "rondpoint" && estEntreeVoieRapide(instr)) types.push("entree");
    for (const t of types) {
      let z = zoomManoeuvre(t, distance, kmh);
      if (z !== null && t === "rondpoint" && instr.offsetSortie > instr.offset) z = zoomRondPoint(instr.offsetSortie - instr.offset, hauteurEcran);
      if (z !== null && (meilleur === null || z > meilleur)) {
        meilleur = z;
        type = t;
      }
    }
  }
  if (meilleur !== null) return { zoom: meilleur, manoeuvre: type };
  return { zoom: zoomVitesse(kmhZoom, zoomActuel, enManoeuvre), manoeuvre: null };
}
