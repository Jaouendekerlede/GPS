// Orchestration d'un calcul complet -- équivalent de
// _ev_planifier_trajet_interne et des handlers ev_* de main2.py (JARVIS),
// mais exécuté directement dans le téléphone, sans serveur.

import { getApiKeys, PALIERS_TEMPERATURE, MODES_TRAJET, MULTIPLICATEUR_CHARGE_LOURDE } from "./config.js";
import { obtenirProfilVehicule, enregistrerHistoriqueTrajet, lireReglages, appliquerAbonnements, rectanglesZonesEvitees, borneEnPanneJusqua } from "./storage.js";
import { resoudreLieu, estMaPosition, pointADistanceSurTrace, haversineKm } from "./geo.js";
import { calculerItineraireTomTom } from "./tomtom.js";
import { echangeursDuTrajet } from "./panneau-nav.js";
import { calculerTrajetElectrique, formaterMinutes, consommationEffectiveKwh100km, kmSurTrace } from "./planner.js";
import { construireProfilEnergie, fonctionsEnergie, fonctionsEnergieConstante } from "./energie.js";
import { enrichirBornes, stationsOfficiellesZone, fusionnerBornes } from "./irve.js";
import { rechercherBornesProches, rechercherBornesZone, borneCompatible } from "./ocm.js";

const arrondi1 = (x) => Math.round(x * 10) / 10;

// Estimation rapide (consommation constante, sans réseau) : sert seulement à
// décider si ça vaut la peine de forcer un détour vers l'aire préférée --
// le vrai plan (courbe de charge, météo, dénivelé...) est calculé juste
// après par calculerTrajetElectrique. Repéré sur un cas réel : Niort →
// Bordeaux (260 km, largement à portée sans charger) forçait quand même un
// détour de 67 km vers une aire préférée choisie pour un trajet bien plus
// long (Saint-Nazaire → Bordeaux) -- aucune recharge n'était même prévue
// à l'arrivée (0 arrêt), le détour ne servait donc littéralement à rien.
function chargeProbablementNecessaire(distanceKm, chargePct, margePct, profil) {
  const kwhDisponible = Math.max(0, (profil.capacite_kwh * ((chargePct ?? 100) - (margePct ?? 0))) / 100);
  const kmSansCharge = (kwhDisponible / consommationEffectiveKwh100km(profil)) * 100;
  return kmSansCharge < distanceKm;
}

function messageOcm(erreur) {
  return erreur === "cle_manquante"
    ? "Clé Open Charge Map manquante ou invalide (Menu › Clés API)."
    : `Service de recherche de bornes indisponible (${erreur}).`;
}

function messageTomTom(erreur, fromName, toName) {
  if (erreur === "cle_manquante") return "Itinéraire routier indisponible : clé TomTom manquante (Menu › Clés API).";
  if (erreur === "http_403" || erreur === "http_401") return "Clé TomTom refusée : vérifie la clé et que l'« API de routage » est bien cochée sur developer.tomtom.com.";
  if (erreur === "reseau") return "Pas de connexion réseau : impossible de calculer l'itinéraire.";
  return `Aucun itinéraire routier trouvé entre "${fromName}" et "${toName}" (destination non joignable par la route, ou lieu mal identifié).`;
}

export async function obtenirCorrectionMeteo(lat, lon) {
  const indisponible = { ok: false, multiplicateur: 1.0, description: "Météo indisponible" };
  try {
    const params = new URLSearchParams({ latitude: lat, longitude: lon, current: "temperature_2m" });
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!resp.ok) return indisponible;
    const temp = (await resp.json())?.current?.temperature_2m;
    if (typeof temp !== "number") return indisponible;
    for (const [seuil, multiplicateur, description] of PALIERS_TEMPERATURE) {
      if (temp < seuil) return { ok: true, multiplicateur, temperature_c: temp, description };
    }
    return { ok: true, multiplicateur: 1.05, temperature_c: temp, description: "chaleur, climatisation" };
  } catch {
    return indisponible;
  }
}

