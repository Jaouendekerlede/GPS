// Persistance locale (localStorage) -- équivalent des fichiers JSON de
// JARVIS (config_store.read_json_file/write_json_file), mais par
// appareil : chaque téléphone/navigateur a sa propre copie, pas de
// serveur qui centraliserait quoi que ce soit.

import { STORAGE_KEYS, PROFIL_PAR_DEFAUT, MULTIPLICATEURS_SAISON } from "./config.js";
import { haversineKm } from "./geo.js";

const MAX_HISTORIQUE_TRAJETS = 50;
const MAX_TRAJETS_FAVORIS = 30;

function lireJson(cle, defaut) {
  try {
    const brut = localStorage.getItem(cle);
    return brut ? JSON.parse(brut) : defaut;
  } catch {
    return defaut;
  }
}

function ecrireJson(cle, valeur) {
  localStorage.setItem(cle, JSON.stringify(valeur));
}

const CHAMPS_NUMERIQUES = ["capacite_kwh", "consommation_kwh_100km", "puissance_ac_kw", "puissance_dc_kw", "puissance_domicile_kw", "prix_hc_eur_kwh", "prix_hp_eur_kwh"];

// Prix moyen payé à domicile, selon la part de recharge faite en heures
// creuses -- c'est lui qu'utilise la comparaison domicile/public de JARVIS.
function avecPrixDomicile(profil) {
  const partHc = Math.max(0, Math.min(100, Number(profil.part_hc_pct))) / 100;
  const prix = partHc * profil.prix_hc_eur_kwh + (1 - partHc) * profil.prix_hp_eur_kwh;
  return { ...profil, prix_domicile_eur_kwh: Math.round(prix * 10000) / 10000 };
}

// Version 2 du profil : Kona 65 kWh calée sur la fiche Hyundai (41 min de
// 10 à 80 %). Un profil enregistré avec l'ancienne valeur (77 kW) est mis à jour.
const VERSION_PROFIL = 2;

export function obtenirProfilVehicule() {
  const profil = lireJson(STORAGE_KEYS.profil, {});
  if ((profil.version_profil || 0) < VERSION_PROFIL && Object.keys(profil).length) {
    if (profil.puissance_dc_kw === 77) profil.puissance_dc_kw = PROFIL_PAR_DEFAUT.puissance_dc_kw;
    profil.version_profil = VERSION_PROFIL;
    ecrireJson(STORAGE_KEYS.profil, profil);
  }
  const fusion = { ...PROFIL_PAR_DEFAUT, ...profil };
  fusion.facteur_charge_appris = facteurChargeAppris();
  if (!(fusion.saison in MULTIPLICATEURS_SAISON)) {
    fusion.saison = "mi_saison";
  }
  return avecPrixDomicile(fusion);
}

export function definirProfilVehicule(champs) {
  const { prix_domicile_eur_kwh: _calcule, ...profil } = obtenirProfilVehicule();
  for (const cle of ["nom", ...CHAMPS_NUMERIQUES, "part_hc_pct"]) {
    if (champs[cle] !== undefined && champs[cle] !== null && champs[cle] !== "" && !Number.isNaN(champs[cle])) {
      profil[cle] = champs[cle];
    }
  }
  if (champs.saison && champs.saison in MULTIPLICATEURS_SAISON) {
    profil.saison = champs.saison;
  }
  // Valeurs choisies par l'utilisateur : plus de mise à jour automatique.
  profil.version_profil = VERSION_PROFIL;
  if (Array.isArray(champs.connecteurs_acceptes) && champs.connecteurs_acceptes.length) {
    profil.connecteurs_acceptes = champs.connecteurs_acceptes.map((c) => String(c).trim()).filter(Boolean);
  }
  for (const cle of CHAMPS_NUMERIQUES) {
    profil[cle] = Math.max(0.01, parseFloat(profil[cle]));
  }
  profil.part_hc_pct = Math.max(0, Math.min(100, parseFloat(profil.part_hc_pct) || 0));
  ecrireJson(STORAGE_KEYS.profil, profil);
  return avecPrixDomicile(profil);
}

