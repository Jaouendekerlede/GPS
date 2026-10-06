// Position pendant le guidage : qualité de chaque mesure GPS, recalage sur
// l'itinéraire, décision de « hors itinéraire » et estimation de la
// progression quand le signal manque. Calcul pur (ni écran ni réseau), pour
// être rejoué dans les tests sur des traces fabriquées.
//
// Conventions (celles du reste du guidage) : tracé en [lon, lat] ; distances
// et `offset` le long du tracé en mètres ; vitesses en m/s ; caps en degrés
// (0 = nord, sens horaire) ; horodatages en millisecondes.
//
// L'appli ne connaît que le tracé de l'itinéraire, pas les routes voisines :
// ce module ne peut donc pas choisir entre deux routes. Il choisit entre
// plusieurs passages de l'itinéraire lui-même (chaussée retour, lacets,
// échangeur en boucle, rond-point) et dit quand il n'est pas sûr.

import { capEntre } from "./nav-outils.js";

// ── Qualité d'une mesure ─────────────────────────────────────────────────────

// Au-delà, la mesure décrit un endroit que la voiture a déjà quitté.
export const AGE_MAX_MESURE_S = 10;
// 250 km/h : au-dessus, le déplacement entre deux mesures n'est pas réel.
const VITESSE_IMPOSSIBLE_MS = 70;
// Nombre de mesures écartées de suite au-delà duquel on cesse d'écarter.
const REJETS_DE_SUITE_MAX = 3;
// Précision annoncée par le téléphone (rayon à ~68 %), en mètres.
const PRECISION_BONNE_M = 20;
const PRECISION_FAIBLE_M = 60;

const metres = (a, b) => {
  const kx = 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
};

const ecartAngle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export function niveauPrecision(precision) {
  if (!Number.isFinite(precision) || precision <= 0) return "faible"; // inconnue : ni bonne ni exclue
  return precision <= PRECISION_BONNE_M ? "bon" : precision <= PRECISION_FAIBLE_M ? "faible" : "mauvais";
}

// Juge une mesure avant de s'en servir.
//   p, precedente : { lat, lon, precision, t } (precedente : dernière mesure acceptée)
//   suivi : { decalageHorloge, quarantaine } rendu par l'appel précédent
// Renvoie { valide, raison, niveau, age_s, suivi }.
//
// L'âge se mesure par rapport au plus petit écart déjà vu entre l'horloge du
// téléphone et l'horodatage des mesures : une horloge GPS décalée de façon
// constante ne fait pas rejeter toutes les mesures.
export function qualiteMesure(p, precedente, maintenant, suivi = {}) {
  const rejet = (raison, extra = {}) => ({ valide: false, raison, niveau: "mauvais", age_s: null, suivi: { ...suivi, ...extra, rejetsDeSuite: (suivi.rejetsDeSuite || 0) + 1 } });
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return rejet("coordonnées invalides");
  // Garde-fou : le filtre ne doit jamais bloquer le guidage. Après trois
  // mesures écartées de suite, c'est le repère (horloge, mesure précédente)
  // qui est en cause : on repart de la mesure reçue.
  if ((suivi.rejetsDeSuite || 0) >= REJETS_DE_SUITE_MAX) {
    return { valide: true, raison: "", niveau: niveauPrecision(p.precision), age_s: null, suivi: { decalageHorloge: Number.isFinite(p.t) ? maintenant - p.t : undefined, quarantaine: null, rejetsDeSuite: 0 } };
  }

  let decalageHorloge = suivi.decalageHorloge;
  let age = null;
  if (Number.isFinite(p.t)) {
    const retard = maintenant - p.t;
    decalageHorloge = decalageHorloge === undefined ? retard : Math.min(decalageHorloge, retard);
    age = Math.max(0, (retard - decalageHorloge) / 1000);
    if (age > AGE_MAX_MESURE_S) return rejet(`mesure vieille de ${Math.round(age)} s`, { decalageHorloge });
  }

  if (precedente && Number.isFinite(p.t) && Number.isFinite(precedente.t)) {
    if (p.t < precedente.t) return rejet("mesure arrivée dans le désordre", { decalageHorloge });
    const dt = (p.t - precedente.t) / 1000;
    // Après une longue absence, n'importe quel déplacement est possible.
    if (dt < 30) {
      const tolerance = (p.precision || PRECISION_BONNE_M) + (precedente.precision || PRECISION_BONNE_M);
      const impossible = (a) => metres(a, p) > tolerance + VITESSE_IMPOSSIBLE_MS * Math.max(0, (p.t - a.t) / 1000);
      // Deux mesures de suite au même endroit « impossible » : c'est la
      // précédente qui était fausse, on repart de celles-ci.
      const q = suivi.quarantaine;
      if (impossible(precedente) && !(q && !impossible(q))) {
        return rejet(`saut de ${Math.round(metres(precedente, p))} m en ${dt.toFixed(1)} s`, { decalageHorloge, quarantaine: { lat: p.lat, lon: p.lon, t: p.t } });
      }
    }
  }
  return { valide: true, raison: "", niveau: niveauPrecision(p.precision), age_s: age, suivi: { decalageHorloge, quarantaine: null, rejetsDeSuite: 0 } };
}