async function calculerItineraire(depart, destination, opts) {
  const { tomtom } = getApiKeys();
  if (!tomtom) return { ok: false, erreur: messageTomTom("cle_manquante") };
  const domicile = lireReglages().adresse_domicile;

  // Séquentiel exprès : Nominatim demande au plus 1 requête/seconde. Un
  // départ « Ma position » ne l'interroge pas (GPS) : il se cherche pendant
  // que la destination est géocodée, au lieu d'attendre l'un puis l'autre.
  const travail = lireReglages().adresse_travail;
  let a;
  let b;
  if (estMaPosition(depart)) {
    [a, b] = await Promise.all([resoudreLieu(depart, domicile, travail), resoudreLieu(destination, domicile, travail)]);
  } else {
    a = await resoudreLieu(depart, domicile, travail);
    if (a.erreur) return { ok: false, erreur: a.erreur };
    b = await resoudreLieu(destination, domicile, travail);
  }
  if (a.erreur) return { ok: false, erreur: a.erreur };
  if (b.erreur) return { ok: false, erreur: b.erreur };

  const departMs = departPrevuMs(opts);
  const optsRoute = {
    eviterPeages: opts.eviter_peages,
    eviterAutoroutes: opts.eviter_autoroutes,
    plusCourt: opts.plus_court,
    eviterFerries: opts.eviter_ferries,
    eviterZonesFaiblesEmissions: opts.eviter_zones_faibles_emissions,
    eviterRoutesNonRevetues: opts.eviter_routes_non_revetues,
    // TomTom prévoit alors le trafic à cette heure-là
    departAt: departMs > Date.now() + 5 * 60000 ? new Date(departMs).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    traceImposee: opts.trace_imposee,
    zonesEvitees: rectanglesZonesEvitees(),
    // Pour la feuille de route (sorties et échangeurs du trajet).
    instructions: true,
  };

  // Points de passage choisis à la main sur la carte (appui long, "Passer par
  // ici") : TomTom route au travers, dans l'ordre choisi. Combinés avec une
  // aire favorite imposée s'il y en a une -- dans ce cas précis, on saute le
  // calcul fin du détour (ci-dessous) : avec des points imposés par ailleurs,
  // le trajet est de toute façon déjà sous contrôle manuel.
  const etapesManuelles = (opts.points_passage || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => ({ lat: p.lat, lon: p.lon }));

  let it;
  let aireImposee = null;
  if (etapesManuelles.length) {
    const etapes = [...etapesManuelles, ...(opts.arret_impose ? [{ lat: opts.arret_impose.lat, lon: opts.arret_impose.lon }] : [])];
    it = await calculerItineraireTomTom(tomtom, a.lat, a.lon, b.lat, b.lon, { ...optsRoute, etapes, maxAlternatives: 0 });
    if (it.erreur) return { ok: false, erreur: messageTomTom(it.erreur, a.nom, b.nom) };
  } else if (opts.arret_impose) {
    // L'aire préférée est-elle déjà sur le trajet le plus rapide (juste en
    // léger retrait, comme tout parking), ou faut-il vraiment en sortir
    // (autre côté de l'autoroute) ? Mesuré sur un cas réel (Aire de la
    // Parthenaise, A83, Saint-Nazaire → Bordeaux) : le trajet libre passe à
    // 180 m de la borne, mais forcer TomTom à s'y arrêter (étape) lui
    // faisait quand même faire 46 km de plus -- un artefact du point
    // raccroché au mauvais côté de la chaussée, pas un vrai détour. On ne
    // force donc l'étape (et son vrai risque de détour) que si l'aire n'est
    // pas déjà sur le trajet libre (même seuil que le planificateur, 2 km)
    // ET qu'il faut de toute façon recharger quelque part sur ce trajet --
    // sinon (départ plus proche de l'arrivée, ou aire choisie pour un autre
    // trajet) le détour ne servirait à rien.
    const libre = await calculerItineraireTomTom(tomtom, a.lat, a.lon, b.lat, b.lon, { ...optsRoute, maxAlternatives: 0 });
    if (libre.erreur) return { ok: false, erreur: messageTomTom(libre.erreur, a.nom, b.nom) };
    const surTrajet = kmSurTrace(libre.coords, opts.arret_impose.lat, opts.arret_impose.lon).ecartKm <= 2;
    const chargeNecessaire = chargeProbablementNecessaire(libre.summary.lengthInMeters / 1000, opts.charge_pct, opts.marge_pct, obtenirProfilVehicule());
    if (surTrajet || !chargeNecessaire) {
      it = libre;
    } else {
      it = await calculerItineraireTomTom(tomtom, a.lat, a.lon, b.lat, b.lon, {
        ...optsRoute,
        etapes: [{ lat: opts.arret_impose.lat, lon: opts.arret_impose.lon }],
        maxAlternatives: 0,
      });
      if (it.erreur) return { ok: false, erreur: messageTomTom(it.erreur, a.nom, b.nom) };
      aireImposee = { nom: opts.arret_impose.nom, detour_km: arrondi1(it.summary.lengthInMeters / 1000 - libre.summary.lengthInMeters / 1000), detour_min: Math.round(it.summary.travelTimeInSeconds / 60 - libre.summary.travelTimeInSeconds / 60) };
    }
  } else {
    it = await calculerItineraireTomTom(tomtom, a.lat, a.lon, b.lat, b.lon, { ...optsRoute, maxAlternatives: opts.avec_alternatives && !opts.trace_imposee ? MAX_ALTERNATIVES : 0 });
    if (it.erreur) return { ok: false, erreur: messageTomTom(it.erreur, a.nom, b.nom) };
  }

  const itin = itineraireDepuisRoute(it, a, b, departMs, !!opts.trace_imposee && it.traceSuivie);
  if (aireImposee) itin.aire_imposee = aireImposee;
  itin._alternatives = it.alternatives.map((r) => itineraireDepuisRoute(r, a, b, departMs, true));
  return itin;
}