export function listerHistoriqueTrajets() {
  return lireJson(STORAGE_KEYS.historique, []);
}

export function enregistrerHistoriqueTrajet(depart, destination, resultat, reglages) {
  const historique = listerHistoriqueTrajets();
  const entree = {
    id: `trajet_${Date.now()}`,
    ts: Date.now() / 1000,
    depart,
    destination,
    from_name: resultat.from_name,
    to_name: resultat.to_name,
    distance_km: resultat.distance_km,
    duree_text: resultat.duree_text,
    nb_arrets: resultat.nb_arrets,
    pct_batterie_arrivee: resultat.pct_batterie_arrivee,
    reglages: reglages || {},
  };
  historique.unshift(entree);
  ecrireJson(STORAGE_KEYS.historique, historique.slice(0, MAX_HISTORIQUE_TRAJETS));
  return entree.id;
}

export function supprimerTrajetHistorique(entreeId) {
  const historique = listerHistoriqueTrajets().filter((h) => h.id !== entreeId);
  ecrireJson(STORAGE_KEYS.historique, historique);
  return historique;
}

export function effacerHistoriqueTrajets() {
  ecrireJson(STORAGE_KEYS.historique, []);
}

export function listerTrajetsFavoris() {
  return lireJson(STORAGE_KEYS.favoris, []);
}

// etapes : points de passage « via » [{ lat, lon, nom }], dans l'ordre.
export function ajouterTrajetFavori(depart, destination, etapes = []) {
  const favoris = listerTrajetsFavoris();
  const cleEtapes = (liste) => (liste || []).map((e) => `${e.lat},${e.lon}`).join(";");
  const existe = favoris.some(
    (f) => f.depart.toLowerCase() === depart.toLowerCase() && f.destination.toLowerCase() === destination.toLowerCase() && cleEtapes(f.etapes) === cleEtapes(etapes),
  );
  if (!existe) {
    favoris.unshift({ id: `fav_${Date.now()}`, depart, destination, ...(etapes.length ? { etapes: etapes.map(({ lat, lon, nom }) => ({ lat, lon, nom })) } : {}) });
  }
  ecrireJson(STORAGE_KEYS.favoris, favoris.slice(0, MAX_TRAJETS_FAVORIS));
  return favoris;
}

export function retirerTrajetFavori(entreeId) {
  const favoris = listerTrajetsFavoris().filter((f) => f.id !== entreeId);
  ecrireJson(STORAGE_KEYS.favoris, favoris);
  return favoris;
}