// ── Recalage sur l'itinéraire ────────────────────────────────────────────────

// Passages du tracé proches de la mesure : un candidat par portion continue
// du tracé située à moins de `rayon` mètres (son point le plus proche).
export function candidatsSurRoute(route, lat, lon, debut, fin, rayon) {
  const { coords, cum } = route;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  const candidats = [];
  let courant = null;
  for (let i = Math.max(0, debut); i < Math.min(coords.length - 1, fin); i++) {
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    const ax = (lonA - lon) * kx;
    const ay = (latA - lat) * ky;
    const dx = (lonB - lonA) * kx;
    const dy = (latB - latA) * ky;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d > rayon) {
      if (courant) candidats.push(courant);
      courant = null;
      continue;
    }
    if (!courant || d < courant.d) {
      courant = { d, i, offset: cum[i] + t * (cum[i + 1] - cum[i]), lat: latA + t * (latB - latA), lon: lonA + t * (lonB - lonA), cap: capEntre(latA, lonA, latB, lonB) };
    }
  }
  if (courant) candidats.push(courant);
  return candidats;
}

// Point du tracé le plus proche de la mesure entre deux indices (au moins un
// tronçon est toujours examiné).
function plusProche(route, lat, lon, debut, fin) {
  const n = route.coords.length - 1;
  const d = Math.max(0, Math.min(debut, n - 1));
  return candidatsSurRoute(route, lat, lon, d, Math.max(d + 1, fin), Infinity).reduce((a, b) => (b.d < a.d ? b : a));
}

// Un passage du tracé n'est retenu que s'il est à portée de la mesure : trois
// fois la précision annoncée, 60 m au moins (largeur d'une route à chaussées
// séparées et de ses bretelles).
const RAYON_MIN_M = 60;
const RAYON_MAX_M = 300;
// Saut le long du tracé au-delà duquel une seule mesure ne suffit pas.
const SAUT_A_CONFIRMER_M = 300;
// Deux passages sont « à égalité » sous cet écart de coût : on garde alors
// celui qui prolonge le trajet, et le résultat est marqué ambigu.
const ECART_AMBIGU = 2;

// Choisit le point de l'itinéraire correspondant à la mesure.
//   mesure : { lat, lon, precision, cap, vitesse, t } (cap et vitesse du GPS, NaN si absents)
//   precedent : résultat précédent ({ i, offset, t, vitesse, attente }) ou null
// Renvoie { i, offset, lat, lon, d, confiance, ambigu, attente, t, vitesse }.
//   d : distance de la mesure au point retenu (sert au « hors itinéraire »).
//   confiance : "haute" | "moyenne" | "basse".
//   attente : saut lointain vu une fois, à confirmer par la mesure suivante.
export function recaler(route, mesure, precedent = null) {
  const { coords } = route;
  const n = coords.length - 1;
  const sigma = Math.min(100, Math.max(8, Number.isFinite(mesure.precision) && mesure.precision > 0 ? mesure.precision : 20));
  const rayon = Math.min(RAYON_MAX_M, Math.max(RAYON_MIN_M, 3 * sigma));
  const vitesse = Number.isFinite(mesure.vitesse) ? mesure.vitesse : precedent?.vitesse || 0;
  const fin = (r) => ({ ...r, t: mesure.t, vitesse });

  let candidats = precedent ? candidatsSurRoute(route, mesure.lat, mesure.lon, precedent.i - 40, precedent.i + 500, rayon) : [];
  if (!candidats.length) candidats = candidatsSurRoute(route, mesure.lat, mesure.lon, 0, n, rayon);
  if (!candidats.length) {
    // Loin de tout l'itinéraire : le point le plus proche, pour mesurer l'écart.
    const loin = plusProche(route, mesure.lat, mesure.lon, 0, n);
    return fin({ ...loin, confiance: "basse", ambigu: false, attente: null });
  }

  const dt = precedent && Number.isFinite(mesure.t) && Number.isFinite(precedent.t) ? Math.min(60, Math.max(0, (mesure.t - precedent.t) / 1000)) : 0;
  const attendu = vitesse * dt;
  const tolerance = Math.max(25, sigma) + 0.5 * attendu;
  // Le cap du GPS n'a de sens qu'en roulant ; à l'arrêt il tourne au hasard.
  const capFiable = Number.isFinite(mesure.cap) && vitesse > 3;
  for (const c of candidats) {
    c.cout = (c.d / sigma) ** 2;
    if (capFiable) c.cout += Math.min(25, (ecartAngle(mesure.cap, c.cap) / 40) ** 2);
    c.ecartSuite = precedent ? c.offset - precedent.offset - attendu : 0;
    if (precedent) c.cout += Math.min(25, (c.ecartSuite / tolerance) ** 2);
  }
  candidats.sort((a, b) => a.cout - b.cout);
  let choisi = candidats[0];
  const rival = candidats.find((c) => Math.abs(c.offset - choisi.offset) > 80);
  const ambigu = !!rival && rival.cout - choisi.cout < ECART_AMBIGU;
  if (ambigu && precedent && Math.abs(rival.ecartSuite) < Math.abs(choisi.ecartSuite)) choisi = rival;

  // Saut lointain le long du tracé : attendre qu'une seconde mesure le
  // confirme. D'ici là on reste sur la suite logique du trajet, et la distance
  // rendue est celle de la mesure à ce point (le « hors itinéraire » la voit).
  let attente = null;
  if (precedent && Math.abs(choisi.ecartSuite) > Math.max(SAUT_A_CONFIRMER_M, 4 * tolerance)) {
    const confirme = precedent.attente && Math.abs(choisi.offset - precedent.attente.offset - attendu) < 3 * tolerance;
    if (!confirme) {
      const ici = plusProche(route, mesure.lat, mesure.lon, precedent.i - 2, precedent.i + 60);
      return fin({ ...ici, confiance: "basse", ambigu: true, attente: { offset: choisi.offset } });
    }
  }

  const confiance = ambigu || choisi.d > 3 * sigma ? "basse" : choisi.d <= 1.5 * sigma && niveauPrecision(mesure.precision) === "bon" ? "haute" : "moyenne";
  return fin({ i: choisi.i, offset: choisi.offset, lat: choisi.lat, lon: choisi.lon, d: choisi.d, cap: choisi.cap, confiance, ambigu, attente });
}

