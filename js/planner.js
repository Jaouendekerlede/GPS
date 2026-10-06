// Algorithme de planification de trajet électrique -- porté tel quel
// depuis jarvis_ev_charge_runtime.calculer_trajet_electrique() et ses
// fonctions de score/confiance associées.

import {
  MULTIPLICATEURS_SAISON,
  FACTEUR_RALENTISSEMENT_DC,
  SEUIL_PUISSANCE_DC_KW,
  MARGE_SECURITE_PCT_DEFAUT,
  CIBLE_RECHARGE_PCT_DEFAUT,
  RESERVE_DERNIER_ARRET_PCT,
  MAX_ARRETS,
  PRIX_KWH_ESTIME_DEFAUT_EUR,
  MULTIPLICATEUR_CHARGE_LOURDE,
  MODES_TRAJET,
  PUISSANCE_LENTE_KW,
} from "./config.js";
import { pointADistanceSurTrace, haversineKm } from "./geo.js";
import { projeterSurTrace } from "./alertes-route.js";

// Une borne d'aire d'autoroute située de l'autre côté (à gauche du sens de
// marche) oblige à sortir puis à faire demi-tour très loin : mesuré sur
// Saint-Nazaire → Bordeaux, +46 km et +25 min pour une seule aire.
const PENALITE_AUTRE_SENS_MIN = 25;
const NOM_AXE_RAPIDE = /(\bA\s?\d{1,3}\b|\baire\b|autoroute|direction|péage|\bN\s?\d{1,3}\b)/i;
const ECART_AUTRE_SENS_M = [25, 700];

// Plafond de charge d'un arrêt qui évite d'en faire un de plus.
const PLAFOND_CHARGE_UN_ARRET_PCT = 98;

// Position (km depuis le départ) du point du tracé le plus proche, et
// l'écart (km) entre ce point et le lieu.
export function kmSurTrace(coords, lat, lon) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.54;
  let cumul = 0;
  let meilleur = { km: 0, ecartKm: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    const longueur = haversineKm(latA, lonA, latB, lonB);
    // Projection sur le segment (en km, localement plan).
    const ax = (lonA - lon) * kx;
    const ay = (latA - lat) * ky;
    const dx = (lonB - lonA) * kx;
    const dy = (latB - latA) * ky;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < meilleur.ecartKm) meilleur = { km: cumul + t * longueur, ecartKm: d };
    cumul += longueur;
  }
  return meilleur;
}
import { rechercherBornesProches, borneCompatible } from "./ocm.js";

export function consommationEffectiveKwh100km(profil) {
  const multiplicateur = MULTIPLICATEURS_SAISON[profil.saison] ?? 1.0;
  return profil.consommation_kwh_100km * multiplicateur;
}

export function typesDeCharge(profil) {
  return {
    lente: { label: "Lente (prise domestique)", puissance_kw: PUISSANCE_LENTE_KW },
    domicile: { label: "Borne à domicile", puissance_kw: profil.puissance_domicile_kw || 7.4 },
    normale: { label: "Normale (borne AC)", puissance_kw: profil.puissance_ac_kw },
    rapide: { label: "Rapide (borne DC)", puissance_kw: profil.puissance_dc_kw },
  };
}

export function formaterMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

export function exporterTrajetTexte(r) {
  const lignes = [
    `Trajet électrique : ${r.from_name} -> ${r.to_name}`,
    "=".repeat(60),
    `Distance : ${r.distance_km} km`,
    `Durée de route : ${r.duree_text}`,
    `Arrêt(s) de recharge : ${r.nb_arrets ?? 0}`,
  ];
  if (r.duree_totale_min != null) lignes.push(`Temps total (route + charge) : ${formaterMinutes(r.duree_totale_min)}`);
  lignes.push(`Batterie à l'arrivée : ${r.pct_batterie_arrivee}%`);
  if (r.confiance) lignes.push(`Indice de confiance : ${r.confiance.score}/100`);
  lignes.push("");
  const arrets = r.arrets || [];
  if (arrets.length) {
    lignes.push("Arrêts détaillés :", "-".repeat(60));
    for (const a of arrets) {
      lignes.push(`${a.numero}. ${a.nom_borne} (km ${a.km_depuis_depart})`);
      lignes.push(`   ${a.adresse || ""}`);
      lignes.push(`   +${a.kwh_ajoutes} kWh, ${a.temps_charge_min} min, ${a.pct_arrivee_borne}% -> ${a.pct_depart_borne}%`);
      if (a.cout_estime_eur != null) lignes.push(`   Coût estimé : ${a.cout_estime_eur} €${a.prix_est_estimation ? " (estimation)" : ""}`);
      lignes.push(`   https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lon}`);
      lignes.push("");
    }
  }
  return lignes.join("\n");
}