function idBorne(nom, lat, lon) {
  return `${String(nom).trim().toLowerCase()}@${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

// Bornes signalées en panne par l'utilisateur : écartées des trajets
// pendant quelques jours, puis oubliées toutes seules.
const CLE_BORNES_EN_PANNE = "trajetve_bornes_en_panne";
export const JOURS_BORNE_EN_PANNE = 3;

export function listerBornesEnPanne(maintenant = Date.now()) {
  return lireJson(CLE_BORNES_EN_PANNE, []).filter((p) => p.jusqu_a > maintenant);
}

// Reconnue à son emplacement (environ 50 m), pas à son nom : la même borne
// porte des noms différents selon la base qui la décrit.
const memeEndroit = (p, lat, lon) => Math.abs(p.lat - lat) < 0.0005 && Math.abs(p.lon - lon) < 0.0007;

// Renvoie la date de fin du signalement (ms), ou null.
export function borneEnPanneJusqua(lat, lon, maintenant = Date.now()) {
  return listerBornesEnPanne(maintenant).find((p) => memeEndroit(p, lat, lon))?.jusqu_a ?? null;
}

// Signale la borne en panne, ou annule le signalement. Renvoie le nouvel état.
export function basculerBorneEnPanne(nom, lat, lon, maintenant = Date.now()) {
  const pannes = listerBornesEnPanne(maintenant);
  const dejaSignalee = pannes.some((p) => memeEndroit(p, lat, lon));
  const suite = dejaSignalee ? pannes.filter((p) => !memeEndroit(p, lat, lon)) : [...pannes, { nom, lat, lon, jusqu_a: maintenant + JOURS_BORNE_EN_PANNE * 86400000 }];
  ecrireJson(CLE_BORNES_EN_PANNE, suite);
  return !dejaSignalee;
}

export function listerBornesFavorites() {
  return lireJson(STORAGE_KEYS.bornesFavorites, []);
}

export function estBorneFavorite(nom, lat, lon) {
  const id = idBorne(nom, lat, lon);
  return listerBornesFavorites().some((f) => f.id === id);
}

export function basculerFavoriBorne(nom, lat, lon, adresse = "") {
  let favoris = listerBornesFavorites();
  const id = idBorne(nom, lat, lon);
  if (favoris.some((f) => f.id === id)) {
    favoris = favoris.filter((f) => f.id !== id);
  } else {
    favoris.unshift({ id, nom, lat, lon, adresse });
  }
  ecrireJson(STORAGE_KEYS.bornesFavorites, favoris);
  return favoris;
}

export function obtenirNoteBorne(nom, lat, lon) {
  return lireJson(STORAGE_KEYS.bornesNotes, {})[idBorne(nom, lat, lon)] || "";
}

export function definirNoteBorne(nom, lat, lon, note) {
  const notes = lireJson(STORAGE_KEYS.bornesNotes, {});
  const id = idBorne(nom, lat, lon);
  if (note.trim()) notes[id] = note.trim();
  else delete notes[id];
  ecrireJson(STORAGE_KEYS.bornesNotes, notes);
}

// Version 2 des réglages du trajet : 15 % de marge, recharge à 80 % (demande
// de l'utilisateur). Les anciens réglages enregistrés sont mis à jour une fois.
const VERSION_PREFS = 2;

export function lirePrefs() {
  const p = lireJson(STORAGE_KEYS.prefs, null);
  if (p && (p.version_reglages || 0) < VERSION_PREFS) {
    Object.assign(p, { marge_pct: 15, cible_pct: 80, version_reglages: VERSION_PREFS });
    if (p.mode === undefined || p.mode === "confort") p.mode = "confort";
    ecrireJson(STORAGE_KEYS.prefs, p);
  }
  return p;
}

export function sauverPrefs(prefs) {
  try {
    ecrireJson(STORAGE_KEYS.prefs, { ...prefs, version_reglages: VERSION_PREFS });
  } catch {
    // simple confort : une écriture ratée ne doit rien casser
  }
}

const REGLAGES_PAR_DEFAUT = { adresse_domicile: "", annonce_vocale: true };

export function lireReglages() {
  return { ...REGLAGES_PAR_DEFAUT, ...lireJson(STORAGE_KEYS.reglages, {}) };
}

export function sauverReglages(reglages) {
  ecrireJson(STORAGE_KEYS.reglages, { ...lireReglages(), ...reglages });
}

// ── Journal des recharges ──────────────────────────────────────────────────

const MAX_JOURNAL = 500;

export function listerJournal() {
  return lireJson(STORAGE_KEYS.journal, []);
}

// entree : { lieu, kwh, cout_eur, source: "navigation" | "manuel" }
export function ajouterAuJournal(entree) {
  const journal = listerJournal();
  // Identifiant unique même pour deux ajouts dans la même milliseconde.
  journal.unshift({ id: `recharge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...entree });
  ecrireJson(STORAGE_KEYS.journal, journal.slice(0, MAX_JOURNAL));
}