// ── Hors itinéraire ──────────────────────────────────────────────────────────

// Nombre de mesures consécutives hors du tracé, et durée, avant de recalculer.
// Signal bon : deux mesures (recalcul rapide après un changement de route
// voulu, demande du 2026-10-03). Signal dégradé : davantage, et pendant un
// certain temps, car une mesure imprécise s'écarte toute seule du tracé.
const CONFIRMATION_HORS_ROUTE = {
  bon: { mesures: 2, duree_s: 0 },
  faible: { mesures: 3, duree_s: 3 },
  mauvais: { mesures: 5, duree_s: 8 },
};
// Sous 70 % du seuil, la voiture est revenue sur le tracé ; entre 70 et
// 100 %, on ne conclut rien (le compte ne monte ni ne retombe).
const PART_RETOUR = 0.7;

// suivi : { compte, depuis } rendu par l'appel précédent.
// Renvoie { compte, depuis, seuil, confirme }.
export function evaluerHorsRoute(suivi, { d, precision, vitesse, t, niveau = niveauPrecision(precision) }) {
  const seuil = Math.max(40, (precision || 20) * 1.5);
  let { compte = 0, depuis = null } = suivi || {};
  if (!compte) depuis = null;
  // À l'arrêt ou au pas, la position flotte : on ne conclut rien.
  if (!((vitesse || 0) > 2) || d <= seuil * PART_RETOUR) return { compte: 0, depuis: null, seuil, confirme: false };
  if (d > seuil) {
    compte += 1;
    depuis ??= t;
  }
  const regle = CONFIRMATION_HORS_ROUTE[niveau] || CONFIRMATION_HORS_ROUTE.faible;
  return { compte, depuis, seuil, confirme: compte >= regle.mesures && depuis !== null && t - depuis >= regle.duree_s * 1000 };
}

// ── Sans signal : progression estimée ────────────────────────────────────────

// Sans mesure depuis ce délai, la position affichée n'est plus une mesure.
export const DELAI_SANS_MESURE_S = 3;
// Durée maximale d'estimation (choix validé avec l'utilisateur le 2026-10-04).
export const DUREE_ESTIMATION_MAX_S = 30;

// dernier : { offset, vitesse, t, d, precision } du dernier recalage accepté.
// Renvoie { etat, offset, incertitude_m } :
//   "suivi"  : mesure récente, rien à estimer ;
//   "estime" : la voiture est supposée continuer à la même vitesse sur le tracé ;
//   "fige"   : pas d'estimation raisonnable (à l'arrêt, ou hors du tracé) ;
//   "perdu"  : estimation trop ancienne pour être encore affichée comme position.
export function estimerProgression(dernier, maintenant, longueurTotale) {
  const dt = (maintenant - dernier.t) / 1000;
  const base = Number.isFinite(dernier.precision) ? dernier.precision : 20;
  if (dt < DELAI_SANS_MESURE_S) return { etat: "suivi", offset: dernier.offset, incertitude_m: base };
  const roulait = dernier.vitesse > 3 && dernier.d < 30;
  if (dt > DUREE_ESTIMATION_MAX_S) {
    const offset = roulait ? Math.min(longueurTotale, dernier.offset + dernier.vitesse * DUREE_ESTIMATION_MAX_S) : dernier.offset;
    return { etat: "perdu", offset, incertitude_m: base + 0.25 * dernier.vitesse * dt };
  }
  if (!roulait) return { etat: "fige", offset: dernier.offset, incertitude_m: base };
  // La vitesse a pu changer depuis : l'incertitude grandit avec la distance supposée.
  return { etat: "estime", offset: Math.min(longueurTotale, dernier.offset + dernier.vitesse * dt), incertitude_m: base + 0.25 * dernier.vitesse * dt };
}