export function exporterScenariosTexte(depart, destination, scenarios) {
  const lignes = [`Comparaison de scénarios : ${depart} -> ${destination}`, "=".repeat(60), ""];
  for (const [mode, r] of Object.entries(scenarios)) {
    lignes.push(`[${mode.toUpperCase()}]`);
    if (!r.ok) {
      lignes.push(`  Erreur : ${r.erreur}`);
    } else {
      lignes.push(`  Temps total : ${formaterMinutes(r.duree_totale_min ?? 0)}`);
      lignes.push(`  Coût estimé : ${r.cout_total_eur} €`);
      lignes.push(`  Arrêts : ${r.nb_arrets}`);
      lignes.push(`  Batterie à l'arrivée : ${r.pct_batterie_arrivee}%`);
      lignes.push(`  Confiance : ${r.confiance?.score ?? "?"}/100`);
    }
    lignes.push("");
  }
  return lignes.join("\n");
}

// Courbe de charge rapide typique (part de la puissance maximale de la
// voiture selon la batterie) : presque pleine puissance jusqu'à ~35 %, puis
// la voiture ralentit pour protéger la batterie. En moyenne ~75 % du
// maximum entre 10 et 80 % : avec la vraie puissance maximale de la voiture
// dans le profil (ex. Kona 64 kWh : 77 kW), on retrouve les temps annoncés
// par les constructeurs (Kona : 10 → 80 % en ~47 min).
const COURBE_CHARGE_DC = [
  [0, 0.75],
  [10, 0.95],
  [35, 0.95],
  [50, 0.8],
  [60, 0.68],
  [70, 0.55],
  [80, 0.42],
  [90, 0.25],
  [100, 0.1],
];
// Pertes (chauffage de la batterie, conversion) en charge lente.
const PERTES_CHARGE_AC = 1.08;

function facteurCourbe(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (let i = 1; i < COURBE_CHARGE_DC.length; i++) {
    const [x1, y1] = COURBE_CHARGE_DC[i];
    if (p <= x1) {
      const [x0, y0] = COURBE_CHARGE_DC[i - 1];
      return y0 + ((y1 - y0) * (p - x0)) / (x1 - x0);
    }
  }
  return COURBE_CHARGE_DC[COURBE_CHARGE_DC.length - 1][1];
}

// Minutes pour ajouter kwhAAjouter sur une borne de puissanceBorneKw.
// Avec la batterie de départ et le véhicule (profil), on suit la courbe de
// charge et la limite du chargeur embarqué en courant alternatif ; sans, on
// garde l'ancienne estimation (puissance constante, ×1,5 en charge rapide).
export function calculerTempsCharge(kwhAAjouter, puissanceBorneKw, { pctDebut, profil } = {}) {
  if (puissanceBorneKw <= 0 || kwhAAjouter <= 0) return 0;
  if (pctDebut == null || !profil?.capacite_kwh) {
    let minutes = (kwhAAjouter / puissanceBorneKw) * 60;
    if (puissanceBorneKw >= SEUIL_PUISSANCE_DC_KW) minutes *= FACTEUR_RALENTISSEMENT_DC;
    return minutes;
  }
  if (puissanceBorneKw < SEUIL_PUISSANCE_DC_KW) {
    const kw = Math.min(puissanceBorneKw, profil.puissance_ac_kw || puissanceBorneKw);
    return (kwhAAjouter / kw) * 60 * PERTES_CHARGE_AC;
  }
  // Intégration par pas de 1 % de batterie.
  const capacite = profil.capacite_kwh;
  const maxVehicule = profil.puissance_dc_kw || puissanceBorneKw;
  let restant = kwhAAjouter;
  let pct = pctDebut;
  let minutes = 0;
  while (restant > 1e-6) {
    const kwh = Math.min(restant, capacite / 100);
    const kw = Math.max(1, Math.min(puissanceBorneKw, maxVehicule * facteurCourbe(pct + 0.5)));
    minutes += (kwh / kw) * 60;
    restant -= kwh;
    pct += (kwh / capacite) * 100;
  }
  // Appris sur vos recharges (durée réelle / durée calculée).
  return minutes * (profil.facteur_charge_appris || 1);
}