// ── Abonnements de recharge ────────────────────────────────────────────────
// { reseau: "Ionity", prix: 0.39 } : sur les bornes de ce réseau, le prix
// de l'abonnement remplace le tarif public (et les estimations).

export function listerAbonnements() {
  return (lireReglages().abonnements || []).filter((a) => a.reseau && a.prix > 0);
}

export function appliquerAbonnements(bornes) {
  const abonnements = listerAbonnements();
  if (!abonnements.length) return bornes;
  for (const b of bornes) {
    const noms = [b.operateur, b.officiel?.operateur, b.officiel?.enseigne, b.nom, b.nom_borne].filter(Boolean).join(" ").toLowerCase();
    const abo = abonnements.find((a) => noms.includes(a.reseau.trim().toLowerCase()));
    if (!abo) continue;
    b.prix_kwh_eur = abo.prix;
    b.prix_est_estimation = false;
    b.prix_source = "abonnement";
    b.abonnement = abo.reseau;
  }
  return bornes;
}

// ── Consommation mesurée en roulant ────────────────────────────────────────
// Chaque correction de batterie en navigation donne une mesure réelle :
// kWh consommés sur une distance connue.

const CLE_CONSO = "trajetve_conso_mesures";
const MAX_MESURES = 60;
const KM_MIN_MESURE = 20;
const KM_MIN_TOTAL = 50;

// types : km parcourus en ville, sur route et sur autoroute pendant la mesure.
export function enregistrerMesureConso(km, kwh, types = null) {
  const kwh100 = (kwh / km) * 100;
  // Mesure trop courte ou invraisemblable (erreur de saisie) : ignorée.
  if (km < KM_MIN_MESURE || kwh100 < 6 || kwh100 > 45) return false;
  const mesures = lireJson(CLE_CONSO, []);
  mesures.unshift({ ts: Date.now(), km: Math.round(km * 10) / 10, kwh: Math.round(kwh * 100) / 100, ...(types ? { types } : {}) });
  ecrireJson(CLE_CONSO, mesures.slice(0, MAX_MESURES));
  return true;
}

// Moyenne pondérée par la distance, ou null s'il n'y a pas assez de km.
export function consoMesuree() {
  const mesures = lireJson(CLE_CONSO, []);
  const km = mesures.reduce((s, m) => s + m.km, 0);
  if (km < KM_MIN_TOTAL) return null;
  const kwh = mesures.reduce((s, m) => s + m.kwh, 0);
  return { kwh_100km: Math.round((kwh / km) * 1000) / 10, km: Math.round(km), nb: mesures.length };
}

// ── Sauvegarde complète (changement de téléphone) ──────────────────────────
// Toutes les données de l'appli sont dans le localStorage sous des clés
// « trajetve_… » : on les exporte telles quelles dans un fichier.

const PREFIXE = "trajetve_";
const FORMAT_SAUVEGARDE = "trajetve-sauvegarde";

export function exporterDonnees() {
  const donnees = {};
  for (let i = 0; i < localStorage.length; i++) {
    const cle = localStorage.key(i);
    if (cle?.startsWith(PREFIXE)) donnees[cle] = localStorage.getItem(cle);
  }
  return { format: FORMAT_SAUVEGARDE, version: 1, date: new Date().toISOString(), donnees };
}

// Remplace les données de ce téléphone par celles du fichier. Renvoie le
// nombre d'éléments restaurés, ou lève une erreur si le fichier n'en est pas un.
export function importerDonnees(sauvegarde) {
  if (sauvegarde?.format !== FORMAT_SAUVEGARDE || typeof sauvegarde.donnees !== "object") {
    throw new Error("ce fichier n'est pas une sauvegarde GPS");
  }
  const entrees = Object.entries(sauvegarde.donnees).filter(([cle, valeur]) => cle.startsWith(PREFIXE) && typeof valeur === "string");
  const anciennes = [];
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(PREFIXE)) anciennes.push(localStorage.key(i));
  for (const cle of anciennes) localStorage.removeItem(cle);
  for (const [cle, valeur] of entrees) localStorage.setItem(cle, valeur);
  return entrees.length;
}
// ── Routes coupées à éviter (marquées sur la carte avant le départ) ─────────

