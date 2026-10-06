// Navigation GPS : suivi de la voiture sur l'itinéraire (via les bornes de
// recharge prévues), guidage vocal tourne-à-tourne (instructions TomTom en
// français), recalcul automatique hors itinéraire, mise à jour du trafic
// (travaux annoncés, bouton « route barrée »), vitesse et limitation, heure
// d'arrivée, batterie estimée en direct.
// Fonctionne tant que l'appli est ouverte à l'écran (limite des applis web).

import { getApiKeys } from "./config.js";
import { obtenirProfilVehicule, lireReglages, sauverReglages, ajouterAuJournal, enregistrerMesureConso, rectanglesZonesEvitees, garerVoiture, ajouterTrajetFait, ajouterTrace, consoParType, listerRadarsPersonnels, ajouterRadarPersonnel, retirerDernierRadarPersonnel, listerBornesPersonnelles, ajouterBornePersonnelle, retirerDerniereBornePersonnelle } from "./storage.js";
import { toast } from "./ui-commun.js";
import { enrichirBornes } from "./irve.js";
import { sauvegardeApresTrajet } from "./ui-drive.js";
import { meteoDesPoints, alerteMeteo } from "./meteo-route.js";
import { rechercherLeLongDu, CATEGORIES_TRAJET } from "./recherche-route.js";
import { reconnaissanceDispo, ecouter, interpreterCommande, interpreterOuiNon, interpreterChoix } from "./commandes-vocales.js";
import { svgBatterie, tableauBatterie, pctPrevuA } from "./graphique-batterie.js";
import { icone } from "./icones.js";
import { ouvrirSOS } from "./ui-sos.js";
import { rechercherParkings } from "./parkings.js";
import { calculerItineraireTomTom, appelsTomTomDuJour, QUOTA_TOMTOM_JOUR } from "./tomtom.js";
import { guidageHorsLigne, preparerGuidage, preparerHorsLigne } from "./hors-ligne.js";
import { zoomNavigation, vitessePourZoom } from "./zoom-nav.js";
import { qualiteMesure, recaler, evaluerHorsRoute, estimerProgression } from "./recalage.js";
import { creerSujet, lienSuivi, messagePosition, publier, INTERVALLE_PARTAGE_MS } from "./partage-position.js";
import { enregistrerReprise, oublierReprise, lireReprise } from "./reprise.js";
import { noter } from "./journal-erreurs.js";
import { heure, distanceAffichee, distanceParlee, messageCourt, minusculeInitiale, capEntre, incertitudeBatterie, fleche, svgFleche, construireRoute, traceRestante, FLECHES_VOIE, dessinVoies } from "./nav-outils.js";
// Réexportés pour les autres modules (ui.js, essais).
export { traceRestante, dessinVoies } from "./nav-outils.js";

import { radarsLeLongDu, feuxLeLongDe, routesAutourDe, airesLeLongDe, LABELS_TYPE_RADAR } from "./osm-route.js";
import { textesPanneau, classeNumero, estAutoroute, svgCarrefour } from "./panneau-nav.js";
import { zonesDeDanger, radarsSurTrace, positionsSurTrace, compterFeux, messageAvecFeu, partDifferente, projeterSurTrace, airesSurRoute } from "./alertes-route.js";
import { haversineKm, carresSurTrace, traceTraverseCarres, flecheManoeuvre } from "./geo.js";
import { formaterMinutes, calculerTempsCharge } from "./planner.js";
import { escapeHtml, lienAPied, estNuit } from "./util.js";
import { rechercherBornesZone } from "./ocm.js";
import { stationsOfficiellesZone, fusionnerBornes } from "./irve.js";
import * as carte2D from "./carte.js";
import * as carte3D from "./carte3d.js";

// Carte utilisée pendant la navigation : 3D si possible, sinon 2D. Les deux
// modules offrent les mêmes fonctions.
let vue = carte2D;

const $ = (id) => document.getElementById(id);
const DELAI_TRAFIC_MS = 5 * 60 * 1000;
const DELAI_MIN_RECALCUL_MS = 20 * 1000;
// 2× la vitesse réelle : assez rapide pour la démo sans réclamer trop de
// cartes par seconde aux serveurs (TomTom limite le débit).
const ACCELERATION_DEMO = 2;
const DELAI_BORNES_MS = 90 * 1000;
const RAYON_BORNES_KM = 12;
const DISTANCE_MIN_RAFRAICHIR_BORNES_KM = RAYON_BORNES_KM * 0.4;
// Route barrée : petits carrés posés sur la route juste devant la voiture
// (pas sur elle : TomTom refuse un départ dans une zone évitée).
const DISTANCES_ROUTE_BARREE_M = [40, 120, 200, 280];
const DEMI_COTE_ZONE_M = 25;
const MAX_ZONES_EVITEES = 10; // limite TomTom
// Pas d'autre chemin possible tout de suite (sens unique…) : nouvel essai
// tous les 80 m, 6 fois au plus.
const PAS_REESSAI_BARREE_M = 80;
const NB_REESSAIS_BARREE = 6;
const DISTANCE_ANNONCE_TRAVAUX_M = 1500;

let etat = null;

// Chrome refuse la synthèse vocale tant que l'utilisateur n'a pas touché la
// page (cas d'une reprise automatique après coupure) : un premier toucher,
// n'importe où, la débloque.
document.addEventListener(
  "pointerdown",
  () => {
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      // pas de synthèse vocale sur ce navigateur
    }
  },
  { once: true, capture: true },
);

// ── Utilitaires ─────────────────────────────────────────────────────────────

// ── Carrefour réel dans le panneau ──────────────────────────────────────────
// Ronds-points et carrefours en ville : les routes autour (OpenStreetMap),
// vues de dessus, l'arrivée en bas, et le chemin à suivre en blanc. Chargés
// un peu à l'avance (4 km), par petits paquets.
const INTERVALLE_CARREFOURS_MS = 15000;
const HORIZON_CARREFOURS_M = 4000;
const RAYON_CARREFOUR_M = 70;
const VITESSE_MAX_CARREFOUR = 90;
const MAX_CARREFOURS_PAR_REQUETE = 10;

function centreCarrefour(instr) {
  if (!instr.centreCarrefour) {
    const p = pointSurRoute(instr.offsetSortie ? (instr.offset + instr.offsetSortie) / 2 : instr.offset);
    instr.centreCarrefour = p;
    instr.cleCarrefour = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  }
  return instr.centreCarrefour;
}

function carrefourADessiner(instr) {
  return !instr.synthetique && instr.type !== "LOCATION_DEPARTURE" && !/WAYPOINT|ARRIVE/.test(instr.manoeuvre) && (instr.vitesseAvant || 50) <= VITESSE_MAX_CARREFOUR;
}

async function preparerCarrefours() {
  if (!etat?.route || !etat.prefs.vueCarrefour || etat.carrefoursEnCours || Date.now() - (etat.dernierCarrefours || 0) < INTERVALLE_CARREFOURS_MS) return;
  etat.dernierCarrefours = Date.now();
  const manquants = etat.route.instructions
    .filter((i) => i.offset > etat.offset && i.offset - etat.offset < HORIZON_CARREFOURS_M && carrefourADessiner(i))
    .filter((i) => {
      centreCarrefour(i);
      return !etat.carrefours.has(i.cleCarrefour) && !etat.carrefoursDemandes.has(i.cleCarrefour);
    })
    .slice(0, MAX_CARREFOURS_PAR_REQUETE);
  if (!manquants.length) return;
  for (const i of manquants) etat.carrefoursDemandes.add(i.cleCarrefour);
  etat.carrefoursEnCours = true;
  const r = await routesAutourDe(manquants.map((i) => i.centreCarrefour), RAYON_CARREFOUR_M);
  if (!etat) return;
  etat.carrefoursEnCours = false;
  if (!r.ok) {
    for (const i of manquants) etat.carrefoursDemandes.delete(i.cleCarrefour);
    return;
  }
  manquants.forEach((i, k) => etat.carrefours.set(i.cleCarrefour, r.routes[k]));
}

// Dessin du carrefour réel, ou "" (pas encore chargé : flèche simple).
function pictoCarrefour(instr) {
  if (!etat.prefs.vueCarrefour || !carrefourADessiner(instr)) return "";
  if (instr.svgCarrefour) return instr.svgCarrefour;
  const centre = centreCarrefour(instr);
  const routes = etat.carrefours.get(instr.cleCarrefour);
  if (!routes?.length) return "";
  const debut = instr.offset - 45;
  const fin = (instr.offsetSortie ?? instr.offset) + 45;
  const a = pointSurRoute(Math.max(0, debut));
  const b = pointSurRoute(Math.min(etat.route.total, fin));
  const chemin = [[a.lon, a.lat], ...etat.route.coords.filter((_, i) => etat.route.cum[i] > debut && etat.route.cum[i] < fin), [b.lon, b.lat]];
  const p1 = pointSurRoute(Math.max(0, instr.offset - 40));
  const p2 = pointSurRoute(Math.max(0, instr.offset - 5));
  instr.svgCarrefour = svgCarrefour(routes, chemin, [centre.lon, centre.lat], capEntre(p1.lat, p1.lon, p2.lat, p2.lon));
  return instr.svgCarrefour;
}

// Flèche blanche sur la carte, à l'approche du virage.
const DISTANCE_FLECHE_CARTE_M = 700;

function majFlecheCarte(instr, distance) {
  const cible = instr && distance < DISTANCE_FLECHE_CARTE_M && !etat.aLaBorne && !etat.arrive && !/WAYPOINT|ARRIVE/.test(instr.manoeuvre) ? instr : null;
  if (cible === etat.flecheCarte) return;
  etat.flecheCarte = cible;
  // Rond-point : la flèche fait le tour jusqu'à la bonne sortie.
  const apresM = cible?.offsetSortie ? cible.offsetSortie - cible.offset + 35 : 40;
  vue.dessinerFlecheManoeuvre(cible ? flecheManoeuvre(etat.route.coords, etat.route.cum, cible.offset, { apresM }) : null);
}

function parler(texte, prioritaire = false) {
  if (!etat?.voix || !texte || !("speechSynthesis" in window)) return;
  if (prioritaire) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texte);
  u.lang = "fr-FR";
  speechSynthesis.speak(u);
}

// ── Itinéraire de navigation ───────────────────────────────────────────────

async function calculerRouteNav(pos, cap, { sansSecours = false } = {}) {
  const cle = getApiKeys().tomtom;
  const o = etat.options || {};
  let traceImposee = null;
  // TomTom refuse tracé imposé + étapes : tant qu'il reste des bornes (qui
  // sont sur la route choisie), le guidage passe simplement par elles.
  // Route barrée : le tracé choisi passe justement par là, on le lâche.
  if (etat.plan.suivre_trace && !etat.arretsRestants.length && etat.plan.coords?.length && !etat.zonesEvitees.length) {
    const reste = traceRestante(etat.plan.coords, pos.lat, pos.lon, etat.indiceTrace);
    etat.indiceTrace = reste.indice;
    if (reste.coords.length >= 2) traceImposee = [[pos.lon, pos.lat], ...reste.coords];
  }
  const r = await calculerItineraireTomTom(cle, pos.lat, pos.lon, etat.destination.lat, etat.destination.lon, {
    etapes: etat.arretsRestants.map((a) => ({ lat: a.lat, lon: a.lon })),
    traceImposee,
    instructions: true,
    cap,
    zonesEvitees: etat.zonesEvitees,
    eviterPeages: o.eviter_peages,
    eviterAutoroutes: o.eviter_autoroutes,
    plusCourt: o.plus_court,
    eviterFerries: o.eviter_ferries,
    eviterZonesFaiblesEmissions: o.eviter_zones_faibles_emissions,
    eviterRoutesNonRevetues: o.eviter_routes_non_revetues,
  });
  if (!r.erreur) return construireRoute(r);
  if (sansSecours) return null;
  // Pas de réseau : guidage préparé à l'avance (« 📥 Hors ligne »), s'il
  // correspond à ce trajet et aux bornes restantes.
  const garde = guidageHorsLigne(etat.destination.lat, etat.destination.lon, etat.arretsRestants.length);
  if (garde) etat.guidageEnregistre = true;
  return garde ? construireRoute(garde) : null;
}

function installerRoute(route) {
  etat.route = route;
  etat.idx = 0;
  etat.offset = 0;
  // Les distances de l'animation se rapportaient à l'ancien tracé.
  if (etat.aff) etat.aff.offset = null;
  etat.anim = null;
  etat.annoncesBornes = new Set();
  // Le mode démo repart de la position actuelle sur le nouveau tracé.
  etat.demoOffset = null;
  etat.flecheCarte = undefined;
  route.zonesDanger = etat.radars ? zonesDeDanger(etat.radars, route.coords, route.cum, route.limites) : [];
  route.radarsSurTrace = etat.radars ? radarsSurTrace(etat.radars, route.coords, route.cum) : [];
  route.feuxSurTrace = etat.feuxConnus.size ? radarsSurTrace([...etat.feuxConnus.values()], route.coords, route.cum) : [];
  route.aires = etat.airesOsm ? airesSurRoute(etat.airesOsm, route.coords, route.cum, route.autoroutes || []) : [];
  appliquerFeux(route);
  vue.dessinerRouteNavigation(route.coords, etat.arretsRestants, etat.destination);
  vue.dessinerRadars(route.radarsSurTrace);
  vue.dessinerFeux(route.feuxSurTrace);
  if (etat.pos) {
    const m = projeter(etat.pos.lat, etat.pos.lon, null);
    etat.idx = m.i;
    etat.offset = m.offset;
    // Nouveau tracé : le recalage et le compteur de distance repartent d'ici.
    etat.recalage = null;
    etat.offsetMesure = m.offset;
    if (etat.dernierFixe) etat.dernierFixe = { ...etat.dernierFixe, offset: m.offset, d: m.d };
  }
  chercherFeux(route);
}

// Projette la position sur l'itinéraire (recherche autour du dernier point connu).
function projeter(lat, lon, depuis) {
  const { coords, cum } = etat.route;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  const chercher = (debut, fin) => {
    let meilleur = { d: Infinity, i: 0, offset: 0, lat, lon };
    for (let i = debut; i < fin; i++) {
      const [lonA, latA] = coords[i];
      const [lonB, latB] = coords[i + 1];
      const ax = (lonA - lon) * kx;
      const ay = (latA - lat) * ky;
      const dx = (lonB - lonA) * kx;
      const dy = (latB - latA) * ky;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < meilleur.d) meilleur = { d, i, offset: cum[i] + t * (cum[i + 1] - cum[i]), lat: latA + t * (latB - latA), lon: lonA + t * (lonB - lonA) };
    }
    return meilleur;
  };
  const n = coords.length - 1;
  if (depuis === null || depuis === undefined) return chercher(0, n);
  const local = chercher(Math.max(0, depuis - 40), Math.min(n, depuis + 500));
  return local.d > 150 ? chercher(0, n) : local;
}

// ── Temps, batterie ─────────────────────────────────────────────────────────

function secondesRestantesJusqua(offsetCible) {
  let s = 0;
  for (const t of etat.route.troncons) {
    if (t.fin <= etat.offset || t.debut >= offsetCible) continue;
    const longueur = Math.max(1, t.fin - t.debut);
    const debut = Math.max(t.debut, etat.offset);
    const fin = Math.min(t.fin, offsetCible);
    s += (t.duree * (fin - debut)) / longueur;
  }
  return s;
}

// La voiture indique pctReel : consommation réelle depuis le dernier repère
// de batterie (départ, borne ou correction précédente).
function mesurerConso(pctReel) {
  const km = (etat.odometre - etat.batterie.refOdometre) / 1000;
  const kwh = ((etat.batterie.refPct - pctReel) / 100) * etat.capacite;
  const ref = etat.batterie.refTypes || { ville: 0, route: 0, autoroute: 0 };
  const types = Object.fromEntries(Object.entries(etat.kmTypes).map(([t, v]) => [t, Math.round((v - (ref[t] || 0)) * 10) / 10]));
  if (kwh > 0) enregistrerMesureConso(km, kwh, types);
}

// Énergie consommée depuis le dernier repère : conso apprise pour le type
// de route roulé (ville, route, autoroute) quand elle existe, sinon la
// moyenne du plan.
// Batterie prévue à l'arrivée à cette borne d'après le plan de recharge,
// corrigée de l'écart constaté maintenant entre la batterie réelle et la
// batterie prévue au même endroit. null si le plan ne s'applique plus
// (navigation reprise, borne remplacée).
function pctBorneSelonPlan(arret) {
  if (etat.plan._reprise || !Number.isFinite(arret.pct_arrivee_borne) || !etat.plan.arrets?.includes(arret)) return null;
  return arret.pct_arrivee_borne + (batterieEstimee() - pctPrevuA(pointsPrevus(), etat.odometre / 1000));
}

function effacerAlerteBatterie() {
  if (!etat.alerteBatterieAffichee) return;
  etat.alerteBatterieAffichee = false;
  if ($("ev-nav-alerte").textContent.startsWith("⚠️ Batterie trop juste")) afficherAlerte(null);
}

function batterieEstimee() {
  const b = etat.batterie;
  if (b.refEnergie !== undefined) return b.refPct - ((etat.energieCumulee - b.refEnergie) / etat.capacite) * 100;
  return b.refPct - ((etat.odometre - b.refOdometre) / 1000) * (etat.consoKwhKm / etat.capacite) * 100;
}

// ── Écran ───────────────────────────────────────────────────────────────────

// Au-delà, trop tôt pour être utile ; sur autoroute, 800 m laissent le
// temps de changer de file.
const DISTANCE_MAX_VOIES_M = 800;

// Bandeau des voies (comme Sygic) : chaque voie avec ses flèches, celle(s)
// à prendre en évidence. Seulement pour la prochaine manœuvre, quand
// TomTom connaît les voies à cet endroit.
function afficherVoies(instr) {
  const zone = $("ev-nav-voies");
  const fenetre = $("ev-nav-vue-voies");
  const reste = instr ? instr.offset - etat.offset : Infinity;
  const section = instr && !etat.aLaBorne && !etat.arrive && reste < DISTANCE_MAX_VOIES_M ? etat.route.voies.find((v) => Math.abs(v.offset - instr.offset) < 40) : null;
  // Fenêtre en perspective quand il faut choisir sa file (pas si toutes
  // les voies conviennent) ; sinon le petit bandeau.
  const enFenetre = !!section && etat.prefs.fenetreVoies && section.lanes.some((l) => !l.follow);
  fenetre.classList.toggle("hidden", !enFenetre);
  if (enFenetre) {
    const voiesSuivies = section.lanes.filter((voie) => voie.follow).length;
    $("ev-nav-vue-voies-instruction").textContent = voiesSuivies === 1 ? "Suivez la voie bleue" : "Suivez les voies bleues";
    fenetre.setAttribute("aria-label", voiesSuivies === 1 ? "Suivez la voie bleue" : "Suivez les voies bleues");
    $("ev-nav-vue-voies-distance").textContent = distanceAffichee(reste);
    if (fenetre.dataset.cle !== String(section.offset)) {
      fenetre.dataset.cle = String(section.offset);
      $("ev-nav-vue-voies-dessin").innerHTML = dessinVoies(section.lanes);
    }
  } else fenetre.dataset.cle = "";
  if (!section || enFenetre) {
    zone.classList.add("hidden");
    zone.dataset.cle = "";
    return;
  }
  const cle = String(section.offset);
  if (zone.dataset.cle === cle) return;
  zone.dataset.cle = cle;
  zone.innerHTML = section.lanes
    .map((l) => {
      const fleches = (l.directions || ["STRAIGHT"]).map((d) => `<span class="${d === l.follow ? "suivre" : ""}">${FLECHES_VOIE[d] || "↑"}</span>`).join("");
      return `<div class="ev-nav-voie${l.follow ? " active" : ""}">${fleches}</div>`;
    })
    .join("");
  zone.classList.remove("hidden");
}