export function comparerCoutDomicilePublic(kwhACharger, profil, prixPublicEurKwh) {
  const arrondi2 = (x) => Math.round(x * 100) / 100;
  const prixDomicile = profil.prix_domicile_eur_kwh ?? 0.2;
  const coutDomicile = arrondi2(kwhACharger * prixDomicile);
  const coutPublic = arrondi2(kwhACharger * prixPublicEurKwh);
  return {
    kwh: Math.round(kwhACharger * 10) / 10,
    prix_domicile_eur_kwh: prixDomicile,
    prix_hc_eur_kwh: profil.prix_hc_eur_kwh,
    prix_hp_eur_kwh: profil.prix_hp_eur_kwh,
    part_hc_pct: profil.part_hc_pct,
    prix_public_eur_kwh: prixPublicEurKwh,
    cout_domicile_eur: coutDomicile,
    cout_hc_eur: profil.prix_hc_eur_kwh != null ? arrondi2(kwhACharger * profil.prix_hc_eur_kwh) : null,
    cout_hp_eur: profil.prix_hp_eur_kwh != null ? arrondi2(kwhACharger * profil.prix_hp_eur_kwh) : null,
    cout_public_eur: coutPublic,
    economie_eur: arrondi2(coutPublic - coutDomicile),
  };
}