const MAX_ZONES_EVITEES = 5;
const DEMI_COTE_ZONE_EVITEE_M = 120;

export function listerZonesEvitees() {
  return lireJson(STORAGE_KEYS.zonesEvitees, []);
}

export function ajouterZoneEvitee(lat, lon) {
  const zones = [{ id: `zone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, lat, lon, date: Date.now() }, ...listerZonesEvitees()].slice(0, MAX_ZONES_EVITEES);
  ecrireJson(STORAGE_KEYS.zonesEvitees, zones);
  return zones;
}

export function retirerZoneEvitee(id) {
  const zones = listerZonesEvitees().filter((z) => z.id !== id);
  ecrireJson(STORAGE_KEYS.zonesEvitees, zones);
  return zones;
}

// Carrés de 240 m de côté, au format « avoidAreas » de TomTom.
export function rectanglesZonesEvitees() {
  return listerZonesEvitees().map(({ lat, lon }) => {
    const dLat = DEMI_COTE_ZONE_EVITEE_M / 111320;
    const dLon = DEMI_COTE_ZONE_EVITEE_M / (111320 * Math.cos((lat * Math.PI) / 180));
    return { southWestCorner: { latitude: lat - dLat, longitude: lon - dLon }, northEastCorner: { latitude: lat + dLat, longitude: lon + dLon } };
  });
}

// ── Radars personnels (signalés par l'utilisateur) ──────────────────────────
// Demande explicite : pouvoir marquer un radar connu pour être prévenu aux
// prochains trajets. Traité par la suite EXACTEMENT comme les radars fixes
// officiels (voir chercherRadars dans navigation.js, alertes-route.js) :
// converti en « zone de danger » (jamais un point précis), comme la loi
// l'autorise -- même garde-fou que pour les radars OSM, pas de raccourci.
const MAX_RADARS_PERSONNELS = 200;

export function listerRadarsPersonnels() {
  return lireJson(STORAGE_KEYS.radarsPersonnels, []);
}

export function ajouterRadarPersonnel(lat, lon, note = "") {
  // Pas de doublon à moins de 150 m d'un radar déjà signalé.
  const proche = listerRadarsPersonnels().find((r) => haversineKm(r.lat, r.lon, lat, lon) < 0.15);
  if (proche) return { deja: true, radars: listerRadarsPersonnels() };
  const radars = [{ id: `radar_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, lat, lon, note: note.trim(), date: Date.now() }, ...listerRadarsPersonnels()].slice(0, MAX_RADARS_PERSONNELS);
  ecrireJson(STORAGE_KEYS.radarsPersonnels, radars);
  return { deja: false, radars };
}

// Annule le dernier "Signaler un radar ici" (liste triée du plus récent au
// plus ancien -- voir ajouterRadarPersonnel) : sert de correction rapide en
// cas d'erreur, sans avoir à gérer une liste complète. Demande explicite de
// l'utilisateur le 2026-09-27.
export function retirerDernierRadarPersonnel() {
  const radars = listerRadarsPersonnels();
  if (!radars.length) return { retire: null, radars };
  const [retire, ...reste] = radars;
  ecrireJson(STORAGE_KEYS.radarsPersonnels, reste);
  return { retire, radars: reste };
}

// ── Bornes personnelles ──────────────────────────────────────────────────
// Bornes vues sur le terrain mais absentes des bases publiques (Open Charge
// Map, IRVE gouvernement) -- ex. très récentes ou d'un réseau fermé (type
// Chargemap) non interrogeable. Forme compatible avec les bornes normales
// (carte.js, fiche borne) pour s'afficher et s'ouvrir sans code séparé.
// Demande explicite de l'utilisateur le 2026-09-27.
const MAX_BORNES_PERSONNELLES = 200;