const MAX_ALTERNATIVES = 2;
// Préférence pour les réseaux d'abonnement : vaut 8 minutes de trajet.
const BONUS_ABONNEMENT_MIN = 8;

function kmSurSections(coords, sections, type) {
  let km = 0;
  for (const s of sections) {
    if (String(s.sectionType || "").toUpperCase().replace(/_/g, "") !== type) continue;
    const fin = Math.min(coords.length - 1, s.endPointIndex ?? 0);
    for (let i = Math.max(0, s.startPointIndex ?? 0); i < fin; i++) {
      km += haversineKm(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
    }
  }
  return Math.round(km);
}

// suivreTrace : en navigation, TomTom devra reconstruire ce tracé précis
// plutôt que de reprendre l'itinéraire le plus rapide.
function itineraireDepuisRoute(route, a, b, departMs, suivreTrace) {
  const dureeMin = Math.floor(route.summary.travelTimeInSeconds / 60);
  return {
    ok: true,
    _sections: route.sections,
    _summary: route.summary,
    depart_ms: departMs,
    from_name: a.nom,
    to_name: b.nom,
    from_lat: a.lat,
    from_lon: a.lon,
    to_lat: b.lat,
    to_lon: b.lon,
    distance_km: arrondi1(route.summary.lengthInMeters / 1000),
    duree_min: dureeMin,
    duree_text: formaterMinutes(dureeMin),
    retard_trafic_min: Math.round((route.summary.trafficDelayInSeconds || 0) / 60),
    km_autoroute: kmSurSections(route.coords, route.sections, "MOTORWAY"),
    km_peage: kmSurSections(route.coords, route.sections, "TOLLROAD"),
    echangeurs: echangeursDuTrajet(route.guidance?.instructions),
    suivre_trace: suivreTrace,
    coords: route.coords,
  };
}

function departPrevuMs(opts) {
  const ms = opts.depart_prevu ? new Date(opts.depart_prevu).getTime() : NaN;
  return Number.isFinite(ms) && ms > Date.now() ? ms : Date.now();
}

async function profilEnergiePour(itin, opts) {
  try {
    return await construireProfilEnergie(itin, obtenirProfilVehicule(), {
      ajuster_meteo: opts.ajuster_meteo,
      charge_lourde: opts.charge_lourde,
      depart_ms: itin.depart_ms,
      patience_ms: opts.patience_open_meteo_ms,
    });
  } catch (e) {
    console.warn("[ENERGIE] Profil détaillé impossible, consommation constante utilisée", e);
    return null;
  }
}

// Batterie le long du trajet, avec la remontée à chaque arrêt -- sert à la
// courbe et à la frise "où serai-je ?".
function courbeBatterie(energie, kmPoints, chargeDepartPct, arrets, capacite) {
  const points = [];
  let refKm = 0;
  let refPct = chargeDepartPct;
  let a = 0;
  const pctA = (d) => refPct - ((energie.energieA(d) - energie.energieA(refKm)) / capacite) * 100;
  for (const km of kmPoints) {
    while (a < arrets.length && arrets[a].km_depuis_depart <= km) {
      const kmArret = arrets[a].km_depuis_depart;
      points.push({ km: kmArret, pct: pctA(kmArret) });
      refKm = kmArret;
      refPct = arrets[a].pct_depart_borne;
      points.push({ km: kmArret, pct: refPct });
      a++;
    }
    points.push({ km, pct: pctA(km) });
  }
  return points.map((p) => ({ km: arrondi1(p.km), pct: arrondi1(p.pct) }));
}

async function planifierSurItineraire(itin, chargePct, opts) {
  const profil = obtenirProfilVehicule();
  const profilEnergie = opts.profil_energie !== undefined ? opts.profil_energie : await profilEnergiePour(itin, opts);
  const detaille = opts.modele_detaille !== false && profilEnergie;

  // Sans calcul détaillé : exactement la logique JARVIS (consommation
  // constante, corrigée par la température au départ si demandé).
  let meteoInfo = null;
  let energie;
  if (detaille) {
    energie = fonctionsEnergie(profilEnergie.km, profilEnergie.ecum);
  } else {
    if (opts.ajuster_meteo) meteoInfo = profilEnergie?.meteo_depart ?? (await obtenirCorrectionMeteo(itin.from_lat, itin.from_lon));
    let conso = meteoInfo?.ok ? meteoInfo.multiplicateur * profil.consommation_kwh_100km : consommationEffectiveKwh100km(profil);
    if (opts.charge_lourde) conso *= MULTIPLICATEUR_CHARGE_LOURDE;
    energie = fonctionsEnergieConstante(conso);
  }

  const resultat = await calculerTrajetElectrique(getApiKeys().openChargeMap, itin.distance_km, itin.coords, chargePct, profil, {
    margeSecuritePct: opts.marge_pct,
    cibleRechargePct: opts.cible_pct,
    puissanceMinKw: opts.puissance_min_kw,
    seuilCoutEur: opts.seuil_cout_eur,
    mode: opts.mode,
    energie,
    enrichirBornes: async (bornes) => appliquerAbonnements(await enrichirBornes(bornes, { attendreEtats: true })),
    preferCb: opts.preferer_cb,
    optimiserArrets: opts.optimiser_arrets !== false,
    arretImpose: opts.arret_impose || null,
    bonusAbonnementMin: lireReglages().privilegier_abonnements === false ? 0 : BONUS_ABONNEMENT_MIN,
    fusionner: fusionnerBornes,
    estExclue: (b) => borneEnPanneJusqua(b.lat, b.lon) !== null,
    bornesSupplementaires: async (lat, lon) => {
      const r = await stationsOfficiellesZone(lat, lon, 20, { puissanceMin: Math.max(40, opts.puissance_min_kw || 0), maxLignes: 300 });
      return r.ok ? r.bornes : [];
    },
  });
  if (meteoInfo) resultat.meteo_info = meteoInfo;
  // Route réelle passant par les bornes prévues (celle que suivra la
  // navigation) : plus longue que le trajet direct si une borne est de
  // l'autre côté de l'autoroute. On le mesure pour le dire -- mais
  // seulement pour les bornes qui ne sont pas déjà sur le trajet direct
  // (même seuil que l'aire imposée, v53) : forcer TomTom à s'arrêter pile
  // sur un point déjà à quelques dizaines de mètres de la route peut quand
  // même lui faire router des dizaines de km de plus (même artefact du
  // point raccroché au mauvais côté de la chaussée, pas un vrai détour).
  // Mesuré sur un cas réel : "Aire de Saint Caprais (direction Bordeaux)",
  // à 80 m du trajet direct, donnait quand même +46 km en étape forcée.
  if (resultat.ok && resultat.arrets?.length && !opts.trace_imposee) {
    const arretsHorsTrajet = resultat.arrets.filter((a) => kmSurTrace(itin.coords, a.lat, a.lon).ecartKm > 2);
    if (arretsHorsTrajet.length) {
      try {
        const avecArrets = await calculerItineraireTomTom(getApiKeys().tomtom, itin.from_lat, itin.from_lon, itin.to_lat, itin.to_lon, {
          etapes: arretsHorsTrajet.map((a) => ({ lat: a.lat, lon: a.lon })),
          eviterPeages: opts.eviter_peages,
          eviterAutoroutes: opts.eviter_autoroutes,
          plusCourt: opts.plus_court,
          eviterFerries: opts.eviter_ferries,
          eviterZonesFaiblesEmissions: opts.eviter_zones_faibles_emissions,
          eviterRoutesNonRevetues: opts.eviter_routes_non_revetues,
          zonesEvitees: rectanglesZonesEvitees(),
        });
        if (!avecArrets.erreur) {
          resultat.detour_arrets = { km: arrondi1(avecArrets.summary.lengthInMeters / 1000 - itin.distance_km), min: Math.round(avecArrets.summary.travelTimeInSeconds / 60 - itin.duree_min) };
        }
      } catch {
        // Mesure impossible : pas d'avertissement, le plan reste valable.
      }
    }
  }

  const { _sections, _summary, _alternatives, ...itinPublic } = itin;
  const dureeTotaleMin = resultat.ok ? itin.duree_min + (resultat.temps_charge_total_min || 0) : null;
  const complet = { ...itinPublic, duree_totale_min: dureeTotaleMin, ...resultat, modele: detaille ? "detaille" : "constant" };

  if (profilEnergie) {
    const kmPoints = [0, ...profilEnergie.segments.map((s) => s.km_fin)];
    complet.profil_trajet = {
      segments: profilEnergie.segments,
      stats: detaille
        ? profilEnergie.stats
        : { ...profilEnergie.stats, conso_moyenne_kwh100: (energie.energieA(itin.distance_km) / itin.distance_km) * 100, energie_totale_kwh: energie.energieA(itin.distance_km) },
      relief_ok: profilEnergie.relief_ok,
      meteo_ok: profilEnergie.meteo_ok,
      // En mode constant, la courbe de conso affichée doit être celle utilisée pour le plan.
      conso_constante: detaille ? null : (energie.energieA(100)),
      batterie: resultat.ok ? courbeBatterie(energie, kmPoints, chargePct, resultat.arrets, profil.capacite_kwh) : null,
    };
  }
  complet.bouchons = bouchonsDuTrajet(_sections);
  return complet;
}

// Ralentissements annoncés par TomTom sur le tracé (indices de points),
// pour les colorer sur la carte : 1-2 = ralentissement, 3-4 = bouchon.
function bouchonsDuTrajet(sections) {
  return (sections || [])
    .filter((s) => String(s.sectionType).toUpperCase() === "TRAFFIC" && s.endPointIndex > s.startPointIndex)
    .map((s) => ({
      debut: s.startPointIndex,
      fin: s.endPointIndex,
      niveau: Number(s.magnitudeOfDelay) || (s.simpleCategory === "JAM" ? 3 : 1),
      retard_min: Math.round((s.delayInSeconds || 0) / 60),
      fermeture: s.simpleCategory === "ROAD_CLOSURE",
    }));
}

// Avec opts.avec_alternatives, le résultat porte aussi les autres routes
// proposées par TomTom (itineraires_alternatifs), dont le plan de recharge
// reste à faire avec planifierAlternative : l'énergie, donc les arrêts,
// dépendent de chaque route.
// Dernier itinéraire calculé, gardé pour le simuler à vitesse réduite sans
// redemander la route à TomTom.
let dernierItineraire = null;

// Même trajet en ne dépassant jamais `vitesseMaxKmh` : consommation, arrêts
// et durée recalculés. Renvoie le plan (avec minutes_route_en_plus), ou
// { ok: false, erreur }.
export async function simulerVitesseMax(vitesseMaxKmh) {
  if (!dernierItineraire) return { ok: false, erreur: "Calcule d'abord un trajet." };
  const { itin, opts } = dernierItineraire;
  let profilEnergie;
  try {
    profilEnergie = await construireProfilEnergie(itin, obtenirProfilVehicule(), {
      ajuster_meteo: opts.ajuster_meteo,
      charge_lourde: opts.charge_lourde,
      depart_ms: itin.depart_ms,
      vitesse_max_kmh: vitesseMaxKmh,
    });
  } catch (e) {
    return { ok: false, erreur: `Simulation impossible : ${e?.message || e}` };
  }
  const plan = await planifierSurItineraire(itin, opts.charge_pct, { ...opts, profil_energie: profilEnergie, modele_detaille: true });
  if (!plan.ok) return plan;
  const enPlus = Math.round(profilEnergie.secondes_en_plus / 60);
  return { ...plan, minutes_route_en_plus: enPlus, duree_totale_min: plan.duree_totale_min + enPlus };
}

export async function planifierTrajet(depart, destination, opts, sauvegarder = true) {
  const itin = await calculerItineraire(depart, destination, opts);
  if (!itin.ok) return itin;
  dernierItineraire = { itin, opts };
  const resultat = await planifierSurItineraire(itin, opts.charge_pct, opts);
  resultat.itineraires_alternatifs = itin._alternatives;
  if (resultat.ok && sauvegarder) {
    enregistrerHistoriqueTrajet(depart, destination, resultat, {
      mode: opts.mode,
      marge_pct: opts.marge_pct,
      cible_pct: opts.cible_pct,
      charge_pct: opts.charge_pct,
      eviter_peages: opts.eviter_peages,
      puissance_min_kw: opts.puissance_min_kw,
      points_passage: (opts.points_passage || []).map(({ lat, lon, nom }) => ({ lat, lon, nom })),
    });
  }
  return resultat;
}

export async function planifierAlternative(itin, opts) {
  return planifierSurItineraire(itin, opts.charge_pct, opts);
}

// Retour : on suppose une recharge jusqu'à l'objectif à destination avant
// de repartir (même hypothèse que JARVIS).
export async function planifierAllerRetour(depart, destination, opts) {
  const aller = await planifierTrajet(depart, destination, opts);
  const retour = await planifierTrajet(destination, depart, { ...opts, charge_pct: opts.cible_pct });
  return { aller, retour };
}

// Même trajet dans les 4 modes -- l'itinéraire est calculé une seule fois
// puis réutilisé, pour économiser les appels TomTom.
export async function comparerScenarios(depart, destination, opts) {
  const itin = await calculerItineraire(depart, destination, opts);
  if (!itin.ok) return { ok: false, erreur: itin.erreur };
  const profilEnergie = await profilEnergiePour(itin, opts);
  const scenarios = {};
  for (const [mode, poids] of Object.entries(MODES_TRAJET)) {
    scenarios[mode] = await planifierSurItineraire(itin, opts.charge_pct, {
      ...opts,
      mode,
      marge_pct: poids.marge_pct,
      cible_pct: poids.cible_pct,
      profil_energie: profilEnergie,
    });
  }
  return { ok: true, depart, destination, scenarios };
}

// Curseur "Où serai-je ?" : l'interface convertit déjà le temps de conduite
// en distance (profil de vitesse du trajet).
export async function bornesADistance(trajet, distanceKm) {
  const distanceCibleKm = Math.max(0, Math.min(trajet.distance_km, distanceKm));
  const point = pointADistanceSurTrace(trajet.coords, distanceCibleKm);
  if (!point) return { ok: false, erreur: "Point introuvable sur le trajet." };
  const [recherche, officielles] = await Promise.all([
    rechercherBornesProches(getApiKeys().openChargeMap, point.lat, point.lon, 20, 8),
    stationsOfficiellesZone(point.lat, point.lon, 20, { puissanceMin: 22, maxLignes: 200 }),
  ]);
  if (!recherche.ok && !officielles.bornes.length) return { ok: false, erreur: messageOcm(recherche.erreur) };
  const bornes = fusionnerBornes(recherche.ok ? recherche.bornes : [], officielles.bornes).slice(0, 12);
  return { ok: true, distance_cible_km: arrondi1(distanceCibleKm), lat: point.lat, lon: point.lon, bornes };
}

export async function rechercherBornesAutour(lieu, filtres = {}) {
  const l = await resoudreLieu(lieu, lireReglages().adresse_domicile);
  if (l.erreur) return { ok: false, erreur: l.erreur };
  const rayon = filtres.rayon_km ?? 15;
  const [recherche, officielles] = await Promise.all([
    rechercherBornesZone(getApiKeys().openChargeMap, l.lat, l.lon, {
      rayonKm: rayon,
      filtreOperateur: filtres.operateur || "",
      filtreTypeAcces: filtres.type_acces || "",
      maxResultats: 40,
    }),
    stationsOfficiellesZone(l.lat, l.lon, rayon, { maxLignes: 400 }),
  ]);
  // Les types d'accès Open Charge Map n'ont pas d'équivalent exact dans la
  // base officielle : avec ce filtre, on s'en tient à Open Charge Map.
  let extra = filtres.type_acces ? [] : officielles.bornes;
  const operateur = (filtres.operateur || "").trim().toLowerCase();
  if (operateur) extra = extra.filter((b) => `${b.operateur || ""} ${b.nom || ""} ${b.officiel?.enseigne || ""}`.toLowerCase().includes(operateur));
  if (!recherche.ok && !extra.length) return { ok: false, erreur: messageOcm(recherche.erreur) };
  let bornes = fusionnerBornes(recherche.ok ? recherche.bornes : [], extra).slice(0, 60);
  if (filtres.carte_bancaire_uniquement) {
    // Déclaration officielle d'abord ; à défaut, règle légale des ≥50 kW.
    appliquerAbonnements(await enrichirBornes(bornes));
    bornes = bornes.filter((b) => (b.officiel && !b.officiel.indisponible ? b.officiel.paiement_cb !== "non" : b.paiement_cb_probable));
  }
  return { ok: true, lieu: l.nom, lat: l.lat, lon: l.lon, bornes };
}

// Mode urgence : position GPS d'abord (on est sur la route), sinon le lieu
// de départ saisi. Seules les bornes compatibles avec le véhicule sont
// proposées -- recommander une prise inutilisable en urgence serait pire
// que rien.
export async function bornesUrgence(lieuDeSecours) {
  let recherche = await rechercherBornesAutour("ma position", { rayon_km: 30 });
  if (!recherche.ok && lieuDeSecours) recherche = await rechercherBornesAutour(lieuDeSecours, { rayon_km: 30 });
  if (!recherche.ok) return recherche;
  const connecteurs = obtenirProfilVehicule().connecteurs_acceptes;
  const bornes = recherche.bornes.filter((b) => borneCompatible(b, connecteurs)).slice(0, 3);
  appliquerAbonnements(await enrichirBornes(bornes));
  return { ...recherche, bornes };
}