function calculerScoreBorne(borne, profil, mode, preferCb = false) {
  const poids = MODES_TRAJET[mode] || MODES_TRAJET.confort;
  const details = [];
  let score = 50;

  const distance = borne.distance_km || 0;
  const pointsDistance = Math.max(-10, 15 - Math.round(distance * 2));
  score += pointsDistance;
  details.push({ label: `Détour/distance (${distance} km)`, points: pointsDistance });

  const puissance = borne.puissance_max_kw || 0;
  const ratioPuissance = profil.puissance_dc_kw ? Math.min(1.5, puissance / profil.puissance_dc_kw) : 0;
  const pointsPuissance = Math.round(ratioPuissance * 20 * poids.poids_puissance);
  score += pointsPuissance;
  details.push({ label: `Puissance (${puissance} kW)`, points: pointsPuissance });

  const nbPoints = borne.nombre_points || 1;
  const pointsNb = Math.min(10, nbPoints * 2);
  score += pointsNb;
  details.push({ label: `Nombre de points (${nbPoints})`, points: pointsNb });

  const statutOk = (borne.statut || "").toLowerCase().includes("operational");
  const pointsStatut = statutOk ? 15 : -20;
  score += pointsStatut;
  details.push({ label: `Statut déclaré (${borne.statut})`, points: pointsStatut });

  if (!borne.prix_est_estimation) {
    const pointsPrix = Math.round(5 * poids.poids_cout);
    score += pointsPrix;
    details.push({ label: "Tarif réel communiqué (pas une estimation)", points: pointsPrix });
  } else if (poids.poids_cout > 1.2) {
    score -= 3;
    details.push({ label: "Tarif non communiqué (estimation incertaine)", points: -3 });
  }

  if (borne.fraicheur?.niveau === "ancien") {
    score -= 5;
    details.push({ label: "Information ancienne sur cette borne", points: -5 });
  }

  // Points déclarés hors service par l'opérateur (base nationale).
  const etat = borne.etat_dynamique;
  if (etat?.tous_hors_service) {
    score -= 60;
    details.push({ label: "Tous les points déclarés hors service", points: -60 });
  } else if (etat?.hors_service) {
    const pts = -Math.min(15, Math.round((etat.hors_service / etat.total) * 20));
    score += pts;
    details.push({ label: `${etat.hors_service} point(s) sur ${etat.total} déclaré(s) hors service`, points: pts });
  }

  if (preferCb) {
    const cb = borne.officiel?.paiement_cb;
    if (cb === "oui") {
      score += 15;
      details.push({ label: "Carte bancaire acceptée (déclaration officielle)", points: 15 });
    } else if (cb === "partiel") {
      score += 5;
      details.push({ label: "Carte bancaire sur une partie des points (déclaration officielle)", points: 5 });
    } else if (cb === "non") {
      score -= 15;
      details.push({ label: "Carte bancaire non acceptée (déclaration officielle)", points: -15 });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, details };
}

function calculerIndiceConfiance(resultat) {
  const details = [];
  let score = 60;

  const pctArrivee = resultat.pct_batterie_arrivee ?? 0;
  let pts = pctArrivee >= 30 ? 15 : pctArrivee >= 15 ? 5 : -15;
  score += pts;
  details.push({ label: `Marge de batterie à l'arrivée (${pctArrivee}%)`, points: pts });

  const arrets = resultat.arrets || [];
  if (!arrets.length) {
    score += 20;
    details.push({ label: "Trajet direct, aucune recharge nécessaire", points: 20 });
  } else {
    for (const a of arrets) {
      const niveau = a.fraicheur?.niveau;
      pts = niveau === "recent" ? 5 : niveau === "ancien" ? -8 : -3;
      score += pts;
      details.push({ label: `Fraîcheur des données (${a.nom_borne})`, points: pts });
      if (a.alternatives?.length) {
        score += 5;
        details.push({ label: `Plan B disponible pour ${a.nom_borne}`, points: 5 });
      } else {
        score -= 10;
        details.push({ label: `Aucune alternative trouvée pour ${a.nom_borne}`, points: -10 });
      }
      if (a.prix_est_estimation) {
        score -= 2;
        details.push({ label: `Tarif non confirmé (${a.nom_borne})`, points: -2 });
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, details };
}

// Algorithme glouton : roule jusqu'à la marge de sécurité, cherche la
// meilleure borne réelle à proximité, recharge jusqu'à la cible,
// recommence -- même algorithme que JARVIS. `options.energie` (voir
// energie.js) donne l'énergie consommée le long du tracé : avec une
// consommation constante, on retrouve exactement les calculs de JARVIS ;
// avec le calcul détaillé, vitesse, relief et météo sont pris en compte.
export async function calculerTrajetElectrique(ocmApiKey, distanceKm, coords, chargeActuellePct, profil, options = {}) {
  const margeSecuritePct = options.margeSecuritePct ?? MARGE_SECURITE_PCT_DEFAUT;
  const cibleRechargePct = options.cibleRechargePct ?? CIBLE_RECHARGE_PCT_DEFAUT;
  const puissanceMinKw = options.puissanceMinKw ?? 0;
  const seuilCoutEur = options.seuilCoutEur ?? null;
  const mode = options.mode ?? "confort";
  const chargeLourde = options.chargeLourde ?? false;
  const correctionMeteoMultiplicateur = options.correctionMeteoMultiplicateur ?? null;

  let energie = options.energie;
  if (!energie) {
    let consommation = correctionMeteoMultiplicateur
      ? correctionMeteoMultiplicateur * profil.consommation_kwh_100km
      : consommationEffectiveKwh100km(profil);
    if (chargeLourde) consommation *= MULTIPLICATEUR_CHARGE_LOURDE;
    energie = {
      energieA: (d) => (d * consommation) / 100,
      distanceMax: (d0, budget) => (budget <= 0 ? d0 : d0 + (budget / consommation) * 100),
    };
  }

  const capacite = profil.capacite_kwh;
  const margeKwh = (capacite * margeSecuritePct) / 100;
  const energieTotaleNecessaireKwh = energie.energieA(distanceKm);
  const consoMoyenne = Math.max(0.1, (energieTotaleNecessaireKwh / Math.max(distanceKm, 0.1)) * 100);
  const pctConsomme = (d0, d1) => ((energie.energieA(d1) - energie.energieA(d0)) / capacite) * 100;
  const atteignable = (d0, pct) => energie.distanceMax(d0, (capacite * pct) / 100 - margeKwh);

  const base = {
    autonomie_totale_km: Math.round((capacite / consoMoyenne) * 100),
    energie_totale_necessaire_kwh: Math.round(energieTotaleNecessaireKwh * 10) / 10,
  };

  if (atteignable(0, chargeActuellePct) >= distanceKm) {
    const pctArrivee = chargeActuellePct - pctConsomme(0, distanceKm);
    const resultatDirect = {
      ok: true,
      arrets: [],
      nb_arrets: 0,
      pct_batterie_arrivee: Math.round(pctArrivee * 10) / 10,
      temps_charge_total_min: 0,
      cout_total_eur: 0,
      depasse_seuil_cout: false,
      comparaison_domicile: comparerCoutDomicilePublic(energieTotaleNecessaireKwh, profil, PRIX_KWH_ESTIME_DEFAUT_EUR),
      ...base,
    };
    resultatDirect.confiance = calculerIndiceConfiance(resultatDirect);
    return resultatDirect;
  }

  const arrets = [];
  let distanceParcourue = 0;
  let chargePct = chargeActuellePct;
  const connecteursAcceptes = profil.connecteurs_acceptes?.length ? profil.connecteurs_acceptes : ["CCS", "Type 2"];

  // Borne d'axe rapide (nom d'aire, d'autoroute ou « direction … ») située à
  // gauche du sens de marche, à quelques centaines de mètres au plus.
  let cumulTrace = null;
  function estDeLAutreSens(b) {
    if (!NOM_AXE_RAPIDE.test(`${b.nom || ""} ${b.adresse || ""}`)) return false;
    if (!cumulTrace) {
      cumulTrace = [0];
      for (let i = 1; i < coords.length; i++) cumulTrace.push(cumulTrace[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]) * 1000);
    }
    const p = projeterSurTrace(b.lat, b.lon, coords, cumulTrace);
    return !!p.gauche && p.d >= ECART_AUTRE_SENS_M[0] && p.d <= ECART_AUTRE_SENS_M[1];
  }

  // Bornes compatibles, enrichies et notées autour d'un point du tracé ;
  // { erreur } si la recherche échoue ou ne trouve rien d'utilisable.
  async function candidatsAutour(km) {
    const point = pointADistanceSurTrace(coords, km);
    if (!point) return { erreur: "Impossible de localiser un point de recharge sur le tracé." };
    let recherche = await rechercherBornesProches(ocmApiKey, point.lat, point.lon);
    // Bornes rapides de la base officielle (absentes d'Open Charge Map, ou
    // si Open Charge Map est indisponible).
    if (options.bornesSupplementaires) {
      const extra = await options.bornesSupplementaires(point.lat, point.lon);
      if (extra.length) {
        const fusion = options.fusionner(recherche.ok ? recherche.bornes : [], extra).slice(0, 15);
        recherche = { ok: true, bornes: fusion, erreur: null };
      }
    }
    if (!recherche.ok) {
      if (recherche.erreur === "cle_manquante") return { erreur: "La recherche de bornes nécessite une clé Open Charge Map (gratuite sur openchargemap.org).", bloquant: true };
      return { erreur: `Service de recherche de bornes indisponible (${recherche.erreur}).`, bloquant: true };
    }
    if (!recherche.bornes.length) return { erreur: `Aucune borne de recharge trouvée à proximité du km ${Math.round(km)}, même en élargissant la recherche.` };
    let candidates = recherche.bornes.filter((b) => borneCompatible(b, connecteursAcceptes));
    if (puissanceMinKw > 0) candidates = candidates.filter((b) => (b.puissance_max_kw || 0) >= puissanceMinKw);
    // Bornes signalées en panne par l'utilisateur : ni arrêt, ni plan B.
    if (options.estExclue) candidates = candidates.filter((b) => !options.estExclue(b));
    if (!candidates.length) return { erreur: `Aucune borne compatible (connecteur/puissance) trouvée à proximité du km ${Math.round(km)}.` };
    if (options.enrichirBornes) await options.enrichirBornes(candidates);
    for (const b of candidates) b._score_info = calculerScoreBorne(b, profil, mode, !!options.preferCb);
    for (const b of candidates) b._autre_sens = estDeLAutreSens(b);
    candidates.sort((a, b) => b._score_info.score - a._score_info.score);
    return { candidates };
  }

  // Recharge à cette borne si l'on s'y arrête au km `km` : batterie à
  // l'arrivée, niveau de départ (juste le nécessaire au dernier arrêt),
  // énergie, puissance reçue et durée selon la courbe de charge.
  function planArret(borne, km) {
    const pctArrivee = Math.round((chargePct - pctConsomme(distanceParcourue, km)) * 10) / 10;
    // Dernier arrêt (la cible suffit pour finir) : charger jusqu'à la cible
    // ferait arriver très chargé après une longue attente, souvent sur une
    // borne lente près de l'arrivée.
    const besoinFinPct = Math.ceil(margeSecuritePct + pctConsomme(km, distanceKm) + RESERVE_DERNIER_ARRET_PCT);
    let pctDepart = atteignable(km, cibleRechargePct) >= distanceKm ? Math.min(cibleRechargePct, Math.max(pctArrivee + 1, besoinFinPct)) : cibleRechargePct;
    // Aire préférée plus loin : juste de quoi l'atteindre (on rechargera là-bas).
    if (kmImpose !== null && kmImpose > km && atteignable(km, cibleRechargePct) >= kmImpose) {
      const besoinAirePct = Math.ceil(margeSecuritePct + pctConsomme(km, kmImpose) + RESERVE_DERNIER_ARRET_PCT);
      pctDepart = Math.min(pctDepart, Math.max(pctArrivee + 1, besoinAirePct));
    }
    // Puissance réellement reçue : borne rapide limitée par la voiture en
    // courant continu, borne lente par son chargeur embarqué (alternatif).
    const kwBorne = borne.puissance_max_kw || profil.puissance_dc_kw;
    const rapide = kwBorne >= SEUIL_PUISSANCE_DC_KW;
    const puissanceKw = Math.min(kwBorne, rapide ? profil.puissance_dc_kw : profil.puissance_ac_kw || kwBorne);
    const construire = (pctDep) => {
      const kwh = Math.max(0, (profil.capacite_kwh * (pctDep - pctArrivee)) / 100);
      return { km, pctArrivee, pctDepart: pctDep, kwh, puissanceKw, tempsMin: calculerTempsCharge(kwh, kwBorne, { pctDebut: pctArrivee, profil }) };
    };
    const plan = construire(pctDepart);
    // La cible ne suffit pas pour finir, mais un peu plus haut (jusqu'à 98 %)
    // évite un arrêt de plus : on garde le plus rapide des deux (la charge
    // ralentit vers la fin, mais un arrêt de plus coûte ~12 min de plus).
    const finiraitApres = kmImpose === null || kmImpose <= km;
    if (finiraitApres && atteignable(km, cibleRechargePct) < distanceKm && besoinFinPct > pctDepart && besoinFinPct <= PLAFOND_CHARGE_UN_ARRET_PCT) {
      const haut = construire(besoinFinPct);
      const coutSupplementaireMin = Math.round(haut.tempsMin + futurMinDe(haut) - (plan.tempsMin + futurMinDe(plan)));
      if (coutSupplementaireMin < -1) return haut;
      // Chargé plus haut ici, l'arrêt suivant aurait été inutile -- mais ça
      // aurait pris plus longtemps au total (fin de charge lente) : on le
      // garde pour l'expliquer à l'écran plutôt que de laisser deviner
      // pourquoi ce n'est pas fait (question répétée de l'utilisateur,
      // 2026-09-27 : "pourquoi il ne me dit pas de charger à x % ?").
      if (coutSupplementaireMin > 0) plan.pct_evite_arret = { pct: besoinFinPct, cout_min: coutSupplementaireMin };
    }
    return plan;
  }

  // « Coût » en minutes jusqu'à l'arrivée si l'on choisit cette borne :
  // détour, recharge ici, recharges encore nécessaires ensuite (puissance
  // moyenne prudente + ~12 min par arrêt en plus : sortir, se garer,
  // brancher, repartir), prix converti en minutes selon le mode, et une
  // pénalité selon la note de la borne (fiabilité, paiement).
  // Mesuré sur Rennes → Bordeaux : sans le surcoût d'arrêt ni le prix, le
  // calcul préférait deux arrêts à un seul (+5 min et +10 €).
  const puissanceMoyenneFuture = Math.max(20, profil.puissance_dc_kw * 0.55);
  const energieParArretKwh = Math.max(5, (profil.capacite_kwh * (cibleRechargePct - margeSecuritePct)) / 100);
  const SURCOUT_ARRET_MIN = 12;
  // Minutes de recharge encore à prévoir après cet arrêt (arrêts suivants compris).
  function futurMinDe(plan) {
    const energieRestanteKwh = energie.energieA(distanceKm) - energie.energieA(plan.km) + margeKwh - (profil.capacite_kwh * plan.pctDepart) / 100;
    return energieRestanteKwh > 0 ? (energieRestanteKwh / puissanceMoyenneFuture) * 60 + SURCOUT_ARRET_MIN * Math.ceil(energieRestanteKwh / energieParArretKwh) : 0;
  }
  const MINUTES_PAR_EURO = { rapide: 0.3, economique: 3 }[mode] ?? 1;
  function tempsEstime(borne, plan) {
    const detourMin = ((borne.distance_km || 0) * 2 * 60) / 50;
    const energieRestanteKwh = energie.energieA(distanceKm) - energie.energieA(plan.km) + margeKwh - (profil.capacite_kwh * plan.pctDepart) / 100;
    const futurMin = futurMinDe(plan);
    const euros = plan.kwh * (borne.prix_kwh_eur ?? PRIX_KWH_ESTIME_DEFAUT_EUR) + Math.max(0, energieRestanteKwh) * PRIX_KWH_ESTIME_DEFAUT_EUR;
    const penaliteQualite = (100 - borne._score_info.score) * (mode === "rapide" ? 0.15 : 0.35);
    // Réseau d'abonnement (réglage « privilégier mes réseaux ») : préféré à
    // temps à peu près égal.
    const bonusReseau = borne.abonnement ? options.bonusAbonnementMin || 0 : 0;
    const autreSens = borne._autre_sens ? PENALITE_AUTRE_SENS_MIN : 0;
    return detourMin + plan.tempsMin + futurMin + euros * MINUTES_PAR_EURO + penaliteQualite - bonusReseau + autreSens;
  }

  // Endroits où chercher : à la limite de la batterie, puis un peu avant
  // (une grande station rapide plus tôt fait souvent gagner du temps).
  function positionsCandidates(limite) {
    const ecart = limite - distanceParcourue;
    if (options.optimiserArrets === false) return [limite];
    return [limite, distanceParcourue + ecart * 0.8, distanceParcourue + ecart * 0.62].filter((km, i, t) => i === 0 || (km - distanceParcourue >= 30 && t[i - 1] - km >= 15));
  }

  // Arrêt imposé (aire préférée, borne ⭐ choisie au départ) : l'itinéraire
  // y passe ; on s'y arrête dès qu'il est à portée, sans chercher ailleurs.
  const impose = options.arretImpose || null;
  let kmImpose = null;
  if (impose) {
    const p = kmSurTrace(coords, impose.lat, impose.lon);
    if (p.ecartKm <= 2) kmImpose = p.km;
  }
  async function choixImpose() {
    const r = await candidatsAutour(kmImpose);
    const liste = r.candidates || [];
    const borne = liste.find((b) => haversineKm(b.lat, b.lon, impose.lat, impose.lon) < 0.4) || { nom: impose.nom, adresse: impose.adresse || "", lat: impose.lat, lon: impose.lon, distance_km: 0, puissance_max_kw: null, operateur: "", _score_info: { score: 60 } };
    return { borne, plan: planArret(borne, kmImpose), temps: 0, candidates: liste.length ? liste : [borne], impose: true };
  }

  while (true) {
    const limite = atteignable(distanceParcourue, chargePct);
    if (limite >= distanceKm) break;
    if (limite - distanceParcourue <= 0) {
      return { ok: false, erreur: "Autonomie insuffisante pour rejoindre une borne en sécurité à cette étape.", ...base };
    }
    if (arrets.length >= MAX_ARRETS) {
      return { ok: false, erreur: "Trajet trop long pour ce planificateur (plus de 6 arrêts nécessaires).", ...base };
    }

    let choix = null;
    let premiereErreur = null;
    if (kmImpose !== null && kmImpose > distanceParcourue + 1 && kmImpose <= limite) {
      choix = await choixImpose();
      kmImpose = null;
    }
    for (const km of choix ? [] : positionsCandidates(limite)) {
      const r = await candidatsAutour(km);
      if (r.erreur) {
        premiereErreur ??= r.erreur;
        if (r.bloquant) return { ok: false, erreur: r.erreur, ...base };
        continue;
      }
      for (const b of r.candidates.slice(0, 5)) {
        const plan = planArret(b, km);
        const t = tempsEstime(b, plan);
        // À moins d'une demi-minute près, on garde le choix déjà fait (le
        // plus loin : on roule d'abord).
        if (!choix || t < choix.temps - 0.5) choix = { borne: b, plan, temps: t, candidates: r.candidates };
      }
    }
    if (!choix) return { ok: false, erreur: premiereErreur, ...base };

    const { borne, plan, candidates } = choix;
    const pointRechargeKm = plan.km;
    const alternatives = candidates.filter((b) => b !== borne).slice(0, 3).map((b) => ({
      nom: b.nom,
      adresse: b.adresse,
      lat: b.lat,
      lon: b.lon,
      distance_km: b.distance_km,
      puissance_max_kw: b.puissance_max_kw,
      operateur: b.operateur,
      statut: b.statut,
      connecteurs: b.connecteurs,
      type_acces: b.type_acces,
      cout_texte: b.cout_texte,
      prix_kwh_eur: b.prix_kwh_eur,
      prix_est_estimation: b.prix_est_estimation,
      paiement_cb_probable: b.paiement_cb_probable,
      prix_source: b.prix_source,
      fraicheur: b.fraicheur,
      officiel: b.officiel,
      etat_dynamique: b.etat_dynamique,
      score: b._score_info.score,
    }));

    const chargeALaBornePct = plan.pctArrivee;
    const departBornePct = plan.pctDepart;
    const kwhACharger = plan.kwh;
    const puissanceKw = plan.puissanceKw;
    const tempsChargeMin = plan.tempsMin;
    const coutEstimeEur = Math.round(kwhACharger * borne.prix_kwh_eur * 100) / 100;

    arrets.push({
      numero: arrets.length + 1,
      km_depuis_depart: Math.round(pointRechargeKm * 10) / 10,
      impose: !!choix.impose,
      nom_borne: borne.nom,
      adresse: borne.adresse,
      lat: borne.lat,
      lon: borne.lon,
      distance_borne_km: borne.distance_km,
      kwh_ajoutes: Math.round(kwhACharger * 10) / 10,
      puissance_kw: Math.round(puissanceKw),
      temps_charge_min: Math.round(tempsChargeMin),
      pct_arrivee_borne: chargeALaBornePct,
      pct_depart_borne: departBornePct,
      pct_evite_arret: plan.pct_evite_arret || null,
      operateur: borne.operateur,
      statut: borne.statut,
      nombre_points: borne.nombre_points,
      connecteurs: borne.connecteurs,
      cout_estime_eur: coutEstimeEur,
      prix_kwh_eur: borne.prix_kwh_eur,
      prix_est_estimation: borne.prix_est_estimation,
      fraicheur: borne.fraicheur,
      puissance_max_kw: borne.puissance_max_kw,
      type_acces: borne.type_acces,
      cout_texte: borne.cout_texte,
      derniere_maj: borne.derniere_maj,
      paiement_cb_probable: borne.paiement_cb_probable,
      prix_source: borne.prix_source,
      officiel: borne.officiel,
      etat_dynamique: borne.etat_dynamique,
      score: borne._score_info.score,
      score_details: borne._score_info.details,
      alternatives,
    });
    distanceParcourue = pointRechargeKm;
    chargePct = departBornePct;
  }

  const pctArrivee = chargePct - pctConsomme(distanceParcourue, distanceKm);

  const coutTotalEur = Math.round(arrets.reduce((s, a) => s + a.cout_estime_eur, 0) * 100) / 100;
  const prixPublicMoyen = arrets.length ? arrets.reduce((s, a) => s + a.prix_kwh_eur, 0) / arrets.length : PRIX_KWH_ESTIME_DEFAUT_EUR;

  const resultatFinal = {
    ok: true,
    arrets,
    nb_arrets: arrets.length,
    pct_batterie_arrivee: Math.round(pctArrivee * 10) / 10,
    temps_charge_total_min: Math.round(arrets.reduce((s, a) => s + a.temps_charge_min, 0)),
    cout_total_eur: coutTotalEur,
    depasse_seuil_cout: seuilCoutEur !== null && coutTotalEur > seuilCoutEur,
    comparaison_domicile: comparerCoutDomicilePublic(energieTotaleNecessaireKwh, profil, prixPublicMoyen),
    ...base,
  };
  resultatFinal.confiance = calculerIndiceConfiance(resultatFinal);
  return resultatFinal;
}