export function listerBornesPersonnelles() {
  return lireJson(STORAGE_KEYS.bornesPersonnelles, []);
}

export function ajouterBornePersonnelle(lat, lon, { puissance_kw = 0, connecteur = "", note = "" } = {}) {
  // Pas de doublon à moins de 50 m d'une borne déjà signalée.
  const proche = listerBornesPersonnelles().find((b) => haversineKm(b.lat, b.lon, lat, lon) < 0.05);
  if (proche) return { deja: true, bornes: listerBornesPersonnelles() };
  const borne = {
    id: `borne_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    lat,
    lon,
    nom: note.trim() || "Borne signalée",
    note: note.trim(),
    puissance_max_kw: puissance_kw,
    connecteurs: connecteur ? [{ type: connecteur, puissance_kw, quantite: 1 }] : [],
    source: "perso",
    officiel: null,
    date: Date.now(),
  };
  const bornes = [borne, ...listerBornesPersonnelles()].slice(0, MAX_BORNES_PERSONNELLES);
  ecrireJson(STORAGE_KEYS.bornesPersonnelles, bornes);
  return { deja: false, bornes };
}

export function retirerDerniereBornePersonnelle() {
  const bornes = listerBornesPersonnelles();
  if (!bornes.length) return { retire: null, bornes };
  const [retire, ...reste] = bornes;
  ecrireJson(STORAGE_KEYS.bornesPersonnelles, reste);
  return { retire, bornes: reste };
}

// ── Où est garée la voiture (enregistré à l'arrivée d'une navigation) ───────

const CLE_VOITURE_GAREE = "trajetve_voiture_garee";

export function garerVoiture(lat, lon, lieu = "") {
  ecrireJson(CLE_VOITURE_GAREE, { lat, lon, lieu, date: Date.now() });
}

// ── Trajets faits en navigation (statistiques) ──────────────────────────────

const CLE_TRAJETS_FAITS = "trajetve_trajets_faits";
const MAX_TRAJETS_FAITS = 1000;

export function listerTrajetsFaits() {
  return lireJson(CLE_TRAJETS_FAITS, []);
}

export function ajouterTrajetFait(trajet) {
  ecrireJson(CLE_TRAJETS_FAITS, [{ date: Date.now(), ...trajet }, ...listerTrajetsFaits()].slice(0, MAX_TRAJETS_FAITS));
}

// Conso apprise par type de route : mesures faites surtout (70 % des km)
// en ville, sur route ou sur autoroute. { ville, route, autoroute } en
// kWh/100 km (null si pas assez de km pour ce type).
const PART_DOMINANTE = 0.7;
const KM_MIN_PAR_TYPE = 20;

export function consoParType() {
  const r = {};
  for (const type of ["ville", "route", "autoroute"]) {
    let km = 0;
    let kwh = 0;
    for (const m of lireJson(CLE_CONSO, [])) {
      if (!m.types) continue;
      const total = (m.types.ville || 0) + (m.types.route || 0) + (m.types.autoroute || 0);
      if (total > 0 && (m.types[type] || 0) / total >= PART_DOMINANTE) {
        km += m.km;
        kwh += m.kwh;
      }
    }
    r[type] = km >= KM_MIN_PAR_TYPE ? Math.round((kwh / km) * 1000) / 10 : null;
  }
  return r;
}

// Trajet prévu (départ différé) : conseil de recharge la veille au soir.
const CLE_TRAJET_PREVU = "trajetve_trajet_prevu";

export function noterTrajetPrevu(trajet) {
  ecrireJson(CLE_TRAJET_PREVU, trajet);
}

export function trajetPrevu() {
  return lireJson(CLE_TRAJET_PREVU, null);
}

// Tracés réellement roulés des derniers trajets (« 🗺️ Revoir »). Clé hors
// sauvegarde (« tve_ ») : trop volumineux pour le lien de restauration.
const CLE_TRACES = "tve_traces";
const MAX_TRACES = 20;

export function listerTraces() {
  return lireJson(CLE_TRACES, []);
}

export function ajouterTrace(trace) {
  const liste = [{ date: Date.now(), ...trace }, ...listerTraces()].slice(0, MAX_TRACES);
  try {
    ecrireJson(CLE_TRACES, liste);
  } catch {
    // Stockage plein : on garde moins de tracés.
    ecrireJson(CLE_TRACES, liste.slice(0, 5));
  }
}

// Retire un tracé et le trajet fait enregistré au même moment (c'est lui qui
// compte dans les statistiques). Renvoie false si le tracé n'existe plus.
export function supprimerTrace(date) {
  const traces = listerTraces();
  const trace = traces.find((t) => t.date === date);
  if (!trace) return false;
  ecrireJson(CLE_TRACES, traces.filter((t) => t !== trace));
  const faits = listerTrajetsFaits();
  const i = faits.findIndex((f) => Math.abs(f.date - date) < 5000 && f.km === trace.km);
  if (i >= 0) {
    faits.splice(i, 1);
    ecrireJson(CLE_TRAJETS_FAITS, faits);
  }
  return true;
}

// Trajets fréquents : destination souvent prise à cette heure-ci (±1 h),
// d'après les trajets faits. Renvoie le nom, ou null.
export function destinationHabituelle(maintenant = new Date()) {
  const h = maintenant.getHours();
  const compte = new Map();
  for (const t of listerTrajetsFaits()) {
    if (!t.destination) continue;
    const ht = new Date(t.date).getHours();
    if (Math.min(Math.abs(ht - h), 24 - Math.abs(ht - h)) > 1) continue;
    compte.set(t.destination, (compte.get(t.destination) || 0) + 1);
  }
  let meilleur = null;
  for (const [d, n] of compte) if (n >= 2 && (!meilleur || n > meilleur.n)) meilleur = { d, n };
  return meilleur?.d || null;
}

// Temps de charge appris : durée réelle à la borne / durée calculée, sur les
// dernières recharges rapides (celles d'une pause bien plus longue que
// nécessaire sont écartées). null tant qu'il y en a moins de 2.
export function facteurChargeAppris() {
  const sessions = listerJournal()
    .filter((e) => e.duree_reelle_min > 0 && e.duree_prevue_min >= 5)
    .map((e) => e.duree_reelle_min / e.duree_prevue_min)
    .filter((r) => r >= 0.6 && r <= 1.6)
    .slice(0, 10);
  if (sessions.length < 2) return null;
  return Math.round((sessions.reduce((a, b) => a + b, 0) / sessions.length) * 100) / 100;
}

// ── Remise à zéro (Profil) ──────────────────────────────────────────────────
// Efface réglages, favoris, historique, journal, abonnements, trajets et
// données apprises ; garde la voiture (profil), les clés et la carte de la
// région téléchargée, ainsi que le journal de diagnostic (pour le rapport).

const CLES_GARDEES = ["trajetve_profil", "trajetve_api_keys", "tve_region_hors_ligne", "tve_journal_diag"];

export function clesRemiseAZero(cles) {
  return cles.filter((k) => (k.startsWith("trajetve_") || k.startsWith("tve_")) && !CLES_GARDEES.includes(k));
}

export async function remiseAZero() {
  const cles = [];
  for (let i = 0; i < localStorage.length; i++) cles.push(localStorage.key(i));
  const effacees = clesRemiseAZero(cles);
  for (const k of effacees) localStorage.removeItem(k);
  try {
    await caches.delete("trajetve-osm"); // réponses OpenStreetMap gardées
  } catch {
    // pas de Cache Storage : rien à vider
  }
  return effacees.length;
}