// niveau "alerte" (par défaut, rouge) : demande une attention/décision.
// niveau "info" (bleu, discret) : à signaler sans inquiéter -- rien à
// faire, pas de conséquence sur la conduite (ex : bascule automatique et
// sans incident vers l'autre fournisseur de carte). Distinction ajoutée
// suite au constat que la bascule OpenFreeMap s'affichait aussi
// alarmante qu'une vraie alerte météo/batterie, alors qu'elle ne demande
// aucune action et n'affecte pas la navigation (2026-09-27).
function afficherAlerte(texte, bouton, niveau = "alerte") {
  const el = $("ev-nav-alerte");
  if (!texte) {
    el.classList.add("hidden");
    return;
  }
  noter("alerte", texte);
  el.innerHTML = `<span>${escapeHtml(texte)}</span>${bouton ? `<button type="button" class="ev-btn" id="ev-nav-alerte-btn">${escapeHtml(bouton.libelle)}</button>` : ""}`;
  el.classList.remove("hidden");
  el.classList.toggle("ev-nav-alerte-info", niveau === "info");
  if (bouton) $("ev-nav-alerte-btn").addEventListener("click", bouton.action);
}

function majEcran() {
  const route = etat.route;
  const pos = etat.pos;

  // Prochaine manœuvre
  const prochaines = route.instructions.filter((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE");
  const instr = prochaines[0];
  const ensuite = $("ev-nav-ensuite");
  ensuite.classList.add("hidden");
  const rue = $("ev-nav-rue");
  const flecheBandeau = (contenu) => {
    if (etat.flecheBandeau === contenu) return;
    etat.flecheBandeau = contenu;
    $("ev-nav-fleche").innerHTML = contenu;
  };
  rue.classList.add("hidden");
  const panneau = $("ev-nav-panneau");
  panneau.classList.add("hidden");
  // Bleu sur autoroute et vers une autoroute, comme les panneaux.
  // Autoroute = route « A… », ou section rapide limitée à 130 (TomTom classe
  // aussi les voies express en « motorway », or leurs panneaux sont verts).
  const passee = route.instructions.filter((i) => i.offset <= etat.offset && !i.synthetique).pop();
  const surAutoroute = (passee?.numeros || []).some(estAutoroute) || ((route.autoroutes || []).some(([a, b]) => etat.offset >= a && etat.offset <= b) && (route.limites[etat.idx] || 0) >= 130);
  const bleu = !!instr && (surAutoroute || (instr.numeros || []).some(estAutoroute));
  $("ev-nav-manoeuvre").classList.toggle("autoroute", bleu);
  if (etat.arrive) {
    flecheBandeau(svgFleche({ manoeuvre: "ARRIVE" }));
    $("ev-nav-distance").textContent = "Arrivé";
    $("ev-nav-instruction").textContent = etat.destination.nom || "Destination";
  } else if (etat.aLaBorne) {
    flecheBandeau(`<span class="ev-nav-fleche-emoji">${etat.aLaBorne.pause ? "📍" : "🔌"}</span>`);
    $("ev-nav-distance").textContent = etat.aLaBorne.pause ? "Étape" : "Recharge";
    $("ev-nav-instruction").textContent = etat.aLaBorne.nom_borne;
  } else if (instr) {
    const d = instr.offset - etat.offset;
    flecheBandeau(pictoCarrefour(instr) || svgFleche(instr));
    $("ev-nav-distance").textContent = distanceAffichee(d);
    // Longue ligne droite : bandeau replié en une ligne (« ↑ 34 km · A83 »).
    etat.bandeauReplie = etat.prefs.epure && (etat.bandeauReplie ? d > REPLI_FIN_M : d > REPLI_DEBUT_M);
    const t = textesPanneau(instr);
    rue.textContent = t.rue;
    rue.classList.toggle("hidden", !t.rue);
    // Comme sur les panneaux : n° de sortie, n° de route, direction.
    const html = [
      t.sortie ? `<span class="ev-num ev-num-sortie">Sortie ${escapeHtml(t.sortie)}</span>` : "",
      ...t.numeros.map((n) => `<span class="ev-num ev-num-${classeNumero(n)}">${escapeHtml(n)}</span>`),
      // t.direction est maintenant le nom de la route (la direction/ville est
      // déjà affichée en gros) : "via" plutôt qu'une flèche qui suggérerait une destination.
      t.direction ? `<span class="ev-nav-direction">via ${escapeHtml(t.direction)}</span>` : "",
    ].join("");
    if (etat.panneauAffiche !== html) {
      etat.panneauAffiche = html;
      panneau.innerHTML = html;
    }
    panneau.classList.toggle("hidden", !html);
    $("ev-nav-instruction").textContent = t.action;
    const suivante = prochaines[1];
    if (suivante && suivante.offset - instr.offset < 400) {
      ensuite.innerHTML = `Puis <span class="ev-nav-ensuite-fleche">${svgFleche(suivante)}</span> ${escapeHtml(messageCourt(suivante.message))}`;
      ensuite.classList.remove("hidden");
    }
  } else {
    flecheBandeau(svgFleche({ manoeuvre: "STRAIGHT" }));
    $("ev-nav-distance").textContent = distanceAffichee(route.total - etat.offset);
    $("ev-nav-instruction").textContent = "Continuez jusqu'à la destination";
  }
  if (!instr || etat.arrive || etat.aLaBorne) etat.bandeauReplie = false;
  $("ev-nav-manoeuvre").classList.toggle("replie", !!etat.bandeauReplie);
  if (etat.bandeauReplie) ensuite.classList.add("hidden");
  // Autoroute en ligne droite : l'essentiel seulement (un toucher rend tout).
  const kmhEpure = (pos.vitesse || 0) * 3.6;
  document.body.classList.toggle("ev-nav-epure", !!etat.bandeauReplie && kmhEpure > VITESSE_EPURE_KMH && Date.now() > (etat.epureSuspenduJusqua || 0) && $("ev-nav-alerte").classList.contains("hidden"));
  if (!$("ev-nav-feuille").classList.contains("hidden")) majFeuilleDeRoute();
  majNotificationGuidage(instr);
  majNuitDouce();
  majFlecheCarte(instr, instr ? instr.offset - etat.offset : Infinity);
  majZoneDanger();
  verifierApprocheRadar();
  majFrise();
  majAires();
  document.body.classList.toggle("ev-borne-bas", !$("ev-nav-borne").classList.contains("hidden"));
  // Affichage compact : une seule info sous le bandeau (alerte, sinon voies,
  // sinon prochaine borne) pour garder la carte visible.
  if (document.body.classList.contains("ev-bandeau-compact")) {
    const alerte = !$("ev-nav-alerte").classList.contains("hidden");
    const voies = !$("ev-nav-vue-voies").classList.contains("hidden");
    if (alerte) $("ev-nav-vue-voies").classList.add("hidden");
  }

  afficherVoies(instr);

  // Vitesse et limitation
  const kmh = Math.round((pos.vitesse || 0) * 3.6);
  const limite = route.limites[etat.idx];
  $("ev-nav-vitesse").innerHTML = `<strong>${kmh}</strong><span>km/h</span>`;
  $("ev-nav-vitesse").classList.toggle("exces", !!limite && kmh > limite + 3);
  $("ev-nav-limite").textContent = limite || "";
  $("ev-nav-limite").classList.toggle("hidden", !limite);
  surveillerVitesse(kmh, limite);
  if (document.body.classList.contains("ev-hud")) majHud(kmh, limite);

  // Prochaine borne
  const arret = etat.arretsRestants[0];
  const pctMaintenant = batterieEstimee();
  if (arret && !etat.aLaBorne) {
    const offsetBorne = route.troncons[0].fin;
    const reste = Math.max(0, offsetBorne - etat.offset);
    const pctBorne = pctMaintenant - (reste / 1000) * (etat.consoKwhKm / etat.capacite) * 100;
    const heureBorne = Date.now() + secondesRestantesJusqua(offsetBorne) * 1000;
    $("ev-nav-borne").innerHTML = `${arret.pause ? "📍" : "🔋"} <strong>${escapeHtml(arret.nom_borne)}</strong> · ${distanceAffichee(reste)} · ${heure(heureBorne)} · ~${Math.round(pctBorne)} %${incertitudeBatterie(etat.batterie.refPct - pctBorne) >= 3 ? ` (±${incertitudeBatterie(etat.batterie.refPct - pctBorne)})` : ""}`;
    $("ev-nav-borne").classList.remove("hidden");
    // Alerte seulement si les deux estimations (linéaire, et plan corrigé de
    // l'écart réel) sont sous le seuil, plusieurs fois de suite ; effacée dès
    // que la situation redevient normale.
    const seuil = etat.margePct - 3;
    const pctPlan = pctBorneSelonPlan(arret);
    const juste = !arret.pause && pctBorne < seuil && (pctPlan === null || pctPlan < seuil);
    etat.batterieJusteCompteur = juste ? (etat.batterieJusteCompteur || 0) + 1 : 0;
    if (etat.batterieJusteCompteur >= 3 && !etat.alerteBatterieAffichee) {
      etat.alerteBatterieAffichee = true;
      noter("batterie", `alerte : linéaire ${Math.round(pctBorne)} %, plan ${pctPlan === null ? "?" : Math.round(pctPlan)} %, reste ${Math.round(reste / 1000)} km, seuil ${seuil} %`);
      afficherAlerte("⚠️ Batterie trop juste pour atteindre la borne prévue.", { libelle: "🔄 Recalculer", action: replanifier });
      parler("Attention, la batterie risque d'être trop juste pour atteindre la prochaine borne.");
    } else if (!juste) effacerAlerteBatterie();
  } else {
    $("ev-nav-borne").classList.add("hidden");
    effacerAlerteBatterie();
  }

  // Bas de l'écran : heure d'arrivée, temps et km restants, batterie
  const chargesRestantes = etat.arretsRestants.reduce((s, a) => s + (a.temps_charge_min || 0) * 60, 0);
  const secondes = secondesRestantesJusqua(route.total) + chargesRestantes;
  $("ev-nav-eta").textContent = heure(Date.now() + secondes * 1000);
  $("ev-nav-reste-temps").textContent = formaterMinutes(secondes / 60);
  $("ev-nav-reste-km").textContent = `${Math.round((route.total - etat.offset) / 1000)}`;
  const pct = Math.max(0, Math.round(pctMaintenant));
  $("ev-nav-batt").textContent = `${pct} %`;
  $("ev-nav-batt").className = pct >= 50 ? "good" : pct >= 20 ? "warn" : "bad";
}

// Recalcule à la fois les zones de danger (fusionnées, pour le bandeau
// légal) et les positions individuelles des radars sur ce tracé (pour les
// marqueurs sur la carte et les avertissements gradués, voir
// verifierApprocheRadar) à partir de etat.radars.
function recalculerRadars() {
  if (!etat?.route) return;
  etat.route.zonesDanger = zonesDeDanger(etat.radars, etat.route.coords, etat.route.cum, etat.route.limites);
  etat.route.radarsSurTrace = radarsSurTrace(etat.radars, etat.route.coords, etat.route.cum);
  vue.dessinerRadars(etat.route.radarsSurTrace);
}

// Feux tricolores connus (etat.feuxConnus) replacés sur le tracé courant,
// pour les marqueurs sur la carte -- même logique que recalculerRadars().
function recalculerFeux() {
  if (!etat?.route) return;
  etat.route.feuxSurTrace = radarsSurTrace([...etat.feuxConnus.values()], etat.route.coords, etat.route.cum);
  vue.dessinerFeux(etat.route.feuxSurTrace);
}

// Radars fixes du trajet, une fois (et après un nouveau plan) : on n'en
// montre que les « zones de danger » permises par la loi.
async function chercherRadars() {
  if (!etat?.prefs.dangers || !etat.route) return;
  const r = await radarsLeLongDu(etat.route.coords);
  if (!etat?.route || !r.ok) return;
  // Radars officiels (OSM) + ceux signalés soi-même (voir signalerRadarIci) --
  // ces derniers passent par la même conversion en « zone de danger » que
  // les officiels juste en dessous, jamais un point précis.
  etat.radars = [...r.radars, ...listerRadarsPersonnels()];
  recalculerRadars();
}

// « Signaler un radar ici » : ajoute la position actuelle à la liste
// personnelle (voir storage.js), prévient tout de suite sur ce trajet (si
// la route est déjà tracée) et sur tous les suivants. Demande explicite de
// l'utilisateur le 2026-09-27.
export function signalerRadarIci() {
  if (!etat?.pos) {
    toast("Position GPS indisponible pour l'instant.");
    return;
  }
  const { deja, radars } = ajouterRadarPersonnel(etat.pos.lat, etat.pos.lon);
  if (deja) {
    parler("Un radar est déjà signalé tout près d'ici.", true);
    toast("📍 Déjà signalé à proximité.");
    return;
  }
  etat.radars = [...(etat.radars || []), radars[0]];
  recalculerRadars();
  parler("Radar enregistré. Vous serez prévenu la prochaine fois.", true);
  toast("📍 Radar enregistré pour vos prochains trajets.");
}

// Annule le dernier radar signalé par erreur (voir signalerRadarIci et
// retirerDernierRadarPersonnel dans storage.js). Demande explicite de
// l'utilisateur le 2026-09-27.
export function oublierDernierRadarSignale() {
  const { retire } = retirerDernierRadarPersonnel();
  if (!retire) {
    toast("Aucun radar signalé à oublier.");
    return;
  }
  if (etat) {
    etat.radars = (etat.radars || []).filter((r) => r.id !== retire.id);
    recalculerRadars();
  }
  parler("Radar oublié.", true);
  toast("🗑️ Dernier radar signalé oublié.");
}

// Aires et bornes sur autoroute / voie express : chargées une fois (et
// après un nouveau plan), pour les seuls tronçons rapides du trajet.
// Par fenêtres de 200 km devant, complétées en roulant (50 km avant la fin).
const FENETRE_AIRES_M = 200000;
const RELANCE_AIRES_M = 50000;

async function chercherAires() {
  if (!etat?.prefs.aires || !etat.route?.autoroutes?.length || etat.airesEnCours) return;
  const route = etat.route;
  const [debut, fin] = [etat.offset, etat.offset + FENETRE_AIRES_M];
  const morceaux = route.autoroutes
    .filter(([a, b]) => b > debut && a < fin)
    .map(([a, b]) => route.coords.filter((_, i) => route.cum[i] >= Math.max(a, debut) && route.cum[i] <= Math.min(b, fin)));
  etat.airesEnCours = true;
  etat.airesOdometreFin = etat.odometre + Math.min(fin, route.total) - debut;
  const r = await airesLeLongDe(morceaux);
  if (!etat) return;
  etat.airesEnCours = false;
  if (!etat.route || !r.ok) {
    etat.airesOdometreFin = etat.odometre + 20000; // nouvel essai un peu plus loin
    return;
  }
  const connus = new Set((etat.airesOsm || []).map((l) => `${l.lat},${l.lon}`));
  etat.airesOsm = [...(etat.airesOsm || []), ...r.lieux.filter((l) => !connus.has(`${l.lat},${l.lon}`))];
  etat.route.aires = airesSurRoute(etat.airesOsm, etat.route.coords, etat.route.cum, etat.route.autoroutes || []);
}

// Colonne en bas à gauche (comme Sygic) : prochaine borne sur la route,
// puis les deux aires suivantes, avec la distance.
const HORIZON_AIRES_M = 150000;

function majAires() {
  const el = $("ev-nav-aires");
  const route = etat.route;
  const surRapide = (route.autoroutes || []).some(([a, b]) => etat.offset >= a - 200 && etat.offset <= b);
  const devant = surRapide && etat.prefs.aires && !etat.aLaBorne ? (route.aires || []).filter((x) => x.offset > etat.offset && x.offset - etat.offset < HORIZON_AIRES_M) : [];
  const borne = devant.find((x) => x.type === "recharge");
  const aires = devant.filter((x) => x.type !== "recharge").slice(0, document.body.classList.contains("ev-bandeau-compact") ? 1 : 2);
  const liste = [borne, ...aires].filter(Boolean).sort((a, b) => a.offset - b.offset);
  const html = liste
    .map((x) => {
      const d = distanceAffichee(x.offset - etat.offset);
      const icone = x.type === "recharge" ? "⚡" : x.type === "service" ? "🍴" : "🌳";
      const plus = x.type === "recharge" && x.puissance_kw ? `<small>${Math.round(x.puissance_kw)} kW</small>` : x.recharge ? "<small>⚡</small>" : "";
      const titre = `${x.type === "recharge" ? "Borne" : x.type === "service" ? "Aire de service" : "Aire de repos"}${x.nom ? ` ${x.nom}` : ""}`;
      return `<div class="ev-aire ev-aire-${x.type}" title="${escapeHtml(titre)}"><span>${icone}</span><strong>${d}</strong>${plus}</div>`;
    })
    .join("");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
  el.classList.toggle("hidden", !html);
}

function majZoneDanger() {
  const zone = etat.prefs.dangers && !etat.aLaBorne ? (etat.route.zonesDanger || []).find((z) => etat.offset >= z.debut && etat.offset <= z.fin) : null;
  const el = $("ev-nav-danger");
  el.classList.toggle("hidden", !zone);
  if (!zone) {
    etat.dansZoneDanger = false;
    return;
  }
  el.textContent = `⚠️ Zone de danger${zone.limite ? ` · ${zone.limite} km/h` : ""}`;
  if (!etat.dansZoneDanger) {
    etat.dansZoneDanger = true;
    parler(`Zone de danger${zone.limite ? `, limitée à ${zone.limite}` : ""}.`);
    if (etat.prefs.bip) bip();
  }
}

// Avertissements gradués façon Radarbot/Coyote, en plus du bandeau « zone
// de danger » légal ci-dessus (qui, lui, commence parfois plusieurs
// centaines de mètres avant sur autoroute) : 200 m, 100 m et 50 m avant
// chaque radar (fixe officiel OU signalé soi-même), chacun une seule fois.
// Demande explicite de l'utilisateur le 2026-09-27.
const SEUILS_APPROCHE_RADAR_M = [200, 100, 50];

function verifierApprocheRadar() {
  if (!etat.prefs.dangers || etat.aLaBorne) return;
  for (const r of etat.route.radarsSurTrace || []) {
    const d = r.offset - etat.offset;
    if (d < 0 || d > 200) continue;
    for (const seuil of SEUILS_APPROCHE_RADAR_M) {
      if (d > seuil) continue;
      const cle = `${Math.round(r.offset)}|${seuil}`;
      if (etat.radarsAnnonces.has(cle)) continue;
      etat.radarsAnnonces.add(cle);
      const nom = LABELS_TYPE_RADAR[r.type] || "radar";
      parler(`${nom.charAt(0).toUpperCase()}${nom.slice(1)} dans ${seuil} mètres.`, true);
      if (etat.prefs.bip) bip();
    }
  }
}

// Manœuvres en ville (≤ 70 km/h, hors ronds-points et bornes), avec la
// position de la manœuvre précédente : « au feu », « au deuxième feu »…
const VITESSE_MAX_FEUX = 70;
const DISTANCE_RECHERCHE_FEUX_M = 400;

function manoeuvresAFeux(route) {
  const liste = [];
  let depuis = 0;
  for (const instr of route.instructions) {
    const utile = instr.type !== "LOCATION_DEPARTURE" && !/WAYPOINT|ARRIVE|ROUNDABOUT/.test(instr.manoeuvre) && instr.jonction !== "ROUNDABOUT" && (instr.vitesseAvant || 50) <= VITESSE_MAX_FEUX;
    if (utile) liste.push({ instr, depuis });
    depuis = instr.offset;
  }
  return liste;
}

function appliquerFeux(route) {
  if (!etat.prefs.feux || !etat.feuxConnus.size) return;
  const positions = positionsSurTrace([...etat.feuxConnus.values()], route.coords, route.cum, 20);
  for (const { instr, depuis } of manoeuvresAFeux(route)) {
    instr.messageOrigine ??= instr.message;
    instr.message = messageAvecFeu(instr.messageOrigine, compterFeux(positions, instr.offset, depuis));
  }
}

// Feux autour des manœuvres pas encore vues (les recalculs reprennent
// surtout les mêmes : pas de nouvelle requête pour elles).
async function chercherFeux(route) {
  if (!etat?.prefs.feux) return;
  const a = manoeuvresAFeux(route).filter(({ instr }) => {
    const p = pointSurRoute(instr.offset);
    instr.cleFeux = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    return !etat.manoeuvresFeux.has(instr.cleFeux);
  });
  if (!a.length) return;
  for (const { instr } of a) etat.manoeuvresFeux.add(instr.cleFeux);
  const morceaux = a.map(({ instr, depuis }) => {
    const debut = Math.max(depuis, instr.offset - DISTANCE_RECHERCHE_FEUX_M);
    const fin = instr.offset + 10;
    const pts = route.coords.filter((_, i) => route.cum[i] > debut && route.cum[i] < fin);
    const [a1, a2] = [pointSurRoute(debut), pointSurRoute(Math.min(fin, route.total))];
    return [[a1.lon, a1.lat], ...pts, [a2.lon, a2.lat]];
  });
  const r = await feuxLeLongDe(morceaux);
  if (!etat) return;
  if (!r.ok) {
    for (const { instr } of a) etat.manoeuvresFeux.delete(instr.cleFeux);
    return;
  }
  for (const f of r.feux) etat.feuxConnus.set(`${f.lat},${f.lon}`, f);
  if (etat.route === route) {
    appliquerFeux(route);
    recalculerFeux();
    majEcran();
  }
}

// ── Annonces vocales ────────────────────────────────────────────────────────

const NOMBRES = ["", "la", "les deux", "les trois", "les quatre"];

// « Prenez les deux voies de droite » : d'après les voies à suivre pour
// cette manœuvre. Rien si toutes les voies conviennent.
function phraseVoies(instr) {
  if (!etat.prefs.voixVoies) return "";
  const section = etat.route.voies.find((v) => Math.abs(v.offset - instr.offset) < 40);
  if (!section) return "";
  const suivies = section.lanes.map((l, i) => (l.follow ? i : -1)).filter((i) => i >= 0);
  const n = section.lanes.length;
  const k = suivies.length;
  if (!k || k === n) return "";
  const pluriel = k > 1 ? "voies" : "voie";
  const debut = `Prenez ${NOMBRES[k] || k}`;
  if (suivies[0] === 0 && suivies[k - 1] === k - 1) return `${debut} ${pluriel} de gauche.`;
  if (suivies[k - 1] === n - 1 && suivies[0] === n - k) return `${debut} ${pluriel} de droite.`;
  if (k === 1 && n === 3 && suivies[0] === 1) return "Prenez la voie du milieu.";
  return k === 1 ? `Prenez la ${suivies[0] + 1}${suivies[0] === 0 ? "re" : "e"} voie en partant de la gauche.` : "";
}

// ── Mains sur le volant : questions à la voix ───────────────────────────────
// L'appli pose la question, attend la fin de sa phrase, puis écoute la
// réponse. Pas de réponse claire → rien ne change (choix le plus sûr).

function direPuisEcouter(texte) {
  return new Promise((resolve) => {
    if (!etat?.voix || !etat.prefs.reponsesVoix || !reconnaissanceDispo() || !("speechSynthesis" in window)) {
      parler(texte);
      return resolve(null);
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(texte);
    u.lang = "fr-FR";
    u.onend = async () => {
      if (!etat) return resolve(null);
      $("ev-nav-ecoute").classList.remove("hidden");
      const r = await ecouter();
      $("ev-nav-ecoute").classList.add("hidden");
      noter("voix", `réponse entendue : ${r || "(rien)"}`);
      resolve(r);
    };
    u.onerror = () => resolve(null);
    speechSynthesis.speak(u);
  });
}

const ORDRES = ["Premier", "Deuxième", "Troisième"];

// Lit jusqu'à 3 possibilités et écoute « le premier », « la deuxième »…
async function choisirALaVoix(intro, elements, decrire) {
  const n = Math.min(3, elements.length);
  if (!n) return -1;
  const liste = elements.slice(0, n).map((x, i) => `${ORDRES[i]} : ${decrire(x)}`).join(". ");
  const r = await direPuisEcouter(`${intro} ${liste}. Lequel ? Dites premier${n > 1 ? ", deuxième" : ""}${n > 2 ? ", troisième" : ""}, ou non.`);
  return interpreterChoix(r, n);
}

// Double bip court (sans fichier son) : dépassement de la limitation.
let contexteAudio = null;
function bip() {
  if (!etat?.voix) return;
  try {
    contexteAudio ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = contexteAudio.currentTime;
    for (const debut of [0, 0.22]) {
      const osc = contexteAudio.createOscillator();
      const gain = contexteAudio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t + debut);
      gain.gain.exponentialRampToValueAtTime(0.25, t + debut + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + debut + 0.16);
      osc.connect(gain).connect(contexteAudio.destination);
      osc.start(t + debut);
      osc.stop(t + debut + 0.18);
    }
  } catch {
    // Son indisponible : l'alerte visuelle (compteur rouge) suffit.
  }
}

const TOLERANCE_VITESSE_KMH = 5;
const DUREE_AVANT_BIP_MS = 2000;

// Un seul bip par dépassement, après 2 s au-dessus (pas pour un pic de GPS).
function surveillerVitesse(kmh, limite) {
  const exces = !!limite && kmh > limite + TOLERANCE_VITESSE_KMH;
  if (!exces) {
    etat.excesDepuis = null;
    etat.bipFait = false;
    return;
  }
  etat.excesDepuis ??= Date.now();
  if (!etat.bipFait && Date.now() - etat.excesDepuis >= DUREE_AVANT_BIP_MS) {
    etat.bipFait = true;
    if (etat.prefs.bip) bip();
  }
}

function annonces() {
  if (etat.aLaBorne) return;
  const v = Math.max(etat.pos.vitesse || 0, 5);
  const instr = etat.route.instructions.find((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE");
  if (instr && !/WAYPOINT/.test(instr.manoeuvre)) {
    const d = instr.offset - etat.offset;
    const loin = Math.min(2000, Math.max(600, v * 60));
    const proche = Math.min(500, Math.max(120, v * 12));
    // Position imprécise ou estimée : l'annonce finale part plus tôt,
    // de la valeur de l'incertitude (60 m au plus), plutôt que trop tard.
    const maintenant = Math.min(60, Math.max(20, v * 3)) + Math.min(60, etat.incertitudeM || 0);
    const precedente = etat.route.instructions.filter((i) => i.offset < instr.offset).pop();
    const ecart = precedente ? instr.offset - precedente.offset : Infinity;
    if (d <= maintenant && !instr.annonces.has(3)) {
      instr.annonces.add(1).add(2).add(3);
      parler(instr.message, true);
    } else if (d <= proche && d > maintenant && !instr.annonces.has(2)) {
      instr.annonces.add(1).add(2);
      if (etat.prefs.vibration) navigator.vibrate?.([120, 80, 120]);
      parler(`Dans ${distanceParlee(d)}, ${minusculeInitiale(instr.message)}. ${phraseVoies(instr)}`, true);
    } else if (d <= loin && d > proche && ecart > loin + 200 && !instr.annonces.has(1)) {
      instr.annonces.add(1);
      parler(`Dans ${distanceParlee(d)}, ${minusculeInitiale(instr.message)}. ${phraseVoies(instr)}`);
    }
  }

  // Travaux (clé = lieu : pas de nouvelle annonce après un recalcul).
  const travaux = etat.route.travaux.find((t) => t.offset > etat.offset && t.offset - etat.offset <= DISTANCE_ANNONCE_TRAVAUX_M);
  if (travaux && !etat.annoncesTravaux.has(travaux.cle)) {
    etat.annoncesTravaux.add(travaux.cle);
    const d = travaux.offset - etat.offset;
    const retard = travaux.retard_min >= 1 ? `, environ ${travaux.retard_min} minute${travaux.retard_min > 1 ? "s" : ""} de retard` : "";
    const [voix, icone] = travaux.fermeture ? ["Attention, route signalée fermée", "⛔ Route signalée fermée"] : travaux.bouchon ? ["Ralentissement", "🚗 Ralentissement"] : ["Travaux", "🚧 Travaux"];
    if (etat.prefs.voixTravaux) parler(`${voix} dans ${distanceParlee(d)}${travaux.fermeture ? "" : retard}.`);
    const texte = `${icone} dans ${distanceAffichee(d)}${!travaux.fermeture && travaux.retard_min >= 1 ? ` (+${travaux.retard_min} min)` : ""}`;
    if ($("ev-nav-alerte").classList.contains("hidden")) {
      afficherAlerte(texte, travaux.fermeture ? { libelle: "🚧 Éviter", action: routeBarree } : null);
      setTimeout(() => {
        if (etat && $("ev-nav-alerte").textContent.startsWith(texte)) afficherAlerte(null);
      }, 15000);
    }
  }

  const arret = etat.arretsRestants[0];
  if (arret && !arret.pause) rappelsAvantBorne(arret);
  if (arret) {
    const reste = etat.route.troncons[0].fin - etat.offset;
    for (const seuil of [20000, 2000]) {
      if (reste <= seuil && reste > seuil / 4 && !etat.annoncesBornes.has(seuil)) {
        etat.annoncesBornes.add(seuil);
        if (etat.prefs.voixBornes || arret.pause) parler(`${arret.pause ? "Étape" : "Borne de recharge"} ${arret.nom_borne} dans ${distanceParlee(reste)}.`);
      }
    }
  }
}

// ── Arrivées ────────────────────────────────────────────────────────────────

// ── Avant la borne : préchauffage de la batterie, état de la borne ────────────

const AVANCE_PRECHAUFFAGE_S = 22 * 60;
const DISTANCE_VERIF_BORNE_M = 20000;

function rappelsAvantBorne(arret) {
  const cle = `${arret.lat},${arret.lon}`;
  const secondes = secondesRestantesJusqua(etat.route.troncons[0].fin);
  // Recharge rapide dans ~20 min : batterie chaude = charge plus rapide.
  if (etat.prefs.prechauffage && (arret.puissance_kw || 0) >= 50 && secondes <= AVANCE_PRECHAUFFAGE_S && secondes > 5 * 60 && !etat.rappelsFaits.has(`chauffe|${cle}`)) {
    etat.rappelsFaits.add(`chauffe|${cle}`);
    parler("Recharge rapide dans une vingtaine de minutes : pensez à préchauffer la batterie.");
    const texte = "🌡️ Préchauffez la batterie : borne rapide dans ~20 min";
    if ($("ev-nav-alerte").classList.contains("hidden")) {
      afficherAlerte(texte);
      setTimeout(() => etat && $("ev-nav-alerte").textContent === texte && afficherAlerte(null), 15000);
    }
  }
  if (etat.route.troncons[0].fin - etat.offset <= DISTANCE_VERIF_BORNE_M && !etat.rappelsFaits.has(`etat|${cle}`)) {
    etat.rappelsFaits.add(`etat|${cle}`);
    verifierEtatBorne(arret);
  }
}

// Dernier état connu de la borne (base nationale) : hors service ou
// entièrement occupée → alerte avec « autre borne ».
async function verifierEtatBorne(arret) {
  const copie = { nom: arret.nom_borne, lat: arret.lat, lon: arret.lon, operateur: arret.operateur, officiel: arret.officiel };
  try {
    await enrichirBornes([copie], { attendreEtats: true });
  } catch {
    return;
  }
  const e = copie.etat_dynamique;
  if (!etat || !e || etat.arretsRestants[0] !== arret) return;
  const horsService = e.tous_hors_service || (e.total && e.hors_service >= e.total);
  const occupee = !horsService && e.total && e.libres === 0 && e.occupes > 0;
  if (!horsService && !occupee) return;
  afficherAlerte(`⚠️ ${arret.nom_borne} : ${horsService ? "signalée hors service" : "toutes les places occupées (dernier état connu)"}`, { libelle: "🔌 Autre borne", action: afficherSecours });
  const alt = arret.alternatives?.[0];
  const debut = horsService ? "Attention, la borne prévue est signalée hors service." : "La borne prévue semble occupée.";
  if (!alt) return parler(debut);
  const r = await direPuisEcouter(`${debut} Voulez-vous aller plutôt à ${alt.nom} ? Dites oui ou non.`);
  if (etat && interpreterOuiNon(r) === true) remplacerBorne(0);
}

// ── Minuteur de recharge (fin estimée, notification) ─────────────────────────

function majMinuteurRecharge() {
  const m = etat?.minuteurRecharge;
  const el = $("ev-nav-minuteur");
  if (!m || !el) return;
  const reste = Math.round((m.fin - Date.now()) / 60000);
  el.textContent = reste > 0 ? `⏱️ Fin estimée à ${heure(m.fin)} (dans ${formaterMinutes(reste)})` : "✅ Recharge terminée (estimation) : vous pouvez repartir";
  if (reste <= 0 && !m.prevenu) {
    m.prevenu = true;
    parler("La recharge devrait être terminée. Vous pouvez repartir.", true);
    navigator.serviceWorker?.getRegistration?.().then((reg) => reg?.showNotification("🔋 Recharge terminée (estimation)", { body: `${m.nom} : vous pouvez repartir.`, tag: "recharge", icon: "./icons/icon-192.png" }));
  }
}

function demarrerMinuteurRecharge(arret, pctArrivee, pctDepart) {
  clearInterval(etat.minuteurRechargeId);
  const kwh = Math.max(0, ((pctDepart - pctArrivee) / 100) * etat.capacite);
  const minutes = calculerTempsCharge(kwh, arret.puissance_kw || 50, { pctDebut: pctArrivee, profil: obtenirProfilVehicule() });
  etat.minuteurRecharge = { fin: (etat.minuteurRecharge?.debut || Date.now()) + minutes * 60000, debut: etat.minuteurRecharge?.debut || Date.now(), nom: arret.nom_borne };
  majMinuteurRecharge();
  etat.minuteurRechargeId = setInterval(majMinuteurRecharge, 30000);
}

function arreterMinuteurRecharge() {
  clearInterval(etat?.minuteurRechargeId);
  if (etat) etat.minuteurRecharge = null;
}

// Étape ajoutée en route (café, boulangerie…) : pas de recharge.
function arriveePause(arret) {
  etat.aLaBorne = arret;
  parler(`Vous êtes arrivé à votre étape, ${arret.nom_borne}.`, true);
  const carte = $("ev-nav-etape-borne");
  carte.innerHTML = `<div class="ev-nav-carte-titre">📍 ${escapeHtml(arret.nom_borne)}</div><div class="ev-nav-carte-sous">${escapeHtml(arret.adresse || "")}</div><button type="button" id="ev-nav-reprendre-btn" class="ev-btn-principal">▶ Reprendre la route</button>`;
  carte.classList.remove("hidden");
  $("ev-nav-reprendre-btn").addEventListener("click", () => {
    etat.arretsRestants.shift();
    etat.route.troncons.shift();
    etat.aLaBorne = null;
    etat.annoncesBornes = new Set();
    carte.classList.add("hidden");
    parler("C'est reparti.", true);
    majEcran();
  });
  majEcran();
}

function arriveeBorne(arret) {
  if (arret.pause) return arriveePause(arret);
  etat.aLaBorne = arret;
  etat.debutBorne = Date.now();
  parler(
    `Vous êtes arrivé à la borne ${arret.nom_borne}. Rechargez jusqu'à ${arret.pct_depart_borne} pour cent, environ ${arret.temps_charge_min} minutes.`,
    true,
  );
  const carteBorne = $("ev-nav-etape-borne");
  carteBorne.innerHTML = `
    <div class="ev-nav-carte-titre">🔌 ${escapeHtml(arret.nom_borne)}</div>
    <div>Recharge conseillée : <strong>${arret.pct_arrivee_borne} % → ${arret.pct_depart_borne} %</strong> · environ <strong>${arret.temps_charge_min} min</strong> à ${arret.puissance_kw} kW</div>
    <div class="ev-nav-carte-sous">${escapeHtml(arret.adresse || "")}</div>
    <label class="ev-champ">Batterie affichée par la voiture à l'arrivée : <span id="ev-nav-arrivee-val" class="ev-valeur">${Math.round(batterieEstimee())}</span> %
      <input type="range" min="0" max="100" value="${Math.round(batterieEstimee())}" id="ev-nav-arrivee-input" class="ev-curseur">
    </label>
    <label class="ev-champ">Batterie en repartant : <span id="ev-nav-reprise-val" class="ev-valeur">${arret.pct_depart_borne}</span> %
      <input type="range" min="5" max="100" value="${arret.pct_depart_borne}" id="ev-nav-reprise-input" class="ev-curseur">
    </label>
    <div id="ev-nav-minuteur" class="ev-nav-carte-sous"></div>
    <button type="button" id="ev-nav-reprendre-btn" class="ev-btn-principal">▶ Reprendre la route</button>
    ${arret.alternatives?.length ? `<button type="button" id="ev-nav-indispo-btn" class="ev-btn">❌ Borne occupée ou en panne : une autre</button>` : ""}`;
  carteBorne.classList.remove("hidden");
  $("ev-nav-indispo-btn")?.addEventListener("click", afficherSecours);
  // Minuteur : suit les curseurs (batterie à l'arrivée, niveau voulu).
  const relancerMinuteur = () => demarrerMinuteurRecharge(arret, Number($("ev-nav-arrivee-input").value), Number($("ev-nav-reprise-input").value));
  $("ev-nav-reprise-input").addEventListener("input", (e) => {
    $("ev-nav-reprise-val").textContent = e.target.value;
    relancerMinuteur();
  });
  $("ev-nav-arrivee-input").addEventListener("input", (e) => {
    $("ev-nav-arrivee-val").textContent = e.target.value;
    relancerMinuteur();
  });
  etat.minuteurRecharge = null;
  relancerMinuteur();
  const pctEstime = batterieEstimee();
  $("ev-nav-reprendre-btn").addEventListener("click", () => {
    const pctRepart = Number($("ev-nav-reprise-input").value);
    const pctArrivee = Number($("ev-nav-arrivee-input").value);
    // Batterie réelle indiquée : mesure de la consommation depuis le dernier repère.
    if (!etat.demo && Math.abs(pctArrivee - pctEstime) >= 1) mesurerConso(pctArrivee);
    // Journal des recharges (pas en démo) : kWh réellement ajoutés d'après
    // la batterie à l'arrivée et celle indiquée au départ.
    const kwh = Math.round(((pctRepart - pctArrivee) * etat.capacite) / 10) / 10;
    etat.tempsRechargeMs += Date.now() - (etat.debutBorne || Date.now());
    if (!etat.demo && kwh >= 0.5) {
      etat.coutRecharges += Math.round(kwh * (arret.prix_kwh_eur ?? 0.45) * 100) / 100;
      // Durée réelle et calculée (sans l'apprentissage) : apprend le temps de charge.
      const dureeReelle = Math.round((Date.now() - (etat.debutBorne || Date.now())) / 60000);
      const dureePrevue = Math.round(calculerTempsCharge(kwh, arret.puissance_kw || 50, { pctDebut: pctArrivee, profil: { ...obtenirProfilVehicule(), facteur_charge_appris: 1 } }));
      ajouterAuJournal({ lieu: arret.nom_borne, kwh, cout_eur: Math.round(kwh * (arret.prix_kwh_eur ?? 0.45) * 100) / 100, prix_estime: arret.prix_est_estimation !== false, source: "navigation", duree_reelle_min: dureeReelle, duree_prevue_min: dureePrevue, puissance_kw: arret.puissance_kw });
    }
    arreterMinuteurRecharge();
    etat.batterie = { refPct: pctRepart, refOdometre: etat.odometre };
    noterBatterie(pctArrivee);
    noterBatterie(pctRepart);
    etat.arretsRestants.shift();
    etat.route.troncons.shift();
    etat.aLaBorne = null;
    etat.alerteBatterieAffichee = false;
    etat.annoncesBornes = new Set();
    carteBorne.classList.add("hidden");
    parler("C'est reparti.", true);
    majEcran();
    // Dernière borne quittée : on reprend le tracé choisi sans attendre.
    if (etat.plan.suivre_trace && !etat.arretsRestants.length) recalculer("reprise");
  });
  majEcran();
}

// Bilan d'arrivée : réel comparé au plan.
function bilanArrivee() {
  const minutes = Math.round((Date.now() - etat.debut) / 60000);
  const prevu = etat.plan.duree_totale_min;
  const batt = Math.round(batterieEstimee());
  const recharge = Math.round(etat.tempsRechargeMs / 60000);
  const cases = [
    [`${Math.round(etat.odometre / 1000)} km`, "parcourus"],
    [formaterMinutes(minutes), prevu ? `prévu ${formaterMinutes(prevu)}` : "de route"],
    [`${batt} %`, etat.plan.pct_batterie_arrivee != null ? `batterie (prévu ${Math.round(etat.plan.pct_batterie_arrivee)} %)` : "batterie"],
  ];
  if (recharge > 0) cases.push([`${recharge} min`, `de recharge${etat.coutRecharges ? ` · ${etat.coutRecharges.toFixed(2).replace(".", ",")} €` : ""}`]);
  return `<div class="ev-bilan">${cases.map(([v, l]) => `<div><strong>${v}</strong><span>${l}</span></div>`).join("")}</div>`;
}

function arriveeDestination() {
  if (etat.arrive) return;
  etat.arrive = true;
  envoyerPositionPartagee("arrive");
  parler(`Vous êtes arrivé à destination. Batterie estimée : ${Math.round(batterieEstimee())} pour cent.`, true);
  // Où la voiture est garée (onglet Carte › 🚗 Ma voiture).
  const finale = etat.destinationFinale;
  if (!etat.demo && etat.pos) {
    garerVoiture(etat.pos.lat, etat.pos.lon, (finale || etat.destination).nom || "");
    document.dispatchEvent(new Event("ev-voiture-garee"));
  }
  const carteFin = $("ev-nav-etape-borne");
  carteFin.innerHTML = `
    <div class="ev-nav-carte-titre">🏁 Vous êtes arrivé</div>
    <div>${escapeHtml(etat.destination.nom || "")}</div>
    <div>Batterie estimée : <strong>${Math.round(batterieEstimee())} %</strong></div>
    ${bilanArrivee()}
    ${etat.demo ? "" : `<div class="ev-nav-carte-sous">🚗 Position de la voiture enregistrée (Carte › 🚗 Ma voiture)</div>`}
    ${finale ? `<a class="ev-btn" href="${escapeHtml(lienAPied(finale.lat, finale.lon))}" target="_blank" rel="noopener">🚶 Finir à pied jusqu'à ${escapeHtml(finale.nom || "la destination")}</a>` : ""}
    <button type="button" id="ev-nav-terminer-btn" class="ev-btn-principal">Terminer</button>`;
  carteFin.classList.remove("hidden");
  $("ev-nav-terminer-btn").addEventListener("click", () => {
    // Appui de l'utilisateur : Google autorise alors la sauvegarde Drive.
    if (!etat.demo) sauvegardeApresTrajet();
    arreterNavigation();
  });
}

// ── Bornes affichées pendant la conduite ────────────────────────────────────

async function rafraichirBornesProches() {
  if (!etat?.pos) return;
  const pos = etat.pos;
  const maintenant = Date.now();
  if (
    etat.posBornes &&
    maintenant - etat.dernierFetchBornes < DELAI_BORNES_MS &&
    haversineKm(pos.lat, pos.lon, etat.posBornes.lat, etat.posBornes.lon) < DISTANCE_MIN_RAFRAICHIR_BORNES_KM
  ) {
    return;
  }
  etat.dernierFetchBornes = maintenant;
  etat.posBornes = { lat: pos.lat, lon: pos.lon };
  const jeton = ++etat.jetonBornes;
  const { openChargeMap } = getApiKeys();
  const [res, officielles] = await Promise.all([
    openChargeMap ? rechercherBornesZone(openChargeMap, pos.lat, pos.lon, { rayonKm: RAYON_BORNES_KM, maxResultats: 60 }) : Promise.resolve({ ok: false, bornes: [] }),
    stationsOfficiellesZone(pos.lat, pos.lon, RAYON_BORNES_KM, { maxLignes: 300 }),
  ]);
  if (!etat || jeton !== etat.jetonBornes) return;
  etat.bornesReseauAffichees = fusionnerBornes(res.ok ? res.bornes : [], officielles.bornes);
  etat.bornesPersoAffichees = listerBornesPersonnelles().filter((b) => haversineKm(pos.lat, pos.lon, b.lat, b.lon) <= RAYON_BORNES_KM);
  redessinerBornes();
  vue.montrerBornes(true);
}

function redessinerBornes() {
  if (!etat) return;
  vue.afficherBornes([...(etat.bornesReseauAffichees || []), ...(etat.bornesPersoAffichees || [])], () => {});
}

// « Signaler une borne ici » : ajoute la position actuelle à la liste
// personnelle (voir storage.js) avec puissance et connecteur choisis par
// l'utilisateur, l'affiche tout de suite sans attendre le prochain
// rafraîchissement réseau. Demande explicite de l'utilisateur le 2026-09-27
// (bornes vues sur le terrain mais absentes d'Open Charge Map / IRVE).
export function signalerBorneIci({ puissance_kw = 0, connecteur = "", note = "" } = {}) {
  if (!etat?.pos) {
    toast("Position GPS indisponible pour l'instant.");
    return { ok: false };
  }
  const { deja, bornes } = ajouterBornePersonnelle(etat.pos.lat, etat.pos.lon, { puissance_kw, connecteur, note });
  if (deja) {
    parler("Une borne est déjà signalée tout près d'ici.", true);
    toast("🔌 Déjà signalée à proximité.");
    return { ok: false };
  }
  etat.bornesPersoAffichees = [...(etat.bornesPersoAffichees || []), bornes[0]];
  redessinerBornes();
  vue.montrerBornes(true);
  parler("Borne enregistrée. Elle apparaîtra sur vos prochains trajets.", true);
  toast("🔌 Borne enregistrée.");
  return { ok: true };
}

// Annule la dernière borne signalée par erreur (voir signalerBorneIci et
// retirerDerniereBornePersonnelle dans storage.js).
export function oublierDerniereBorneSignalee() {
  const { retire } = retirerDerniereBornePersonnelle();
  if (!retire) {
    toast("Aucune borne signalée à oublier.");
    return;
  }
  if (etat) {
    etat.bornesPersoAffichees = (etat.bornesPersoAffichees || []).filter((b) => b.id !== retire.id);
    redessinerBornes();
  }
  parler("Borne oubliée.", true);
  toast("🗑️ Dernière borne signalée oubliée.");
}

// ── Recalculs ───────────────────────────────────────────────────────────────

async function recalculer(raison) {
  if (!etat || etat.recalculEnCours || etat.demo) return;
  // Quota TomTom presque atteint : plus de mise à jour du trafic toutes les
  // 5 min (les recalculs hors itinéraire restent possibles).
  if (raison === "trafic" && appelsTomTomDuJour() > QUOTA_TOMTOM_JOUR * 0.9) return;
  // Sans réseau, aucun nouveau chemin ne peut être calculé : on le dit une
  // fois, au lieu d'annoncer un recalcul toutes les 20 secondes pour remettre
  // le même itinéraire.
  const sansNouveauChemin = () => {
    if (!etat.horsRouteSansReseau) {
      etat.horsRouteSansReseau = true;
      noter("nav", "hors itinéraire sans réseau : itinéraire d'origine gardé");
      afficherAlerte("📡 Sans réseau : impossible de calculer un nouveau chemin. L'itinéraire d'origine est gardé : rejoins-le dès que possible.", null, "info");
      parler("Pas de réseau pour recalculer. Rejoignez l'itinéraire d'origine.", true);
    }
  };
  if (raison === "hors_route" && !navigator.onLine) {
    etat.dernierRecalcul = Date.now();
    return sansNouveauChemin();
  }
  etat.recalculEnCours = true;
  etat.dernierRecalcul = Date.now();
  noter("nav", `recalcul (${raison})`);
  if (raison === "hors_route" && !etat.horsRouteSansReseau) {
    afficherAlerte("🔄 Recalcul de l'itinéraire…");
    parler("Recalcul de l'itinéraire.", true);
  }
  const ancienneDuree = secondesRestantesJusqua(etat.route.total);
  etat.guidageEnregistre = false;
  const route = await calculerRouteNav(etat.pos, etat.pos.cap);
  if (!etat) return;
  etat.recalculEnCours = false;
  etat.dernierTrafic = Date.now();
  // Le téléphone se croit connecté mais rien ne répond : c'est le guidage
  // enregistré qui est revenu, pas un nouveau chemin.
  if (route && etat.guidageEnregistre) {
    if (raison === "hors_route") sansNouveauChemin();
    return;
  }
  etat.horsRouteSansReseau = false;
  if (!route) {
    if (raison === "hors_route") afficherAlerte("⚠️ Recalcul impossible pour le moment (réseau ?). Nouvel essai sous peu.");
    return;
  }
  // Mise à jour du trafic : même chemin → nouvelle heure d'arrivée ; autre
  // chemin → proposé s'il fait gagner du temps (façon Waze), sinon ignoré.
  if (raison === "trafic" && partDifferente(route.coords, etat.route.coords, etat.route.cum) > PART_ROUTE_DIFFERENTE) {
    const gain = ancienneDuree - route.troncons.reduce((t, x) => t + x.duree, 0);
    if (gain >= GAIN_MIN_PROPOSITION_S) proposerRoute(route, gain);
    return;
  }
  installerRoute(route);
  etat.horsRoute = 0;
  afficherAlerte(null);
  majEcran();
}

const PART_ROUTE_DIFFERENTE = 0.1;
const GAIN_MIN_PROPOSITION_S = 180;
const DUREE_PROPOSITION_MS = 25000;

function proposerRoute(route, gain) {
  const min = Math.round(gain / 60);
  etat.proposition = route;
  const texte = `⚡ Itinéraire plus rapide : ${min} min de gagnées`;
  const accepter = () => {
    if (etat?.proposition !== route) return;
    etat.proposition = null;
    installerRoute(route);
    etat.horsRoute = 0;
    afficherAlerte(null);
    parler("Nouvel itinéraire.", true);
    majEcran();
  };
  afficherAlerte(`${texte} · dites « oui »`, { libelle: "✅ Le prendre", action: accepter });
  direPuisEcouter(`Un itinéraire plus rapide est disponible, ${min} minutes de gagnées. Voulez-vous le prendre ? Dites oui ou non.`).then((r) => {
    if (etat?.proposition !== route) return;
    const ok = interpreterOuiNon(r);
    if (ok === true) accepter();
    else if (ok === false) {
      etat.proposition = null;
      afficherAlerte(null);
      parler("D'accord, on garde l'itinéraire actuel.");
    }
  });
  setTimeout(() => {
    if (etat?.proposition !== route) return;
    etat.proposition = null;
    if ($("ev-nav-alerte").textContent.startsWith(texte)) afficherAlerte(null);
  }, DUREE_PROPOSITION_MS);
}

async function replanifier() {
  if (!etat?.onReplanifier) return;
  afficherAlerte("🔄 Recalcul des recharges depuis ta position…");
  const pct = Math.max(1, Math.round(batterieEstimee()));
  const nouveauPlan = await etat.onReplanifier(`${etat.pos.lat.toFixed(5)},${etat.pos.lon.toFixed(5)}`, pct, etat.arretsRestants);
  if (!etat) return;
  if (!nouveauPlan?.ok) {
    afficherAlerte(`⚠️ ${nouveauPlan?.erreur || "Recalcul impossible."}`);
    return;
  }
  etat.plan = nouveauPlan;
  etat.indiceTrace = 0;
  etat.arretsRestants = [...(nouveauPlan.arrets || [])];
  etat.batterie = { refPct: pct, refOdometre: etat.odometre };
  // Le nouveau plan part d'ici : ses kilomètres sont décalés d'autant.
  etat.kmPlan = etat.odometre / 1000;
  etat.pctDepartPlan = pct;
  etat.alerteBatterieAffichee = false;
  const route = await calculerRouteNav(etat.pos, etat.pos.cap);
  if (route) {
    installerRoute(route);
    chercherRadars();
    chercherAires();
  }
  afficherAlerte(null);
  parler(
    nouveauPlan.nb_arrets ? `Nouveau plan : ${nouveauPlan.nb_arrets} arrêt${nouveauPlan.nb_arrets > 1 ? "s" : ""}, le prochain à ${nouveauPlan.arrets[0].nom_borne}.` : "Nouveau plan : plus besoin de recharger.",
    true,
  );
  majEcran();
}

// Le conducteur voit la route barrée devant lui (travaux inconnus de
// TomTom) : on l'évite pour tout le reste du trajet, recalculs compris.
async function routeBarree() {
  if (!etat?.route || !etat.pos || etat.recalculEnCours || etat.aLaBorne || etat.arrive) return;
  const zones = carresSurTrace(etat.route.coords, etat.route.cum, etat.offset, DISTANCES_ROUTE_BARREE_M, DEMI_COTE_ZONE_M);
  if (!zones.length) return;
  const avant = etat.zonesEvitees;
  etat.zonesEvitees = [...avant, ...zones].slice(-MAX_ZONES_EVITEES);
  etat.recalculEnCours = true;
  afficherAlerte("🚧 Route barrée : recherche d'un autre chemin…");
  parler("D'accord, je cherche un autre chemin.", true);
  const route = await calculerRouteNav(etat.pos, etat.pos.cap, { sansSecours: true });
  if (!etat) return;
  etat.recalculEnCours = false;
  etat.dernierRecalcul = Date.now();
  etat.dernierTrafic = Date.now();
  if (!route) {
    etat.zonesEvitees = avant;
    afficherAlerte("⚠️ Pas de réponse pour un autre chemin (réseau ?). Touche 🚧 à nouveau un peu plus loin.");
    parler("Je n'ai pas pu chercher d'autre chemin.", true);
    return;
  }
  etat.reessaiBarree = { zones, restants: NB_REESSAIS_BARREE };
  accepterRouteBarree(route);
}

// Nouvelle route après « route barrée » : si TomTom n'a pas pu éviter
// l'endroit (aucun autre chemin depuis la position actuelle), on le dit et
// on réessaie un peu plus loin.
function accepterRouteBarree(route) {
  const r = etat.reessaiBarree;
  const traverse = traceTraverseCarres(route.coords, r.zones);
  installerRoute(route);
  etat.horsRoute = 0;
  if (!traverse) {
    etat.reessaiBarree = null;
    afficherAlerte(null);
    const premiere = route.instructions.find((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE");
    parler(`Autre chemin trouvé. ${premiere ? premiere.message : ""}`, true);
  } else if (r.restants > 0) {
    r.restants--;
    r.odometre = etat.odometre + PAS_REESSAI_BARREE_M;
    afficherAlerte("🚧 Pas encore d'autre chemin possible d'ici (sens unique ?). Je réessaie un peu plus loin.");
    if (r.restants === NB_REESSAIS_BARREE - 1) parler("Pas d'autre chemin possible d'ici. Je réessaie un peu plus loin.", true);
  } else {
    etat.reessaiBarree = null;
    afficherAlerte("⚠️ Aucun autre chemin trouvé : il faudra passer par là, ou faire demi-tour quand c'est possible.");
    parler("Je ne trouve pas d'autre chemin.", true);
  }
  majEcran();
}

async function reessayerRouteBarree() {
  etat.recalculEnCours = true;
  const route = await calculerRouteNav(etat.pos, etat.pos.cap, { sansSecours: true });
  if (!etat) return;
  etat.recalculEnCours = false;
  etat.dernierRecalcul = Date.now();
  etat.dernierTrafic = Date.now();
  if (!etat.reessaiBarree) return;
  if (route) accepterRouteBarree(route);
  else etat.reessaiBarree.odometre = etat.odometre + PAS_REESSAI_BARREE_M;
}

// ── Réception des positions ─────────────────────────────────────────────────

// Quatre positions à ne pas confondre :
//   - la mesure du téléphone, telle quelle (etat.posBrute, jamais modifiée) ;
//   - la position de travail (etat.pos) : la mesure, avec vitesse et cap
//     complétés quand le téléphone ne les donne pas ;
//   - le point de l'itinéraire retenu par le recalage (etat.recalage,
//     etat.offset) : c'est lui qui sert aux distances, annonces et alertes ;
//   - la voiture dessinée (etat.aff), lissée pour l'œil seulement.
function surPosition(p) {
  if (!etat?.route) return;
  const maintenant = Date.now();
  // Mesure ancienne, dans le désordre ou physiquement impossible : écartée,
  // avec sa raison dans le journal. La démo fabrique des mesures parfaites.
  const q = etat.demo ? { valide: true, niveau: "bon", age_s: 0, suivi: {} } : qualiteMesure(p, etat.posBrute, maintenant, etat.suiviGps);
  etat.suiviGps = q.suivi;
  if (!q.valide) {
    etat.gpsRejets = (etat.gpsRejets || 0) + 1;
    if (maintenant - (etat.dernierRejetNote || 0) > 10000) {
      etat.dernierRejetNote = maintenant;
      noter("gps", `mesure écartée : ${q.raison}`);
    }
    return;
  }
  etat.posBrute = { lat: p.lat, lon: p.lon, precision: p.precision, t: p.t, cap: p.cap, vitesse: p.vitesse };
  const precedent = etat.pos;
  if (!Number.isFinite(p.vitesse) && precedent) {
    const dt = (p.t - precedent.t) / 1000;
    p.vitesse = dt > 0 ? (haversineKm(precedent.lat, precedent.lon, p.lat, p.lon) * 1000) / dt : 0;
  }
  // Recalage avec le cap du GPS (avant qu'il soit complété plus bas).
  const m = recaler(etat.route, { lat: p.lat, lon: p.lon, precision: p.precision, cap: p.cap, vitesse: p.vitesse, t: p.t }, etat.recalage);
  etat.recalage = m;
  etat.gps = { niveau: q.niveau, age_s: q.age_s, confiance: m.confiance, ecart_m: m.d };
  // Heure d'arrivée de la mesure (horloge du téléphone) : sert à savoir
  // depuis quand on n'en reçoit plus.
  etat.dernierFixe = { offset: m.offset, vitesse: p.vitesse || 0, t: maintenant, d: m.d, precision: p.precision };
  majSignalGps("suivi");
  const [lonA, latA] = etat.route.coords[m.i];
  const [lonB, latB] = etat.route.coords[Math.min(m.i + 1, etat.route.coords.length - 1)];
  const capRoute = capEntre(latA, lonA, latB, lonB);
  if (!Number.isFinite(p.cap) || (p.vitesse || 0) < 2) p.cap = m.d < 30 ? capRoute : precedent?.cap ?? capRoute;

  // Distance réellement mesurée (pas celle estimée sans signal).
  const avance = m.offset - (etat.offsetMesure ?? etat.offset);
  etat.offsetMesure = m.offset;
  if (avance > 0 && avance < 20000) {
    etat.odometre += avance;
    // Type de route (pour la conso apprise) d'après la vitesse.
    const kmhType = (p.vitesse || 0) * 3.6;
    const type = kmhType < 55 ? "ville" : kmhType < 95 ? "route" : "autoroute";
    etat.kmTypes[type] += avance / 1000;
    const appris = etat.consoAppriseParType?.[type];
    etat.energieCumulee += (avance / 1000) * (appris ? appris / 100 : etat.consoKwhKm);
  }
  // Tracé réellement roulé (« Revoir mes trajets ») : un point tous les 150 m.
  const dernier = etat.traceRoulee[etat.traceRoulee.length - 1];
  if (!etat.demo && (!dernier || haversineKm(dernier[1], dernier[0], p.lat, p.lon) > 0.15)) etat.traceRoulee.push([Math.round(p.lon * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5]);
  // Nouveau repère de batterie : la répartition repart d'ici.
  if (!etat.batterie.refTypes) etat.batterie.refTypes = { ...etat.kmTypes };
  if (etat.batterie.refEnergie === undefined) etat.batterie.refEnergie = etat.energieCumulee;
  etat.idx = m.i;
  etat.offset = m.offset;
  etat.pos = p;
  carte2D.afficherPrecisionGPS(p.lat, p.lon, p.precision);

  // Hors itinéraire : plusieurs positions de suite trop loin du tracé, et
  // d'autant plus de mesures que le signal est mauvais (voir recalage.js).
  const hors = evaluerHorsRoute({ compte: etat.horsRoute, depuis: etat.horsRouteDepuis }, { d: m.d, precision: p.precision, vitesse: p.vitesse, t: maintenant, niveau: q.niveau });
  etat.horsRoute = hors.compte;
  etat.horsRouteDepuis = hors.depuis;
  // Passé quand même par l'endroit barré (voiture au bout des zones, pas
  // seulement en approche) : plus rien à éviter devant.
  if (etat.reessaiBarree && traceTraverseCarres([[p.lon, p.lat]], etat.reessaiBarree.zones.slice(-2))) {
    etat.reessaiBarree = null;
    afficherAlerte(null);
  }
  if (etat.reessaiBarree && etat.odometre >= etat.reessaiBarree.odometre && !etat.recalculEnCours) reessayerRouteBarree();
  // 2 mesures de suite (pas 3) : recalcule plus vite après un changement de
  // route voulu, demande du 2026-10-03 ("ça met du temps à se remettre").
  else if (hors.confirme && Date.now() - etat.dernierRecalcul > DELAI_MIN_RECALCUL_MS) recalculer("hors_route");
  else if (!etat.demo && Date.now() - etat.dernierTrafic > DELAI_TRAFIC_MS) recalculer("trafic");

  // Arrivée à une borne ou à destination
  const arret = etat.arretsRestants[0];
  if (arret && !etat.aLaBorne) {
    const finTroncon = etat.route.troncons[0].fin;
    if (etat.offset >= finTroncon - 40 || haversineKm(p.lat, p.lon, arret.lat, arret.lon) < 0.06) arriveeBorne(arret);
  }
  if (!arret && (etat.offset >= etat.route.total - 30 || haversineKm(p.lat, p.lon, etat.destination.lat, etat.destination.lon) < 0.04)) arriveeDestination();

  // Heure de la mesure (pas celle de sa réception) : c'est elle qui sépare deux vitesses.
  majZoom((p.vitesse || 0) * 3.6, Number.isFinite(p.t) ? p.t : maintenant);
  programmerAnimation(p, m);
  annonces();
  majEcran();
  rafraichirBornesProches();
  preparerCarrefours();
  verifierMeteo();
  verifierMiParcours();
  if (etat.prefs.aires && etat.airesOdometreFin != null && etat.odometre > etat.airesOdometreFin - RELANCE_AIRES_M && etat.offset < etat.route.total - RELANCE_AIRES_M) chercherAires();
  if (etat.prefs.parkingArrivee && !etat.parkingsProposes && !etat.arretsRestants.length && !etat.destinationFinale && etat.odometre > 500 && etat.route.total - etat.offset < DISTANCE_PROPOSITION_PARKING_M) {
    proposerParkings();
  }
}

// Zoom voulu pour la position courante (etat.offset). kmh : vitesse reçue,
// lissée ici avant de servir ; t : heure de la mesure (ms).
function majZoom(kmh, t) {
  etat.vitesseZoom = vitessePourZoom(etat.vitesseZoom, { kmh, t, limite: etat.route.limites[etat.idx] });
  const zoom = zoomNavigation({
    kmh: etat.vitesseZoom.kmh,
    kmhZoom: etat.vitesseZoom.kmhZoom,
    offset: etat.offset,
    instructions: etat.route.instructions,
    voies: etat.route.voies,
    zoomActuel: etat.zoom,
    enManoeuvre: !!etat.zoomManoeuvre,
    renforce: etat.prefs.zoomRenforce,
    hauteurEcran: window.innerHeight,
  });
  // etat.zoom garde la valeur brute (référence pour ne pas bouger à chaque
  // petite variation) : le décalage manuel du réglage Profil ne s'applique
  // qu'à l'affichage, plus bas (programmerAnimation).
  etat.zoom = zoom.zoom;
  etat.zoomManoeuvre = zoom.manoeuvre;
  // Rond-point, carrefour serré : vue 3D presque de dessus, plus lisible.
  vue.inclinaisonNavigation?.(zoom.manoeuvre === "rondpoint" || zoom.manoeuvre === "carrefour" ? "plat" : "normal");
}

// ── Animation fluide de la voiture ──────────────────────────────────────────
// Le GPS ne donne qu'une position par seconde : afficher chacune telle
// quelle fait avancer la voiture par sauts. On glisse donc le long de la
// route entre deux positions (en visant là où la voiture sera à la
// suivante, pour ne pas afficher avec une seconde de retard), et la
// rotation et le zoom de la carte suivent en douceur.

const CONSTANTE_CAP_MS = 350;
const CONSTANTE_ZOOM_MS = 700;
const INTERVALLE_TRACE_MS = 120;

// Décalage manuel du réglage Profil (-2 à +2), appliqué seulement à
// l'affichage caméra -- etat.zoom/aff.zoom restent la valeur brute pour que
// l'hystérésis de zoomNavigation (paliers de vitesse) continue de
// fonctionner normalement. Demande explicite de l'utilisateur le 2026-09-30.
function zoomAffiche(zoom) {
  return Math.max(13, Math.min(19.5, zoom + (etat.prefs.decalageZoom || 0)));
}

function programmerAnimation(p, m) {
  const maintenant = performance.now();
  const duree = etat.derniereFixe ? Math.min(1500, Math.max(300, maintenant - etat.derniereFixe)) : 0;
  etat.derniereFixe = maintenant;

  let vers;
  if (m.d < 30) {
    vers = { offset: Math.min(etat.route.total, m.offset + (p.vitesse || 0) * (duree / 1000)) };
    // Petit retour en arrière dû à l'anticipation (la voiture a freiné) : on attend.
    const avant = etat.aff?.offset;
    if (avant != null && vers.offset < avant && avant - vers.offset < 15) vers.offset = avant;
  } else {
    vers = { lat: p.lat, lon: p.lon, cap: p.cap, offset: null };
  }
  if (!etat.aff) {
    const pt = vers.offset != null ? pointSurRoute(vers.offset) : vers;
    etat.aff = { lat: pt.lat, lon: pt.lon, cap: pt.cap || 0, zoom: etat.zoom, offset: vers.offset };
  }
  etat.anim = { depuis: { ...etat.aff }, vers, debut: maintenant, duree: Math.max(1, duree) };
  if (!etat.raf) etat.raf = requestAnimationFrame(boucleAnimation);
}

function boucleAnimation(t) {
  if (!etat?.route || !etat.anim) {
    if (etat) etat.raf = null;
    return;
  }
  // Téléphone faible : une image sur trois suffit.
  if (etat.eco && etat.derniereImage && t - etat.derniereImage < 50) {
    etat.raf = requestAnimationFrame(boucleAnimation);
    return;
  }
  const { depuis, vers, debut, duree } = etat.anim;
  const k = Math.min(1, (t - debut) / duree);
  const dtImage = etat.derniereImage ? Math.min(100, t - etat.derniereImage) : 16;
  etat.derniereImage = t;
  const aff = etat.aff;

  let capCible;
  let indice = etat.idx;
  if (vers.offset != null && depuis.offset != null && Math.abs(vers.offset - depuis.offset) < 800) {
    aff.offset = depuis.offset + (vers.offset - depuis.offset) * k;
    const pt = pointSurRoute(aff.offset);
    aff.lat = pt.lat;
    aff.lon = pt.lon;
    capCible = pt.cap;
    indice = pt.i;
  } else {
    const but = vers.offset != null ? pointSurRoute(vers.offset) : vers;
    aff.lat = depuis.lat + (but.lat - depuis.lat) * k;
    aff.lon = depuis.lon + (but.lon - depuis.lon) * k;
    capCible = Number.isFinite(but.cap) ? but.cap : aff.cap;
    aff.offset = k >= 1 ? vers.offset : null;
  }

  const ecartCap = ((capCible - aff.cap + 540) % 360) - 180;
  aff.cap = (aff.cap + ecartCap * Math.min(1, dtImage / CONSTANTE_CAP_MS) + 360) % 360;
  const ecartZoom = etat.zoom - aff.zoom;
  aff.zoom = Math.abs(ecartZoom) < 0.01 ? etat.zoom : aff.zoom + ecartZoom * Math.min(1, dtImage / CONSTANTE_ZOOM_MS);

  vue.majVoiture(aff.lat, aff.lon, aff.cap);
  if (etat.suivi) vue.cameraNavigation(aff.lat, aff.lon, aff.cap, zoomAffiche(aff.zoom), etat.sensDeMarche, false);
  if (t - (etat.derniereTrace || 0) > INTERVALLE_TRACE_MS || k >= 1) {
    etat.derniereTrace = t;
    vue.majProgressionNavigation(etat.route.coords, indice, aff.lat, aff.lon);
  }

  // Au repos (animation finie, rotation et zoom stabilisés) : plus rien à
  // redessiner avant la prochaine position, on économise la batterie.
  if (k >= 1 && Math.abs(ecartCap) < 0.5 && Math.abs(ecartZoom) < 0.01) {
    etat.raf = null;
    etat.derniereImage = null;
    return;
  }
  etat.raf = requestAnimationFrame(boucleAnimation);
}

// ── Source de position : GPS réel ───────────────────────────────────────────

// ── Signal GPS : imprécis, absent, position estimée ─────────────────────────
// Sans mesure depuis 3 s (tunnel, parking), la voiture est supposée continuer
// à la même vitesse sur le tracé, 30 s au plus ; au-delà, la position est
// annoncée perdue. L'écran le dit toujours : une position estimée n'est
// jamais présentée comme une mesure.

function majSignalGps(signal, incertitude = null) {
  const g = etat.gps || {};
  const precision = Math.round(etat.pos?.precision ?? etat.dernierFixe?.precision ?? 0);
  if (signal !== etat.signal) {
    if (signal === "estime") etat.gpsEstimations = (etat.gpsEstimations || 0) + 1;
    if (etat.signal && (signal !== "suivi" || etat.signal !== "suivi")) noter("gps", `signal : ${etat.signal} → ${signal}`);
    etat.signal = signal;
  }
  // Incertitude utilisée par les annonces : nulle quand le signal est bon.
  etat.incertitudeM = signal === "estime" || signal === "perdu" ? incertitude ?? 0 : g.niveau === "bon" ? 0 : precision;
  const textes = {
    estime: `📡 Position estimée (sans GPS depuis ${Math.round((Date.now() - (etat.dernierFixe?.t || Date.now())) / 1000)} s)`,
    perdu: "📡 GPS perdu : position non fiable",
    fige: "📡 Pas de signal GPS",
    suivi: g.niveau === "mauvais" ? `📡 GPS très imprécis (±${precision} m)` : g.niveau === "faible" && precision ? `📡 GPS imprécis (±${precision} m)` : "",
  };
  const el = $("ev-nav-gps");
  if (!el) return;
  el.textContent = textes[signal] || "";
  el.classList.toggle("hidden", !el.textContent);
  el.classList.toggle("ev-nav-gps-estime", signal !== "suivi");
}

function surveillerSignal() {
  if (!etat?.route || !etat.dernierFixe || etat.aLaBorne || etat.arrive || etat.recalculEnCours) return;
  const e = estimerProgression(etat.dernierFixe, Date.now(), etat.route.total);
  if (e.etat === "suivi") return;
  const dejaPerdu = etat.signal === "perdu";
  majSignalGps(e.etat, e.incertitude_m);
  // Position perdue ou figée : plus rien n'avance.
  if (e.etat !== "estime" || dejaPerdu) return;
  const pt = pointSurRoute(e.offset);
  etat.idx = pt.i;
  etat.offset = e.offset;
  majZoom(etat.dernierFixe.vitesse * 3.6, Date.now());
  programmerAnimation({ lat: pt.lat, lon: pt.lon, cap: pt.cap, vitesse: etat.dernierFixe.vitesse }, { d: 0, offset: e.offset });
  annonces();
  majEcran();
}

function demarrerGps() {
  etat.surveillanceSignal = setInterval(surveillerSignal, 1000);
  etat.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (etat?.alerteGps) {
        etat.alerteGps = false;
        afficherAlerte(null);
      }
      surPosition({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        vitesse: pos.coords.speed ?? NaN,
        cap: pos.coords.heading ?? NaN,
        precision: pos.coords.accuracy,
        t: pos.timestamp,
      });
    },
    (err) => {
      if (!etat) return;
      noter("gps", `erreur ${err.code} : ${err.message}`);
      etat.alerteGps = true;
      afficherAlerte(err.code === err.PERMISSION_DENIED ? "⚠️ Accès à la position refusé : autorise la localisation pour cette appli." : "⚠️ Signal GPS perdu, recherche…");
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
}

// ── Source de position : mode démo (trajet simulé) ──────────────────────────

function pointSurRoute(offset) {
  const { coords, cum } = etat.route;
  // Recherche dichotomique : appelée à chaque image pendant l'animation.
  let bas = 0;
  let haut = cum.length - 2;
  while (bas < haut) {
    const milieu = (bas + haut + 1) >> 1;
    if (cum[milieu] <= offset) bas = milieu;
    else haut = milieu - 1;
  }
  const i = Math.max(0, bas);
  const t = cum[i + 1] > cum[i] ? Math.max(0, Math.min(1, (offset - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
  const [lonA, latA] = coords[i];
  const [lonB, latB] = coords[i + 1];
  return { lat: latA + t * (latB - latA), lon: lonA + t * (lonB - lonA), cap: capEntre(latA, lonA, latB, lonB), i };
}

// La voiture simulée roule un peu sous la limitation et ralentit avant
// chaque manœuvre (rond-point, sortie…), comme un vrai conducteur.
function vitesseDemoKmh(offset, i) {
  let kmh = etat.route.limites[i] ? etat.route.limites[i] * 0.93 : 85;
  const instr = etat.route.instructions.find((x) => x.offset > offset && x.type !== "LOCATION_DEPARTURE");
  const d = instr ? instr.offset - offset : Infinity;
  if (d < 60) kmh = Math.min(kmh, 30);
  else if (d < 250) kmh = Math.min(kmh, 30 + (d - 60) * 0.25);
  return kmh;
}

function demarrerDemo() {
  etat.demoOffset = etat.offset;
  const acceleration = window.TRAJETVE_ACCELERATION_DEMO || ACCELERATION_DEMO;
  etat.demoTimer = setInterval(() => {
    if (!etat || etat.aLaBorne || etat.arrive) return;
    let offset = etat.demoOffset ?? etat.offset;
    const p0 = pointSurRoute(offset);
    const kmh = vitesseDemoKmh(offset, p0.i);
    offset = Math.max(offset, etat.offset) + (kmh / 3.6) * acceleration;
    if (offset > etat.route.total) offset = etat.route.total;
    etat.demoOffset = offset;
    const p = pointSurRoute(offset);
    surPosition({ lat: p.lat, lon: p.lon, vitesse: kmh / 3.6, cap: p.cap, precision: 5, t: Date.now() });
  }, 1000);
}

async function garderEcranAllume() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") etat.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* non supporté ou refusé : l'écran pourra s'éteindre */
  }
}

function surVisibilite() {
  if (!etat) return;
  if (document.visibilityState === "visible") garderEcranAllume();
  // Sauvegarde immédiate en passant en arrière-plan : sur Android, l'appli
  // peut être tuée par le système sans qu'aucun autre évènement ("pagehide")
  // ne se déclenche avant -- la reprise ("🧭 Navigation coupée") ne doit pas
  // dépendre de la dernière sauvegarde périodique (jusqu'à 15 s plus vieille,
  // voire jamais arrivée si la coupure est très rapide après le départ).
  else sauverNavigation();
}

// ── Démarrage / arrêt ───────────────────────────────────────────────────────

let cable = false;

function cablerBoutons() {
  if (cable) return;
  cable = true;
  $("ev-nav-stop-btn").addEventListener("click", () => {
    if (confirm("Arrêter la navigation ?")) arreterNavigation();
  });
  $("ev-nav-voix-btn").addEventListener("click", () => {
    etat.voix = !etat.voix;
    $("ev-nav-voix-btn").innerHTML = icone(etat.voix ? "son" : "muet");
    if (!etat.voix) speechSynthesis.cancel();
  });
  $("ev-nav-orientation-btn").addEventListener("click", () => {
    etat.sensDeMarche = !etat.sensDeMarche;
    majBoutonOrientation();
    etat.suivi = true;
    $("ev-nav-recentrer-btn").classList.add("hidden");
    if (etat.pos) vue.cameraNavigation(etat.pos.lat, etat.pos.lon, etat.pos.cap, 16, etat.sensDeMarche, false);
  });
  $("ev-nav-3d-btn").addEventListener("click", basculerVue);
  $("ev-nav-barree-btn").addEventListener("click", routeBarree);
  $("ev-nav-menu-btn").addEventListener("click", () => $("ev-nav-menu").classList.toggle("hidden"));
  $("ev-nav-menu").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $("ev-nav-menu").classList.add("hidden");
    if (b.dataset.navAction) actionMenu(b.dataset.navAction);
  });
  // Un toucher en dehors du menu (la carte, le bandeau) le referme : en
  // roulant, pas question de viser un petit bouton.
  document.addEventListener(
    "pointerdown",
    (e) => {
      const menu = $("ev-nav-menu");
      if (menu.classList.contains("hidden") || menu.contains(e.target) || e.target.closest("#ev-nav-menu-btn")) return;
      menu.classList.add("hidden");
    },
    true,
  );
  $("ev-nav-hud").addEventListener("click", () => basculerHud(false));
  $("ev-nav-micro-btn").addEventListener("click", commandeVocale);
  window.addEventListener("online", surReseau);
  window.addEventListener("offline", surReseau);
  $("ev-nav-manoeuvre").addEventListener("click", () => etat && basculerFeuilleDeRoute());
  $("ev-nav-feuille").addEventListener("click", () => $("ev-nav-feuille").classList.add("hidden"));
  $("ev-nav-point").addEventListener("click", (e) => {
    const a = e.target.closest("[data-point]")?.dataset.point;
    if (a === "etape") {
      $("ev-nav-point").classList.add("hidden");
      if (etat?.pointChoisi) ajouterEtape({ ...etat.pointChoisi, nom: "Point choisi sur la carte", adresse: "" });
    } else if (a === "aller") allerAuPoint();
    else if (a === "fermer") $("ev-nav-point").classList.add("hidden");
  });
  document.addEventListener("pointerdown", () => etat && reveillerBoutons(), true);
  // Valeurs au toucher du graphique de batterie (crosshair).
  $("ev-nav-batt-graph").addEventListener("pointermove", toucherGraphique);
  $("ev-nav-batt-graph").addEventListener("pointerdown", toucherGraphique);
  $("ev-nav-secours").addEventListener("click", (e) => {
    if (e.target.closest("[data-fermer]")) return $("ev-nav-secours").classList.add("hidden");
    const i = e.target.closest("[data-secours]")?.dataset.secours;
    if (i !== undefined) remplacerBorne(Number(i));
  });
  $("ev-nav-recherche-cats").innerHTML = CATEGORIES_TRAJET.map((c) => `<button type="button" data-requete="${escapeHtml(c.requete)}">${c.icone}<span>${escapeHtml(c.nom)}</span></button>`).join("");
  $("ev-nav-recherche").addEventListener("click", (e) => {
    if (e.target.closest("[data-fermer]")) return $("ev-nav-recherche").classList.add("hidden");
    const q = e.target.closest("[data-requete]")?.dataset.requete;
    if (q) return chercherLeLongDuTrajet(q);
    const i = e.target.closest("[data-etape]")?.dataset.etape;
    if (i !== undefined && etat?.lieuxTrouves?.[i]) ajouterEtape(etat.lieuxTrouves[i]);
  });
  const PUISSANCES_BORNE_PERSO = [
    ["7", "7 kW"],
    ["22", "22 kW"],
    ["50", "50 kW"],
    ["100", "100 kW"],
    ["150", "150+ kW"],
  ];
  const CONNECTEURS_BORNE_PERSO = ["Type 2", "Combo CCS", "CHAdeMO"];
  $("ev-borne-perso-kw").innerHTML = PUISSANCES_BORNE_PERSO.map(([v, l]) => `<button type="button" class="ev-chip" data-kw="${v}">${l}</button>`).join("");
  $("ev-borne-perso-connecteur").innerHTML = CONNECTEURS_BORNE_PERSO.map((c) => `<button type="button" class="ev-chip" data-connecteur="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("");
  $("ev-nav-borne-perso").addEventListener("click", (e) => {
    if (e.target.closest("[data-fermer]")) return $("ev-nav-borne-perso").classList.add("hidden");
    const chip = e.target.closest(".ev-chip");
    if (chip) chip.parentElement.querySelectorAll(".ev-chip").forEach((c) => c.classList.toggle("actif", c === chip ? !c.classList.contains("actif") : false));
  });
  $("ev-borne-perso-enregistrer-btn").addEventListener("click", () => {
    const puissance_kw = Number($("ev-borne-perso-kw").querySelector(".ev-chip.actif")?.dataset.kw || 0);
    const connecteur = $("ev-borne-perso-connecteur").querySelector(".ev-chip.actif")?.dataset.connecteur || "";
    const note = $("ev-borne-perso-note").value;
    const { ok } = signalerBorneIci({ puissance_kw, connecteur, note });
    if (ok) {
      $("ev-nav-borne-perso").classList.add("hidden");
      $("ev-borne-perso-note").value = "";
      $("ev-nav-borne-perso").querySelectorAll(".ev-chip.actif").forEach((c) => c.classList.remove("actif"));
    }
  });
  $("ev-nav-parkings").addEventListener("click", (e) => {
    if (e.target.closest("[data-fermer]")) return $("ev-nav-parkings").classList.add("hidden");
    const i = e.target.closest("[data-parking]")?.dataset.parking;
    if (i !== undefined && etat?.parkingsTrouves?.[i]) allerAuParking(etat.parkingsTrouves[i]);
  });
  $("ev-nav-apercu-btn").addEventListener("click", () => {
    clearTimeout(etat.retourSuivi);
    etat.apercu = true;
    etat.suivi = false;
    $("ev-nav-recentrer-btn").textContent = vue === carte2D ? "🎯 Revenir au guidage" : "🎯 Recentrer";
    $("ev-nav-recentrer-btn").classList.remove("hidden");
    vue.apercuNavigation(etat.route.coords.slice(etat.idx));
  });
  $("ev-nav-recentrer-btn").addEventListener("click", () => {
    etat.apercu = false;
    reprendreSuivi();
  });
  $("ev-nav-batt-btn").addEventListener("click", () => {
    const panneau = $("ev-nav-batterie-panneau");
    const ouvert = !panneau.classList.contains("hidden");
    if (ouvert) {
      panneau.classList.add("hidden");
      return;
    }
    const pct = Math.max(1, Math.round(batterieEstimee()));
    $("ev-nav-batt-input").value = String(pct);
    $("ev-nav-batt-val").textContent = String(pct);
    panneau.classList.remove("hidden");
    majGraphiqueBatterie();
  });
  $("ev-nav-batt-input").addEventListener("input", (e) => ($("ev-nav-batt-val").textContent = e.target.value));
  $("ev-nav-batt-ok").addEventListener("click", () => {
    if (!etat.demo) mesurerConso(Number($("ev-nav-batt-input").value));
    etat.batterie = { refPct: Number($("ev-nav-batt-input").value), refOdometre: etat.odometre };
    noterBatterie(Number($("ev-nav-batt-input").value));
    etat.alerteBatterieAffichee = false;
    $("ev-nav-batterie-panneau").classList.add("hidden");
    majEcran();
  });
  $("ev-nav-replan-btn").addEventListener("click", () => {
    if (!etat.demo) mesurerConso(Number($("ev-nav-batt-input").value));
    etat.batterie = { refPct: Number($("ev-nav-batt-input").value), refOdometre: etat.odometre };
    noterBatterie(Number($("ev-nav-batt-input").value));
    $("ev-nav-batterie-panneau").classList.add("hidden");
    replanifier();
  });
  window.addEventListener("popstate", () => {
    if (etat) arreterNavigation({ depuisRetour: true });
  });
  document.addEventListener("visibilitychange", surVisibilite);
}

// Boutons de droite estompés après 8 s sans toucher l'écran (la carte
// reste dégagée) ; nets à nouveau au moindre toucher.
const DELAI_CALME_MS = 8000;
let minuteurCalme = null;

function reveillerBoutons() {
  document.body.classList.remove("ev-nav-calme", "ev-nav-epure");
  if (etat) etat.epureSuspenduJusqua = Date.now() + DUREE_REVEIL_EPURE_MS;
  clearTimeout(minuteurCalme);
  minuteurCalme = setTimeout(() => etat && document.body.classList.add("ev-nav-calme"), DELAI_CALME_MS);
}

// ── Bandeau replié, écran épuré, feuille de route ───────────────────────────

const REPLI_DEBUT_M = 5000;
const REPLI_FIN_M = 4000;
const VITESSE_EPURE_KMH = 90;
const DUREE_REVEIL_EPURE_MS = 12000;
const NB_LIGNES_FEUILLE = 15;

// Toucher le bandeau : liste des prochaines manœuvres, bornes et arrivée.
function basculerFeuilleDeRoute() {
  const f = $("ev-nav-feuille");
  f.classList.toggle("hidden");
  if (!f.classList.contains("hidden")) majFeuilleDeRoute();
}

function majFeuilleDeRoute() {
  const route = etat.route;
  const lignes = route.instructions
    .filter((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE" && !i.synthetique)
    .slice(0, NB_LIGNES_FEUILLE)
    .map((i) => ({ offset: i.offset, html: `<span class="ev-feuille-fleche">${svgFleche(i)}</span><span>${escapeHtml(i.message || "Continuez")}</span>` }));
  etat.arretsRestants.forEach((a, k) => {
    const fin = route.troncons[k]?.fin;
    if (fin > etat.offset) lignes.push({ offset: fin, html: `<span class="ev-feuille-fleche">${a.pause ? "📍" : "🔋"}</span><span><strong>${escapeHtml(a.nom_borne)}</strong></span>` });
  });
  lignes.sort((a, b) => a.offset - b.offset);
  $("ev-nav-feuille-liste").innerHTML = lignes.map((l) => `<div class="ev-feuille-ligne">${l.html}<em>${distanceAffichee(l.offset - etat.offset)}</em></div>`).join("") || `<div class="ev-nav-carte-sous">Tout droit jusqu'à l'arrivée.</div>`;
}

// ── Nuit douce : carte et bandeau un peu moins lumineux après le coucher ─────

function majNuitDouce() {
  if (!etat.pos || Date.now() - (etat.derniereNuit || 0) < 60000) return;
  etat.derniereNuit = Date.now();
  document.body.classList.toggle("ev-nuit-douce", etat.prefs.nuitDouce && estNuit(etat.pos.lat, etat.pos.lon));
}

// ── Guidage sur l'écran verrouillé (notification Android) ───────────────────

async function majNotificationGuidage(instr) {
  if (document.visibilityState === "visible" && !etat.notifAffichee) return;
  if (!etat.prefs.notifGuidage || !("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker?.getRegistration?.();
  if (!reg) return;
  if (document.visibilityState === "visible" || !instr || etat.arrive) {
    if (etat.notifAffichee) {
      etat.notifAffichee = null;
      (await reg.getNotifications({ tag: "guidage" })).forEach((n) => n.close());
    }
    return;
  }
  const d = instr.offset - etat.offset;
  // Nouvelle manœuvre, ou distance changée d'au moins un palier.
  const palier = d > 2000 ? Math.round(d / 1000) : d > 300 ? Math.round(d / 100) : Math.round(d / 50);
  const cle = `${instr.offset}|${palier}`;
  if (etat.notifAffichee === cle) return;
  etat.notifAffichee = cle;
  const t = textesPanneau(instr);
  reg.showNotification(`${fleche(instr.manoeuvre)} ${distanceAffichee(d)} · ${t.rue || t.action}`, { body: t.rue ? t.action : "", tag: "guidage", renotify: false, silent: true, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png" });
}

async function demanderPermissionNotifications() {
  if (!etat.prefs.notifGuidage || !("Notification" in window) || Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    // Refusé ou indisponible : le guidage reste dans l'appli.
  }
}

// ── Appui long sur la carte : « Aller ici » ou « Ajouter comme étape » ───────

function surAppuiLong(lat, lon) {
  if (!etat?.route) return;
  etat.pointChoisi = { lat, lon };
  $("ev-nav-point").classList.remove("hidden");
}

async function allerAuPoint() {
  const p = etat.pointChoisi;
  $("ev-nav-point").classList.add("hidden");
  if (!p) return;
  etat.destinationFinale = null;
  etat.destination = { lat: p.lat, lon: p.lon, nom: "Point choisi sur la carte" };
  // Nouvelle destination : le plan de recharge ne vaut plus (touchez la
  // batterie → « Recalculer les recharges » si besoin).
  etat.arretsRestants = etat.arretsRestants.filter((a) => a.pause);
  afficherAlerte("🏁 Nouvelle destination…");
  const route = await calculerRouteNav(etat.pos, etat.pos.cap, { sansSecours: true });
  if (!etat) return;
  if (route) installerRoute(route);
  afficherAlerte(route ? null : "⚠️ Itinéraire impossible pour le moment (réseau ?).");
  if (route) parler("Nouvelle destination.", true);
  majEcran();
}

// ── Téléphone faible (< 20 %, pas en charge) : affichage allégé ─────────────

const SEUIL_BATTERIE_TELEPHONE = 0.2;

async function surveillerBatterieTelephone() {
  if (!navigator.getBattery) return;
  try {
    const b = await navigator.getBattery();
    const maj = () => {
      if (!etat) return;
      const eco = b.level < SEUIL_BATTERIE_TELEPHONE && !b.charging;
      if (eco && !etat.eco) {
        afficherAlerte("🔋 Téléphone faible : affichage allégé (branchez-le si possible).");
        setTimeout(() => etat && $("ev-nav-alerte").textContent.startsWith("🔋 Téléphone") && afficherAlerte(null), 10000);
      }
      etat.eco = eco;
      document.body.classList.toggle("ev-eco", eco);
    };
    b.addEventListener("levelchange", maj);
    b.addEventListener("chargingchange", maj);
    maj();
  } catch {
    // API indisponible : rien à faire.
  }
}

// ── Réseau perdu / retrouvé ─────────────────────────────────────────────────
// Le guidage est gardé au départ (léger) ; sur Wi-Fi, les cartes du trajet
// aussi. Une zone blanche n'interrompt donc rien.

async function garderPourHorsLigne() {
  if (etat.demo || !navigator.onLine) return;
  try {
    const wifi = navigator.connection?.type === "wifi" && !navigator.connection?.saveData;
    if (wifi) await preparerHorsLigne(etat.plan);
    else await preparerGuidage(etat.plan);
  } catch {
    // Pas grave : le guidage en ligne continue.
  }
}

function surReseau() {
  noter("reseau", navigator.onLine ? "réseau revenu" : "réseau perdu");
  if (!etat) return;
  if (!navigator.onLine) {
    afficherAlerte("📡 Hors réseau : le guidage continue avec l'itinéraire gardé.");
  } else {
    if ($("ev-nav-alerte").textContent.startsWith("📡")) afficherAlerte(null);
    etat.horsRouteSansReseau = false;
    etat.dernierRecalcul = 0; // hors itinéraire : nouveau chemin dès la prochaine mesure
    etat.dernierTrafic = 0; // trafic à jour dès que possible
  }
}

// Menu « ⋯ » : les actions moins fréquentes.
function actionMenu(action) {
  if (!etat) return;
  if (action === "hud") basculerHud(true);
  else if (action === "recherche") $("ev-nav-recherche").classList.remove("hidden");
  else if (action === "parkings") proposerParkings(true);
  else if (action === "partage") partagerArrivee();
  else if (action === "suivi") basculerPartagePosition();
  else if (action === "sos") ouvrirSOSNavigation(false);
  else if (action === "signaler") {
    signalerProbleme("menu");
    afficherAlerte("🛟 Noté. Envoyez le rapport à l'arrêt : Profil › Aide › Signaler un problème.");
    setTimeout(() => etat && $("ev-nav-alerte").textContent.startsWith("🛟") && afficherAlerte(null), 8000);
  }
  else if (action === "secours") afficherSecours();
  else if (action === "radar") signalerRadarIci();
  else if (action === "oublier-radar") oublierDernierRadarSignale();
  else if (action === "borne-perso") $("ev-nav-borne-perso").classList.remove("hidden");
  else if (action === "oublier-borne") oublierDerniereBorneSignalee();
  else if (action === "batterie") $("ev-nav-batt-btn").click();
  else if (action === "aide") {
    afficherAlerte("🎤 En roulant : « prochaine borne ? », « trouve un café », « où me garer », « autre borne », « route barrée ». Répondez « oui » / « non » aux questions.", null, "info");
    setTimeout(() => etat && $("ev-nav-alerte").textContent.startsWith("🎤 En roulant") && afficherAlerte(null), 15000);
  }
}

// ── Météo devant soi (toutes les 15 min) ────────────────────────────────────

const INTERVALLE_METEO_MS = 15 * 60 * 1000;
const DISTANCES_METEO_M = [10000, 30000, 60000];

async function verifierMeteo() {
  if (!etat?.route || !etat.prefs.meteo || Date.now() - (etat.derniereMeteo || 0) < INTERVALLE_METEO_MS) return;
  etat.derniereMeteo = Date.now();
  const points = DISTANCES_METEO_M.map((d) => etat.offset + d)
    .filter((o) => o < etat.route.total)
    .map((o) => {
      const p = pointSurRoute(o);
      return { o, lat: p.lat, lon: p.lon, quandS: Math.round(Date.now() / 1000 + secondesRestantesJusqua(o)) };
    });
  const mesures = await meteoDesPoints(points);
  if (!etat || !mesures) return;
  for (let i = 0; i < points.length; i++) {
    const a = mesures[i] && alerteMeteo(mesures[i]);
    if (!a || etat.alertesMeteo.has(a.type)) continue;
    etat.alertesMeteo.add(a.type);
    const km = Math.max(1, Math.round((points[i].o - etat.offset) / 1000));
    const texte = `${a.texte} dans ~${km} km`;
    parler(`${a.voix} dans environ ${km} kilomètres.`);
    if ($("ev-nav-alerte").classList.contains("hidden")) {
      afficherAlerte(texte);
      setTimeout(() => etat && $("ev-nav-alerte").textContent === texte && afficherAlerte(null), 20000);
    }
    break;
  }
}

// ── Mi-parcours : rappel de pause / changement de conducteur ────────────────
// Demande explicite de l'utilisateur (2026-09-27) : sur un trajet de plus de
// 4 h, une petite alerte à mi-chemin (distance totale du plan, pas la route
// recalculée qui rétrécit à chaque arrêt) pour penser à faire une pause ou
// changer de conducteur, avec les bornes de recharge à proximité -- toujours
// annoncée sur autoroute ou voie express (pas juste avant une sortie ou en
// pleine ville, mains sur le volant).
const SEUIL_DUREE_MI_PARCOURS_MIN = 4 * 60;

function verifierMiParcours() {
  if (!etat?.route || !etat.prefs.pauseMiParcours || etat.alerteMiParcoursFaite || etat.aLaBorne) return;
  if (!(etat.plan.duree_totale_min >= SEUIL_DUREE_MI_PARCOURS_MIN) || !etat.plan.distance_km) return;
  if (etat.odometre < (etat.plan.distance_km * 1000) / 2) return;
  // Même détection que la colonne des aires (majAires) : sur autoroute ou
  // voie express seulement.
  const surRapide = (etat.route.autoroutes || []).some(([a, b]) => etat.offset >= a - 200 && etat.offset <= b);
  if (!surRapide) return; // pas encore sur autoroute pile à mi-chemin : on retente au prochain point GPS

  etat.alerteMiParcoursFaite = true;
  const bornesProches = (etat.route.aires || [])
    .filter((x) => x.type === "recharge" && x.offset > etat.offset && x.offset - etat.offset < HORIZON_AIRES_M)
    .slice(0, 2);
  const listeBornes = bornesProches.map((b) => `${b.nom || "Borne de recharge"} à ${distanceAffichee(b.offset - etat.offset)}`).join(", ");
  const texte = `🔄 Mi-parcours : pensez à une pause, ou à changer de conducteur.${listeBornes ? ` Bornes à proximité : ${listeBornes}.` : ""}`;
  parler(`Vous êtes à mi-parcours de votre trajet. Pensez à faire une pause, ou à changer de conducteur.${bornesProches.length ? " Des bornes de recharge sont à proximité." : ""}`, true);
  if ($("ev-nav-alerte").classList.contains("hidden")) {
    afficherAlerte(texte);
    setTimeout(() => etat && $("ev-nav-alerte").textContent === texte && afficherAlerte(null), 20000);
  }
}

// ── Batterie prévue / réelle ────────────────────────────────────────────────

function noterBatterie(pct) {
  etat.mesuresBatterie.push({ km: etat.odometre / 1000, pct });
}

function pointsPrevus() {
  const p = etat.plan;
  const d0 = etat.kmPlan || 0;
  const pts = [{ km: d0, pct: etat.pctDepartPlan }];
  for (const a of p.arrets || []) pts.push({ km: d0 + a.km_depuis_depart, pct: a.pct_arrivee_borne }, { km: d0 + a.km_depuis_depart, pct: a.pct_depart_borne });
  pts.push({ km: d0 + (p.distance_km || 0), pct: p.pct_batterie_arrivee ?? 0 });
  return pts;
}

function majGraphiqueBatterie() {
  const prevus = pointsPrevus();
  const reels = etat.mesuresBatterie;
  const bornes = (etat.plan.arrets || []).map((a) => ({ km: (etat.kmPlan || 0) + a.km_depuis_depart, nom: a.nom_borne }));
  $("ev-nav-batt-graph").innerHTML = svgBatterie(prevus, reels, bornes, etat.odometre / 1000);
  $("ev-nav-batt-table").innerHTML = tableauBatterie(prevus, reels);
  const kmNow = etat.odometre / 1000;
  const ecart = Math.round(batterieEstimee() - pctPrevuA(prevus, kmNow));
  $("ev-nav-batt-info").textContent =
    `Maintenant : ~${Math.round(batterieEstimee())} % (prévu ${Math.round(pctPrevuA(prevus, kmNow))} %, ${ecart >= 0 ? "+" : ""}${ecart}). ` +
    `Estimation à ±${incertitudeBatterie(etat.batterie.refPct - batterieEstimee())} % : l'appli ne lit pas la voiture, corrige le niveau ci-dessous quand tu peux.`;
}

function toucherGraphique(e) {
  const svg = $("ev-nav-batt-graph").querySelector("svg");
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 340;
  const maxKm = Number(svg.dataset.maxKm);
  const km = Math.max(0, Math.min(maxKm, ((x - 36) / (328 - 36)) * maxKm));
  const curseur = svg.querySelector(".curseur");
  curseur.setAttribute("x1", String(36 + (km / maxKm) * (328 - 36)));
  curseur.setAttribute("x2", curseur.getAttribute("x1"));
  curseur.setAttribute("visibility", "visible");
  const reel = etat.mesuresBatterie.reduce((m, p) => (Math.abs(p.km - km) < Math.abs((m?.km ?? Infinity) - km) ? p : m), null);
  const reelTxt = reel && Math.abs(reel.km - km) <= maxKm * 0.03 ? ` · réelle ${Math.round(reel.pct)} %` : "";
  $("ev-nav-batt-info").textContent = `km ${Math.round(km)} · prévue ${Math.round(pctPrevuA(pointsPrevus(), km))} %${reelTxt}`;
}

// ── Borne de secours : occupée ou en panne → une autre, en un appui ────────

function prochaineBorne() {
  const k = etat.arretsRestants.findIndex((a) => !a.pause);
  return k < 0 ? null : { k, arret: etat.arretsRestants[k] };
}

function afficherSecours() {
  const b = prochaineBorne();
  const alts = b?.arret.alternatives || [];
  $("ev-nav-secours-liste").innerHTML = !b
    ? `<div class="ev-nav-carte-sous">Plus aucune recharge prévue.</div>`
    : alts.length
      ? `<div class="ev-nav-carte-sous">À la place de ${escapeHtml(b.arret.nom_borne)} :</div>` +
        alts
          .map((a, i) => {
            const infos = [a.puissance_max_kw ? `${Math.round(a.puissance_max_kw)} kW` : "", a.operateur || "", a.prix_kwh_eur != null ? `${a.prix_kwh_eur.toFixed(2).replace(".", ",")} €/kWh` : "", a.distance_km != null ? `${a.distance_km.toFixed(1).replace(".", ",")} km de la route` : ""].filter(Boolean).join(" · ");
            return `<div class="ev-nav-resultat"><div><strong>🔌 ${escapeHtml(a.nom)}</strong><div class="ev-nav-carte-sous">${escapeHtml(infos)}</div></div><button type="button" class="ev-btn" data-secours="${i}">Y aller</button></div>`;
          })
          .join("")
      : `<div class="ev-nav-carte-sous">Pas d'autre borne connue près de celle-ci : « 🔄 Recalculer les recharges » (touchez la batterie) en cherchera une.</div>`;
  $("ev-nav-secours").classList.remove("hidden");
}

async function remplacerBorne(i) {
  const b = prochaineBorne();
  const alt = b?.arret.alternatives?.[i];
  if (!alt) return;
  $("ev-nav-secours").classList.add("hidden");
  const ancien = b.arret;
  const puissanceVoiture = obtenirProfilVehicule().puissance_dc_kw || alt.puissance_max_kw || ancien.puissance_kw;
  const puissance = Math.round(Math.min(alt.puissance_max_kw || ancien.puissance_kw, puissanceVoiture)) || ancien.puissance_kw;
  const ancienneAlt = { nom: ancien.nom_borne, adresse: ancien.adresse, lat: ancien.lat, lon: ancien.lon, distance_km: ancien.distance_borne_km, puissance_max_kw: ancien.puissance_kw, operateur: ancien.operateur, prix_kwh_eur: ancien.prix_kwh_eur };
  const nouvel = {
    ...ancien,
    nom_borne: alt.nom,
    adresse: alt.adresse,
    lat: alt.lat,
    lon: alt.lon,
    operateur: alt.operateur,
    prix_kwh_eur: alt.prix_kwh_eur ?? ancien.prix_kwh_eur,
    puissance_kw: puissance,
    temps_charge_min: Math.round((ancien.temps_charge_min * ancien.puissance_kw) / Math.max(1, puissance)),
    alternatives: [...ancien.alternatives.filter((x) => x !== alt), ancienneAlt],
  };
  etat.arretsRestants[b.k] = nouvel;
  if (etat.aLaBorne === ancien) {
    etat.aLaBorne = null;
    $("ev-nav-etape-borne").classList.add("hidden");
  }
  afficherAlerte(`🔌 Direction ${alt.nom}…`);
  const route = await calculerRouteNav(etat.pos, etat.pos.cap, { sansSecours: true });
  if (!etat) return;
  if (!route) {
    etat.arretsRestants[b.k] = ancien;
    afficherAlerte("⚠️ Changement impossible pour le moment (réseau ?).");
    return;
  }
  installerRoute(route);
  afficherAlerte(null);
  parler(`Nouvelle borne : ${alt.nom}.`, true);
  majEcran();
}

// Marque l'instant dans le journal, avec l'endroit approximatif : le rapport
// retrouvera ce qui s'est passé juste avant.
function signalerProbleme(origine) {
  const p = etat?.pos;
  noter("signalement", `${origine}${etat ? `, km ${Math.round(etat.odometre / 1000)}, vitesse ${Math.round((p?.vitesse || 0) * 3.6)} km/h` : ""}`);
}

// Résumé de la navigation pour le rapport (aucune adresse, position à ~1 km).
export function etatDiagnostic() {
  if (!etat) return null;
  const p = etat.pos;
  return {
    demo: !!etat.demo,
    vue: vue === carte3D ? "3D" : "2D",
    km_faits: Math.round(etat.odometre / 1000),
    km_restants: Math.round(((etat.route?.total || 0) - etat.offset) / 1000),
    bornes_restantes: etat.arretsRestants.length,
    batterie_estimee: Math.round(batterieEstimee()),
    gps_precision_m: p?.precision != null ? Math.round(p.precision) : "?",
    vitesse_kmh: Math.round((p?.vitesse || 0) * 3.6),
    gps_signal: etat.signal || "?",
    gps_niveau: etat.gps?.niveau || "?",
    gps_age_s: etat.gps?.age_s != null ? Math.round(etat.gps.age_s * 10) / 10 : "?",
    gps_ecart_trace_m: etat.gps?.ecart_m != null ? Math.round(etat.gps.ecart_m) : "?",
    gps_confiance_recalage: etat.gps?.confiance || "?",
    gps_mesures_ecartees: etat.gpsRejets || 0,
    gps_passages_a_l_estime: etat.gpsEstimations || 0,
    position_approx: p ? `${p.lat.toFixed(2)},${p.lon.toFixed(2)}` : "?",
    zoom: etat.zoom,
    voix: etat.voix ? "oui" : "non",
    eco: etat.prefs.modeEco ? "oui" : "non",
  };
}

// SOS depuis la navigation : dernière position connue, sens de circulation
// (direction des panneaux, sinon la destination), position lue à voix haute.
function ouvrirSOSNavigation(aVoix) {
  const suivante = etat.route?.instructions.find((i) => i.offset > etat.offset && i.direction);
  const sens = suivante?.direction || nomCourtLieu((etat.destinationFinale || etat.destination).nom);
  // Repère compris des secours : entre quelles sorties (d'après l'itinéraire).
  const instrs = etat.route?.instructions || [];
  const avant = instrs.filter((i) => i.sortie && i.offset <= etat.offset).pop();
  const apres = instrs.find((i) => i.sortie && i.offset > etat.offset);
  const reperes = [avant ? `après la sortie ${avant.sortie}` : "", apres ? `avant la sortie ${apres.sortie} (à ${distanceAffichee(apres.offset - etat.offset)})` : ""].filter(Boolean).join(", ");
  if (aVoix) parler("Je cherche votre position exacte.", true);
  ouvrirSOS({ pos: etat.pos ? { lat: etat.pos.lat, lon: etat.pos.lon, precision: Math.round(etat.pos.precision || 0), cap: etat.pos.cap } : null, sens, reperes, lireAHauteVoix: aVoix });
}

function majBoutonOrientation() {
  $("ev-nav-orientation-btn").innerHTML = etat.sensDeMarche ? "🧭<span>Nord en haut</span>" : "🅽<span>Sens de marche</span>";
}

// Temps jusqu'à l'arrivée, recharges comprises (s).
function secondesJusquArrivee() {
  const charges = etat.arretsRestants.reduce((s, a) => s + (a.temps_charge_min || 0) * 60, 0);
  return secondesRestantesJusqua(etat.route.total) + charges;
}

function nomCourtLieu(nom) {
  return String(nom || "destination").split(",").slice(0, 2).join(",").trim();
}

// « J'arrive à Nantes vers 18 h 40 » par SMS, WhatsApp… (ou copié).
// ── Position en direct : un lien de suivi pour un proche ───────────────────
// Lancé à la demande, pour ce guidage seulement (voir partage-position.js :
// les positions passent par un service public que l'appli ne contrôle pas).

function majBoutonPartagePosition() {
  const libelle = $("ev-nav-suivi-btn")?.querySelector("span");
  if (libelle) libelle.textContent = etat?.partage ? "Arrêter la position en direct" : "Position en direct";
}

// etatForce : "arrive" ou "termine" pour le dernier message.
function envoyerPositionPartagee(etatForce = null) {
  const partage = etat?.partage;
  if (!partage || !etat.pos) return;
  const fin = etat.destinationFinale || etat.destination;
  const sansSignal = etat.signal === "perdu" || etat.signal === "fige";
  const message = messagePosition({
    lat: etat.pos.lat,
    lon: etat.pos.lon,
    cap: etat.pos.cap,
    kmh: (etat.pos.vitesse || 0) * 3.6,
    arrivee_ms: etat.route ? Date.now() + secondesJusquArrivee() * 1000 : null,
    restant_km: etat.route ? (etat.route.total - etat.offset) / 1000 : null,
    batterie_pct: batterieEstimee(),
    destination: nomCourtLieu(fin.nom),
    etat: etatForce || (etat.arrive ? "arrive" : etat.aLaBorne ? "a_la_borne" : sansSignal ? "signal_perdu" : "en_route"),
  });
  publier(partage.sujet, message).then((ok) => {
    partage.echecs = ok ? 0 : partage.echecs + 1;
    // Sans réseau, les envois échouent : on le dit une fois, sans insister.
    if (partage.echecs === 3) toast("📡 Position en direct : envoi impossible pour l'instant (réseau ?)");
  });
}

function arreterPartagePosition(parUtilisateur) {
  if (!etat?.partage) return;
  clearInterval(etat.partage.minuteur);
  envoyerPositionPartagee(etat.arrive ? "arrive" : "termine");
  etat.partage = null;
  majBoutonPartagePosition();
  noter("nav", "partage de position arrêté");
  if (parUtilisateur) toast("📡 Position en direct arrêtée");
}

async function basculerPartagePosition() {
  if (etat.partage) return arreterPartagePosition(true);
  if (etat.demo) return toast("📡 La position en direct ne se partage pas en mode démo.");
  const accord = confirm(
    "Partager ta position en direct ?\n\n" +
      "Elle sera envoyée toutes les 2 minutes, jusqu'à la fin de ce guidage, à un service public gratuit (ntfy.sh) que l'appli ne contrôle pas. " +
      "Toute personne qui a le lien peut la voir pendant quelques heures.\n\nTu peux arrêter à tout moment depuis ce menu.",
  );
  if (!accord) return;
  const sujet = creerSujet();
  etat.partage = { sujet, echecs: 0, minuteur: setInterval(() => envoyerPositionPartagee(), INTERVALLE_PARTAGE_MS) };
  majBoutonPartagePosition();
  noter("nav", "partage de position lancé");
  envoyerPositionPartagee();
  const lien = lienSuivi(sujet);
  if (navigator.share) {
    try {
      await navigator.share({ text: "🚗 Suis mon trajet en direct :", url: lien });
      return;
    } catch (e) {
      if (e.name === "AbortError") return toast("📡 Position en direct lancée. Le lien n'a pas été envoyé : relance le partage pour l'envoyer.");
    }
  }
  try {
    await navigator.clipboard.writeText(lien);
    toast("📋 Lien de suivi copié : colle-le dans un message à ton proche.");
  } catch {
    prompt("Lien de suivi à envoyer à ton proche :", lien);
  }
}

async function partagerArrivee() {
  if (!etat?.route) return;
  const secondes = secondesJusquArrivee();
  const dest = nomCourtLieu((etat.destinationFinale || etat.destination).nom);
  const texte = `🚗 J'arrive à ${dest} vers ${heure(Date.now() + secondes * 1000)} (dans ${formaterMinutes(secondes / 60)}).`;
  const position = etat.pos && !etat.demo ? `\nMa position : https://www.google.com/maps?q=${etat.pos.lat.toFixed(5)},${etat.pos.lon.toFixed(5)}` : "";
  if (navigator.share) {
    try {
      await navigator.share({ text: texte + position });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(texte + position);
    afficherAlerte("📋 Message copié : colle-le dans un SMS.");
  } catch {
    afficherAlerte(texte);
  }
}

// 🎤 Commande vocale pendant la conduite.
async function commandeVocale() {
  if (!reconnaissanceDispo()) return afficherAlerte("🎤 Commande vocale indisponible sur ce navigateur.");
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  afficherAlerte("🎤 Je vous écoute…");
  const texte = await ecouter();
  if (!etat) return;
  afficherAlerte(null);
  noter("voix", `commande entendue : ${texte || "(rien)"}`);
  if (!texte) return parler("Je n'ai pas compris.", true);
  const c = interpreterCommande(texte);
  const arret = etat.arretsRestants[0];
  switch (c.action) {
    case "voix":
      etat.voix = c.valeur;
      $("ev-nav-voix-btn").innerHTML = icone(etat.voix ? "son" : "muet");
      if (etat.voix) parler("Voix activée.", true);
      break;
    case "barree":
      routeBarree();
      break;
    case "hud":
      basculerHud(true);
      break;
    case "partage":
      partagerArrivee();
      break;
    case "parkings":
      etat.parVoix = true;
      proposerParkings(true);
      break;
    case "sos":
      ouvrirSOSNavigation(true);
      break;
    case "signaler":
      signalerProbleme("à la voix");
      parler("C'est noté. Envoyez le rapport à l'arrêt : Profil, aide, signaler un problème.", true);
      break;
    case "radar":
      signalerRadarIci();
      break;
    case "batterie":
      parler(`Batterie estimée : ${Math.round(batterieEstimee())} pour cent.`, true);
      break;
    case "arrivee": {
      const s = secondesJusquArrivee();
      parler(`Arrivée prévue à ${heure(Date.now() + s * 1000)}, dans ${formaterMinutes(s / 60)}.`, true);
      break;
    }
    case "borne":
      parler(arret ? `Prochain arrêt : ${arret.nom_borne}, dans ${distanceParlee(Math.max(0, etat.route.troncons[0].fin - etat.offset))}.` : "Plus aucune recharge prévue d'ici l'arrivée.", true);
      break;
    case "recherche":
      $("ev-nav-recherche").classList.remove("hidden");
      parler(`Je cherche sur votre trajet : ${c.requete}.`, true);
      etat.parVoix = true;
      chercherLeLongDuTrajet(c.requete);
      break;
    case "secours": {
      const b = prochaineBorne();
      const alts = b?.arret.alternatives || [];
      if (!alts.length) {
        parler("Pas d'autre borne connue près de celle-ci.", true);
        break;
      }
      const i = await choisirALaVoix(`À la place de ${b.arret.nom_borne}.`, alts, (a) => `${a.nom}${a.puissance_max_kw ? `, ${Math.round(a.puissance_max_kw)} kilowatts` : ""}`);
      if (etat && i >= 0) remplacerBorne(i);
      break;
    }
    case "aller":
      parler("Pour changer de destination, arrêtez d'abord la navigation.", true);
      break;
    default:
      parler(`Je n'ai pas compris : ${texte}.`, true);
  }
}

// ── Le long du trajet : café, boulangerie… ajoutés comme étape ──────────────

async function chercherLeLongDuTrajet(requete) {
  const zone = $("ev-nav-recherche-res");
  zone.innerHTML = `<div class="ev-nav-carte-sous">⏳ Recherche…</div>`;
  const restant = etat.route.coords.slice(etat.idx);
  const r = await rechercherLeLongDu(getApiKeys().tomtom, restant, requete);
  if (!etat) return;
  if (!r.ok) {
    zone.innerHTML = `<div class="ev-nav-carte-sous">⚠️ ${escapeHtml(r.erreur)}</div>`;
    return;
  }
  const lieux = r.lieux
    .map((l) => ({ ...l, devant_m: projeterSurTrace(l.lat, l.lon, etat.route.coords, etat.route.cum).offset - etat.offset }))
    .filter((l) => l.devant_m > 0)
    .slice(0, 8);
  etat.lieuxTrouves = lieux;
  if (etat.parVoix) {
    etat.parVoix = false;
    if (!lieux.length) parler("Rien de trouvé devant vous.");
    else {
      const i = await choisirALaVoix("Voici ce que j'ai trouvé.", lieux, (l) => `${l.nom}, dans ${distanceParlee(l.devant_m)}, détour ${l.detour_min} minute${l.detour_min > 1 ? "s" : ""}`);
      if (etat && i >= 0) return ajouterEtape(lieux[i]);
    }
  }
  zone.innerHTML = lieux.length
    ? lieux
        .map((l, i) => `<div class="ev-nav-resultat"><div><strong>${escapeHtml(l.nom)}</strong><div class="ev-nav-carte-sous">dans ${distanceAffichee(l.devant_m)} · détour +${l.detour_min} min</div></div><button type="button" class="ev-btn" data-etape="${i}">➕ Étape</button></div>`)
        .join("")
    : `<div class="ev-nav-carte-sous">Rien de trouvé devant, à moins de 15 min de détour.</div>`;
}

async function ajouterEtape(lieu) {
  $("ev-nav-recherche").classList.add("hidden");
  const arret = { lat: lieu.lat, lon: lieu.lon, nom_borne: lieu.nom, adresse: lieu.adresse, pause: true, temps_charge_min: 0 };
  const offset = projeterSurTrace(lieu.lat, lieu.lon, etat.route.coords, etat.route.cum).offset;
  // Avant la première borne dont le tronçon se termine après le lieu.
  let k = etat.route.troncons.findIndex((t) => t.fin >= offset);
  if (k < 0 || k > etat.arretsRestants.length) k = etat.arretsRestants.length;
  etat.arretsRestants.splice(k, 0, arret);
  afficherAlerte(`📍 Ajout de l'étape ${lieu.nom}…`);
  const route = await calculerRouteNav(etat.pos, etat.pos.cap, { sansSecours: true });
  if (!etat) return;
  if (!route) {
    etat.arretsRestants.splice(etat.arretsRestants.indexOf(arret), 1);
    afficherAlerte("⚠️ Étape impossible à ajouter pour le moment (réseau ?).");
    return;
  }
  installerRoute(route);
  afficherAlerte(null);
  parler(`Étape ajoutée : ${lieu.nom}.`, true);
  majEcran();
}

// ── Parking à l'arrivée ─────────────────────────────────────────────────────

const DISTANCE_PROPOSITION_PARKING_M = 2000;
const DISTANCE_MAX_PARKING_M = 800;

async function proposerParkings(manuel = false) {
  if (!etat || (etat.parkingsProposes && !manuel)) return;
  etat.parkingsProposes = true;
  const d = etat.destinationFinale || etat.destination;
  const r = await rechercherParkings({ sud: d.lat - 0.008, nord: d.lat + 0.008, ouest: d.lon - 0.012, est: d.lon + 0.012 });
  if (!etat) return;
  const liste = (r.ok ? r.parkings : [])
    .map((p) => ({ ...p, distM: Math.round(haversineKm(d.lat, d.lon, p.lat, p.lon) * 1000) }))
    .filter((p) => p.distM <= DISTANCE_MAX_PARKING_M)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, 3);
  if (!liste.length) {
    if (manuel) afficherAlerte(r.ok ? "🅿️ Aucun parking connu près de l'arrivée." : `⚠️ Parkings : ${r.erreur}`);
    return;
  }
  etat.parkingsTrouves = liste;
  $("ev-nav-parkings-liste").innerHTML = liste
    .map((p, i) => {
      const infos = [`à ${p.distM} m à pied`, p.places != null ? `${p.places} places` : "", p.payant === "oui" ? "payant" : p.payant === "non" ? "gratuit" : "", p.places_recharge ? `⚡ ${p.places_recharge} bornes` : ""].filter(Boolean).join(" · ");
      return `<div class="ev-nav-resultat"><div><strong>🅿️ ${escapeHtml(p.nom)}</strong><div class="ev-nav-carte-sous">${escapeHtml(infos)}</div></div><button type="button" class="ev-btn" data-parking="${i}">Y aller</button></div>`;
    })
    .join("");
  $("ev-nav-parkings").classList.remove("hidden");
  const decrire = (p) => `${p.nom}, à ${p.distM} mètres de l'arrivée`;
  if (!manuel) {
    const r = await direPuisEcouter(`Vous approchez de l'arrivée. Parking le plus proche : ${decrire(liste[0])}. Voulez-vous y aller ? Dites oui ou non.`);
    if (!etat) return;
    const ok = interpreterOuiNon(r);
    if (ok === true) allerAuParking(liste[0]);
    else if (ok === false) $("ev-nav-parkings").classList.add("hidden");
  } else if (etat.parVoix) {
    etat.parVoix = false;
    const i = await choisirALaVoix("Parkings près de l'arrivée.", liste, decrire);
    if (etat && i >= 0) allerAuParking(liste[i]);
  }
}

async function allerAuParking(p) {
  $("ev-nav-parkings").classList.add("hidden");
  etat.destinationFinale ??= etat.destination;
  etat.destination = { lat: p.lat, lon: p.lon, nom: `🅿️ ${p.nom}` };
  afficherAlerte("🅿️ Direction le parking…");
  const route = await calculerRouteNav(etat.pos, etat.pos.cap, { sansSecours: true });
  if (!etat) return;
  if (route) installerRoute(route);
  afficherAlerte(null);
  parler(`Direction le parking ${p.nom}.`, true);
  majEcran();
}

// Tête haute (HUD) : téléphone posé sous le pare-brise la nuit, l'essentiel
// en grand et à l'envers pour se refléter à l'endroit. Un appui en sort.
function basculerHud(actif) {
  document.body.classList.toggle("ev-hud", actif);
  if (actif) {
    parler("Mode tête haute. Touchez l'écran pour en sortir.");
    majEcran();
  }
}

function majHud(kmh, limite) {
  const fleche = $("ev-nav-fleche").innerHTML;
  if ($("ev-hud-fleche").dataset.contenu !== fleche) {
    $("ev-hud-fleche").dataset.contenu = fleche;
    $("ev-hud-fleche").innerHTML = fleche;
  }
  $("ev-hud-distance").textContent = $("ev-nav-distance").textContent;
  $("ev-hud-texte").textContent = ($("ev-nav-rue").classList.contains("hidden") ? "" : $("ev-nav-rue").textContent) || $("ev-nav-instruction").textContent;
  $("ev-hud-vitesse").textContent = String(kmh);
  $("ev-hud-vitesse").classList.toggle("exces", !!limite && kmh > limite + 3);
  $("ev-hud-limite").textContent = limite || "";
  $("ev-hud-limite").classList.toggle("hidden", !limite);
}

// Frise du trajet restant (comme Sygic) : bouchons, travaux, zones de
// danger, bornes et arrivée, la voiture qui avance dessus.
function majFrise() {
  const el = $("ev-nav-frise");
  const route = etat.route;
  if (!route || etat.arrive || !(route.total > 0)) {
    el.classList.add("hidden");
    return;
  }
  const cle = `${route.total}|${Math.round((etat.offset / route.total) * 300)}|${route.troncons.length}|${(route.zonesDanger || []).length}`;
  if (el.dataset.cle === cle) return;
  el.dataset.cle = cle;
  const pct = (m) => Math.max(0, Math.min(100, (m / route.total) * 100));
  const bande = (a, b, classe) => `<span class="${classe}" style="left:${pct(a).toFixed(2)}%;width:${Math.max(0.8, pct(b) - pct(a)).toFixed(2)}%"></span>`;
  let html = bande(0, etat.offset, "fait");
  for (const t of route.travaux) if ((t.fin ?? t.offset) > etat.offset) html += bande(t.offset, t.fin ?? t.offset + 200, t.bouchon ? "bouchon" : "travaux");
  for (const z of route.zonesDanger || []) if (z.fin > etat.offset) html += bande(z.debut, z.fin, "danger");
  html += route.troncons
    .slice(0, -1)
    .map((t) => `<i class="borne" style="left:${pct(t.fin).toFixed(2)}%">🔋</i>`)
    .join("");
  html += `<i class="voiture" style="left:${pct(etat.offset).toFixed(2)}%"></i><i class="arrivee">🏁</i>`;
  el.innerHTML = html;
  el.classList.remove("hidden");
}

// Même fond (nuit, jour, satellite) et mêmes réglages que la carte des bornes.
function optionsCarte3D() {
  const options = carte2D.optionsCarte3D();
  // Sans réseau, seule la carte OpenFreeMap a pu être gardée.
  return navigator.onLine === false ? { ...options, fournisseur: "libre", fond: options.fond === "satellite" ? "sombre" : options.fond } : options;
}

// Fournisseur choisi refusé, l'autre a pris le relais : on le dit sans insister.
function signalerRemplacementCarte() {
  const texte = carte3D.dernierAvertissement();
  if (!texte) return;
  const message = `ℹ️ ${texte}.`;
  afficherAlerte(message, null, "info");
  setTimeout(() => {
    if (etat && $("ev-nav-alerte").textContent === message) afficherAlerte(null);
  }, 12000);
}

// Après un geste sur la carte, le guidage reprend seul au bout de ce délai
// sans nouveau geste (choix validé avec l'utilisateur le 2026-10-04).
// L'aperçu du trajet, lui, reste affiché jusqu'à « Revenir au guidage ».
const RETOUR_AUTO_SUIVI_MS = 20000;

function reprendreSuivi() {
  clearTimeout(etat.retourSuivi);
  etat.suivi = true;
  $("ev-nav-recentrer-btn").classList.add("hidden");
  $("ev-nav-recentrer-btn").textContent = "🎯 Recentrer";
  const a = etat.aff || etat.pos;
  if (a) vue.cameraNavigation(a.lat, a.lon, a.cap, zoomAffiche(a.zoom ?? etat.zoom ?? 16), etat.sensDeMarche, false);
}

function surDeplacementManuel() {
  if (!etat) return;
  clearTimeout(etat.retourSuivi);
  if (!etat.apercu) etat.retourSuivi = setTimeout(() => etat && !etat.suivi && !etat.apercu && reprendreSuivi(), RETOUR_AUTO_SUIVI_MS);
  etat.suivi = false;
  if (vue === carte2D) $("ev-nav-recentrer-btn").textContent = "🎯 Revenir au guidage";
  else $("ev-nav-recentrer-btn").textContent = "🎯 Recentrer";
  $("ev-nav-recentrer-btn").classList.remove("hidden");
}

function majBouton3D() {
  const btn = $("ev-nav-3d-btn");
  btn.textContent = vue === carte3D ? "3D" : "2D";
  btn.title = vue === carte3D ? "Vue 3D (toucher pour passer en 2D)" : "Vue 2D (toucher pour passer en 3D)";
}

// Change de carte en pleine navigation : tout ce qui est dessiné (tracé,
// bornes, voiture) est refait sur la nouvelle.
function changerVue(nouvelle) {
  if (nouvelle === vue) return;
  vue.montrerBornes(false);
  vue.quitterNavigation();
  vue = nouvelle;
  vue.entrerNavigation({ onDeplacementManuel: surDeplacementManuel });
  etat.flecheCarte = undefined;
  if (etat.route) vue.dessinerRouteNavigation(etat.route.coords, etat.arretsRestants, etat.destination);
  etat.posBornes = null;
  rafraichirBornesProches();
  etat.suivi = true;
  $("ev-nav-recentrer-btn").classList.add("hidden");
  const a = etat.aff;
  if (a && etat.route) {
    vue.majVoiture(a.lat, a.lon, a.cap);
    vue.cameraNavigation(a.lat, a.lon, a.cap, zoomAffiche(a.zoom), etat.sensDeMarche, false);
    vue.majProgressionNavigation(etat.route.coords, etat.idx, a.lat, a.lon);
  }
  majBouton3D();
}

async function basculerVue() {
  if (!etat || etat.basculeEnCours) return;
  const vers3D = vue !== carte3D;
  if (vers3D && etat.prefs.modeEco) {
    afficherAlerte("🔋 Mode éco actif : la 3D reste désactivée pour économiser la batterie. Désactive le mode éco dans Profil pour la retrouver.", null, "info");
    return;
  }
  etat.basculeEnCours = true;
  sauverReglages({ vue_3d: vers3D });
  let nouvelle = carte2D;
  if (vers3D) {
    $("ev-nav-3d-btn").textContent = "…";
    if (await carte3D.preparer(optionsCarte3D())) {
      nouvelle = carte3D;
      signalerRemplacementCarte();
    } else afficherAlerte(`⚠️ Vue 3D indisponible : ${carte3D.derniereErreur() || "raison inconnue"}. On reste en 2D.`);
  }
  if (!etat) return;
  etat.basculeEnCours = false;
  changerVue(nouvelle);
  majBouton3D();
}

// La 3D tombe en panne en route : on repasse en 2D sans changer la
// préférence (la 3D sera retentée au prochain trajet).
carte3D.definirSurPanne((raison) => {
  if (!etat || vue !== carte3D) return;
  changerVue(carte2D);
  noter("carte", `3D interrompue : ${raison}`);
  const texte = `⚠️ Vue 3D interrompue (${raison}) : passage en 2D. Touchez « 2D » pour réessayer.`;
  afficherAlerte(texte);
  setTimeout(() => {
    if (etat && $("ev-nav-alerte").textContent === texte) afficherAlerte(null);
  }, 15000);
});

export function navigationActive() {
  return !!etat;
}

// plan : résultat du planificateur ; options : réglages du trajet ;
// onReplanifier(depart, chargePct) -> nouveau plan ; onFin() à l'arrêt.
export async function demarrerNavigation(plan, { options = {}, demo = false, chargeDepartPct, onReplanifier, onFin } = {}) {
  if (etat) return;
  if (!getApiKeys().tomtom) {
    alert("Clé TomTom manquante : ajoute-la dans Menu › Clés API.");
    return;
  }
  cablerBoutons();
  noter("nav", `navigation démarrée${demo ? " (démo)" : ""}, ${plan.distance_km ?? "?"} km, ${(plan.arrets || []).length} borne(s)`);
  const reglages = lireReglages();
  etat = {
    plan,
    options,
    demo,
    onReplanifier,
    onFin,
    destination: { lat: plan.to_lat, lon: plan.to_lon, nom: plan.to_name },
    arretsRestants: [...(plan.arrets || [])],
    route: null,
    pos: null,
    idx: 0,
    offset: 0,
    odometre: 0,
    horsRoute: 0,
    dernierRecalcul: 0,
    dernierTrafic: Date.now(),
    dernierFetchBornes: 0,
    alerteMiParcoursFaite: false,
    indiceTrace: 0,
    posBornes: null,
    jetonBornes: 0,
    annoncesBornes: new Set(),
    annoncesTravaux: new Set(),
    // Routes coupées marquées avant le départ, puis celles signalées avec 🚧.
    zonesEvitees: rectanglesZonesEvitees(),
    radars: null,
    feuxConnus: new Map(),
    manoeuvresFeux: new Set(),
    carrefours: new Map(),
    mesuresBatterie: [{ km: 0, pct: chargeDepartPct ?? 80 }],
    kmTypes: { ville: 0, route: 0, autoroute: 0 },
    energieCumulee: 0,
    consoAppriseParType: consoParType(),
    traceRoulee: [],
    tempsRechargeMs: 0,
    coutRecharges: 0,
    rappelsFaits: new Set(),
    alertesMeteo: new Set(),
    radarsAnnonces: new Set(),
    airesOsm: null,
    debut: Date.now(),
    kmPlan: 0,
    pctDepartPlan: chargeDepartPct ?? 80,
    carrefoursDemandes: new Set(),
    capacite: obtenirProfilVehicule().capacite_kwh,
    consoKwhKm: (plan.energie_totale_necessaire_kwh || 13) / Math.max(1, plan.distance_km),
    margePct: options.marge_pct ?? plan.arrets?.[0]?.pct_arrivee_borne ?? 12,
    batterie: { refPct: chargeDepartPct ?? 80, refOdometre: 0 },
    voix: reglages.voix_guidage !== false,
    prefs: {
      voixVoies: reglages.voix_voies !== false,
      voixTravaux: reglages.voix_travaux !== false,
      voixBornes: reglages.voix_bornes !== false,
      bip: reglages.bip_vitesse !== false,
      zoomRenforce: reglages.zoom_renforce !== false,
      dangers: reglages.zones_danger !== false,
      feux: reglages.feux !== false,
      fenetreVoies: reglages.fenetre_voies !== false,
      vueCarrefour: reglages.vue_carrefour !== false,
      parkingArrivee: reglages.parking_arrivee !== false,
      meteo: reglages.meteo_route !== false,
      aires: reglages.aires_autoroute !== false,
      epure: reglages.ecran_epure !== false,
      vibration: reglages.vibration === true,
      nuitDouce: reglages.nuit_douce !== false,
      notifGuidage: reglages.notif_guidage !== false,
      reponsesVoix: reglages.reponses_voix !== false,
      prechauffage: reglages.prechauffage !== false,
      pauseMiParcours: reglages.pause_mi_parcours !== false,
      modeEco: reglages.mode_eco === true,
      decalageZoom: Number(reglages.decalage_zoom_nav) || 0,
    },
    sensDeMarche: true,
    suivi: true,
  };

  document.body.classList.add("ev-mode-navigation");
  document.body.classList.toggle("ev-mode-voiture", reglages.mode_voiture === true);
  document.body.classList.toggle("ev-bandeau-compact", reglages.taille_bandeau !== "grand");
  document.documentElement.style.setProperty("--echelle-nav", String((reglages.taille_texte_nav || 100) / 100));
  reveillerBoutons();
  carte2D.definirIconeVoiture(reglages.icone_voiture);
  carte3D.definirInclinaison3D(reglages.inclinaison_3d ?? 70);
  carte3D.definirInclinaisonPlate(reglages.inclinaison_ronds_points ?? 40);
  carte3D.definirIconeVoiture(reglages.icone_voiture);
  $("ev-nav-menu").classList.add("hidden");
  $("ev-nav-frise").classList.add("hidden");
  $("ev-nav-recherche").classList.add("hidden");
  $("ev-nav-borne-perso").classList.add("hidden");
  $("ev-nav-parkings").classList.add("hidden");
  $("ev-nav-secours").classList.add("hidden");
  $("ev-nav-feuille").classList.add("hidden");
  $("ev-nav-point").classList.add("hidden");
  carte2D.definirAppuiLong(surAppuiLong);
  demanderPermissionNotifications();
  $("ev-nav-recherche-res").innerHTML = "";
  $("ev-navigation").classList.remove("hidden");
  $("ev-nav-etape-borne").classList.add("hidden");
  $("ev-nav-batterie-panneau").classList.add("hidden");
  $("ev-nav-recentrer-btn").classList.add("hidden");
  $("ev-nav-voix-btn").innerHTML = icone(etat.voix ? "son" : "muet");
  majBoutonOrientation();
  $("ev-nav-fleche").textContent = "⏳";
  $("ev-nav-rue").classList.add("hidden");
  $("ev-nav-danger").classList.add("hidden");
  $("ev-nav-vue-voies").classList.add("hidden");
  $("ev-nav-distance").textContent = "";
  $("ev-nav-instruction").textContent = "Calcul du guidage…";
  afficherAlerte(null);
  history.pushState({ navigation: true }, "");
  // Mode éco : la 2D (Leaflet, tuiles raster simples) consomme bien moins
  // de batterie que la 3D (WebGL, bâtiments en relief, caméra animée en
  // continu) -- le tracé, la flèche et le guidage restent tout aussi
  // visibles, seul le rendu change. Demande explicite de l'utilisateur.
  const veut3D = lireReglages().vue_3d !== false && !etat.prefs.modeEco;
  if (veut3D) $("ev-nav-instruction").textContent = "Préparation de la vue 3D…";
  vue = veut3D && (await carte3D.preparer(optionsCarte3D())) ? carte3D : carte2D;
  if (!etat) return;
  majBouton3D();
  if (veut3D && vue === carte2D) afficherAlerte(`⚠️ Vue 3D indisponible : ${carte3D.derniereErreur() || "raison inconnue"}. Navigation en 2D.`);
  else if (vue === carte3D) signalerRemplacementCarte();
  $("ev-nav-instruction").textContent = "Calcul du guidage…";
  vue.entrerNavigation({ onDeplacementManuel: surDeplacementManuel });
  garderEcranAllume();

  // Position de départ : GPS réel, ou début du trajet en démo
  const depart = demo
    ? { lat: plan.from_lat, lon: plan.from_lon, vitesse: 0, cap: NaN, precision: 5, t: Date.now() }
    : await new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, vitesse: p.coords.speed ?? NaN, cap: p.coords.heading ?? NaN, precision: p.coords.accuracy, t: p.timestamp }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
        ),
      );
  if (!depart) {
    afficherAlerte("⚠️ Position GPS introuvable. Autorise la localisation, ou essaie le mode démo.");
    $("ev-nav-instruction").textContent = "En attente du GPS…";
    return;
  }
  if (!etat) return;
  etat.pos = depart;
  const route = await calculerRouteNav(depart, depart.cap);
  if (!etat) return;
  if (!route) {
    afficherAlerte(
      navigator.onLine
        ? "⚠️ Impossible de calculer le guidage (clé TomTom ou réseau)."
        : "⚠️ Pas de réseau, et ce trajet n'a pas été préparé pour le hors ligne : le guidage ne peut pas démarrer. Prépare-le avec « 📥 Hors ligne » quand tu as du réseau.",
      { libelle: "Arrêter", action: () => arreterNavigation() },
    );
    return;
  }
  installerRoute(route);
  // Parti sans réseau avec le guidage enregistré : dire tout de suite ce qui manquera.
  if (etat.guidageEnregistre) afficherAlerte("📡 Sans réseau : guidage enregistré utilisé. Pas de nouvel itinéraire si tu quittes la route, ni trafic, ni état des bornes.", null, "info");
  chercherRadars();
  chercherAires();
  surveillerBatterieTelephone();
  garderPourHorsLigne();
  const premiere = route.instructions.find((i) => i.type !== "LOCATION_DEPARTURE");
  parler(`C'est parti. ${premiere ? premiere.message : ""}`, true);
  if (demo) demarrerDemo();
  else {
    demarrerGps();
    etat.minuteurSauvegarde = setInterval(sauverNavigation, INTERVALLE_SAUVEGARDE_MS);
    window.addEventListener("pagehide", sauverNavigation);
  }
  surPosition({ ...depart, t: Date.now() });
}

// ── Reprise après coupure ───────────────────────────────────────────────────
// Appel, écran verrouillé, appli fermée par Android : la navigation en cours
// est gardée (hors clé « trajetve_ » : pas dans les sauvegardes), et proposée
// à la réouverture pendant un moment.

const INTERVALLE_SAUVEGARDE_MS = 15000;

function sauverNavigation() {
  if (!etat || etat.demo || etat.arrive) return;
  // Ce qui reste vraiment à faire : bornes (remplacées ou ajoutées comprises)
  // et destination actuelle.
  enregistrerReprise({
    plan: etat.plan,
    options: etat.options,
    arrets_restants: etat.arretsRestants,
    destination: etat.destination,
    destination_finale: etat.destinationFinale || null,
    batterie_pct: Math.round(batterieEstimee()),
  });
}

export function oublierNavigationInterrompue() {
  oublierReprise();
}

// { plan, options, batterie_pct, destination, age_ms, automatique } si une
// navigation a été coupée récemment, sinon null.
export function navigationInterrompue() {
  return lireReprise();
}

export function arreterNavigation({ depuisRetour = false } = {}) {
  if (!etat) return;
  arreterPartagePosition(false);
  noter("nav", `navigation arrêtée à ${Math.round(etat.odometre / 1000)} km`);
  clearInterval(etat.minuteurSauvegarde);
  clearInterval(etat.minuteurRechargeId);
  window.removeEventListener("pagehide", sauverNavigation);
  oublierNavigationInterrompue();
  if (etat.watchId !== undefined) navigator.geolocation.clearWatch(etat.watchId);
  clearInterval(etat.surveillanceSignal);
  clearTimeout(etat.retourSuivi);
  $("ev-nav-gps")?.classList.add("hidden");
  if (etat.demoTimer) clearInterval(etat.demoTimer);
  if (etat.raf) cancelAnimationFrame(etat.raf);
  try {
    etat.wakeLock?.release();
  } catch {
    /* déjà relâché */
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  // Statistiques : trajet réellement roulé (pas la démo, pas un faux départ).
  if (!etat.demo && etat.odometre > 1000) {
    const km = etat.odometre / 1000;
    if (etat.traceRoulee.length >= 2) ajouterTrace({ destination: (etat.destinationFinale || etat.destination).nom || "", km: Math.round(km * 10) / 10, coords: etat.traceRoulee });
    ajouterTrajetFait({ km: Math.round(km * 10) / 10, kwh: Math.round(km * etat.consoKwhKm * 10) / 10, duree_min: Math.round((Date.now() - etat.debut) / 60000), destination: (etat.destinationFinale || etat.destination).nom || "" });
  }
  const onFin = etat.onFin;
  const plan = etat.plan;
  etat = null;
  vue.montrerBornes(false);
  vue.quitterNavigation();
  document.body.classList.remove("ev-mode-navigation", "ev-mode-voiture", "ev-bandeau-compact", "ev-hud", "ev-nav-calme", "ev-nav-epure", "ev-nuit-douce", "ev-eco");
  carte2D.definirAppuiLong(null);
  navigator.serviceWorker?.getRegistration?.().then((reg) => reg?.getNotifications({ tag: "guidage" }).then((l) => l.forEach((n) => n.close())));
  $("ev-navigation").classList.add("hidden");
  if (!depuisRetour && history.state?.navigation) {
    retourEnCours = true;
    history.back();
  }
  onFin?.(plan);
}

// Le "retour" déclenché par l'arrêt de la navigation ne doit pas être pris
// par l'interface pour un appui sur le bouton retour d'Android.
let retourEnCours = false;
export function retourNavigationEnCours() {
  const r = retourEnCours;
  retourEnCours = false;
  return r;
}
