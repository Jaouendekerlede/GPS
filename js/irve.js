// Informations officielles des bornes en France : Base nationale des IRVE
// (data.gouv.fr, mise à jour quotidienne, déclarations obligatoires des
// opérateurs). Seule source gratuite qui dit explicitement si la carte
// bancaire est acceptée. Interrogée via l'API tabulaire de data.gouv.fr
// (sans clé, CORS ouvert).

import { haversineKm } from "./geo.js";
import { extrairePrixKwh } from "./ocm.js";
import { PRIX_KWH_ESTIME_DEFAUT_EUR } from "./config.js";
import { avecMemoire } from "./util.js";

const API = "https://tabular-api.data.gouv.fr/api/resources/eb76d20a-8501-400e-b336-d85724de5435/data/";
const RAYON_RECHERCHE_M = 150;
const cache = new Map();

const vrai = (v) => v === true || v === 1 || v === "true" || v === "True" || v === "1";

function texteUtile(v) {
  const t = String(v ?? "").trim();
  return t && !/^(inconnu|aucun|non renseign[ée]|n\/a|null)$/i.test(t) ? t : "";
}

function uniques(valeurs) {
  return [...new Set(valeurs.map(texteUtile).filter(Boolean))];
}

// "tout" / "partiel" / "non" pour un critère déclaré point de charge par point de charge
function synthese(lignes, champ) {
  const nb = lignes.filter((l) => vrai(l[champ])).length;
  return nb === 0 ? "non" : nb === lignes.length ? "oui" : "partiel";
}

function telephone(t) {
  const brut = texteUtile(t).replace(/^tel:/i, "");
  return brut ? { affichage: brut.replace(/[-.]/g, " "), lien: `tel:${brut.replace(/[^\d+]/g, "")}` } : null;
}

function agregerStation(lignes, distanceM) {
  const l0 = lignes[0];
  const prises = {};
  const ajouterPrise = (cle, libelle, ligne) => {
    const p = (prises[cle] ??= { libelle, nombre: 0, puissance_max_kw: 0 });
    p.nombre++;
    p.puissance_max_kw = Math.max(p.puissance_max_kw, Number(ligne.puissance_nominale) || 0);
  };
  for (const l of lignes) {
    if (vrai(l.prise_type_combo_ccs)) ajouterPrise("ccs", "Combo CCS (charge rapide)", l);
    if (vrai(l.prise_type_2)) ajouterPrise("type2", "Type 2", l);
    if (vrai(l.prise_type_chademo)) ajouterPrise("chademo", "CHAdeMO", l);
    if (vrai(l.prise_type_ef)) ajouterPrise("ef", "Prise domestique E/F", l);
    if (vrai(l.prise_type_autre)) ajouterPrise("autre", "Autre prise", l);
  }
  const dates = (champ) => lignes.map((l) => texteUtile(l[champ])).filter(Boolean).sort();

  return {
    id_station: l0.id_station_itinerance,
    ids_pdc: lignes.map((l) => texteUtile(l.id_pdc_itinerance)).filter(Boolean),
    nom_station: texteUtile(l0.nom_station),
    adresse: texteUtile(l0.adresse_station),
    implantation: texteUtile(l0.implantation_station),
    operateur: texteUtile(l0.nom_operateur),
    enseigne: texteUtile(l0.nom_enseigne),
    amenageur: texteUtile(l0.nom_amenageur),
    contact: texteUtile(l0.contact_operateur),
    telephone: telephone(l0.telephone_operateur),
    nombre_points: Math.max(lignes.length, Number(l0.nbre_pdc) || 0),
    points_consultes: lignes.length,
    puissance_max_kw: Math.max(0, ...lignes.map((l) => Number(l.puissance_nominale) || 0)),
    prises: Object.values(prises),
    paiement_cb: synthese(lignes, "paiement_cb"),
    paiement_acte: synthese(lignes, "paiement_acte"),
    paiement_autre: synthese(lignes, "paiement_autre"),
    gratuit: synthese(lignes, "gratuit"),
    tarifs: uniques(lignes.map((l) => l.tarification)),
    condition_acces: uniques(lignes.map((l) => l.condition_acces)).join(" / "),
    horaires: uniques(lignes.map((l) => l.horaires)).join(" / "),
    reservation: synthese(lignes, "reservation"),
    accessibilite_pmr: uniques(lignes.map((l) => l.accessibilite_pmr)).join(" / "),
    restriction_gabarit: uniques(lignes.map((l) => l.restriction_gabarit)).join(" / "),
    cable_attache: synthese(lignes, "cable_t2_attache"),
    deux_roues: synthese(lignes, "station_deux_roues"),
    observations: uniques(lignes.map((l) => l.observations)).join(" / "),
    date_mise_en_service: dates("date_mise_en_service")[0] || "",
    date_maj: dates("date_maj").pop() || "",
    distance_m: Math.round(distanceM),
  };
}

// ── État des points de charge (base nationale « dynamique ») ────────────────
// Consolidation officielle (transport.data.gouv.fr, en test) : l'état de
// chaque point de charge tel que déclaré par les opérateurs. Mise à jour
// tous les quelques jours seulement : fiable pour les points HORS SERVICE,
// pas pour l'occupation (qu'on n'affiche que si elle a moins d'une heure).
// Fichier de ~9 Mo : téléchargé au plus toutes les 6 h, et on n'en garde
// que l'utile (points pas en service, occupations récentes).

// L'URL "stable" de transport.data.gouv.fr redirige (302) sans aucun
// en-tête CORS -- le navigateur bloque alors tout le fetch avec "Failed to
// fetch", même si les redirections suivantes (data.gouv.fr, puis le fichier
// lui-même) ont bien "access-control-allow-origin: *". Résultat vérifié
// (le 2026-09-27, journal de diagnostic de l'utilisateur) : cette fonction
// n'avait jamais réussi une seule fois depuis un navigateur. On saute donc
// ce premier maillon et on pointe directement sur la redirection suivante,
// qui elle est joignable. Si data.gouv.fr change un jour cet identifiant
// de ressource, le symptôme redeviendra le même avertissement dans la
// console -- il suffira de reprendre https://transport.data.gouv.fr/
// resources/84098/download dans un navigateur classique (pas fetch) pour
// retrouver la nouvelle redirection à jour.
const URL_ETATS = "https://www.data.gouv.fr/api/1/datasets/r/89185b1f-f958-4c5b-9282-399a66ecee97";
const CACHE_ETATS = "trajetve-etats-irve";
const DUREE_ETATS_MS = 6 * 3600 * 1000;
const OCCUPATION_RECENTE_MS = 3600 * 1000;
// Un signalement « hors service » plus vieux que cela est sans doute périmé.
const SIGNALEMENT_ANCIEN_MS = 30 * 86400 * 1000;
let etatsPdc = null;
let etatsCharges = 0;
let chargementEtats = null;

function lireEtatsCsv(texte) {
  const lignes = texte.split("\n");
  const entete = lignes[0].split(",");
  const col = (nom) => entete.indexOf(nom);
  const [cId, cEtat, cOcc, cDate] = [col("id_pdc_itinerance"), col("etat_pdc"), col("occupation_pdc"), col("horodatage")];
  const etats = {};
  const limiteOccupation = Date.now() - OCCUPATION_RECENTE_MS;
  for (let i = 1; i < lignes.length; i++) {
    const v = lignes[i].split(",");
    if (v.length <= cDate) continue;
    const t = Date.parse(v[cDate].replace(" ", "T"));
    if (v[cEtat] === "hors_service" || (v[cEtat] === "en_service" && t > limiteOccupation)) etats[v[cId]] = { e: v[cEtat], o: v[cOcc], t };
  }
  return etats;
}

// Âge (ms) des états en mémoire, ou null s'ils n'ont pas été chargés.
export function ageEtatsDynamiques() {
  return etatsPdc ? Date.now() - etatsCharges : null;
}

export function chargerEtatsDynamiques() {
  // En mémoire aussi, les états expirent (appli laissée ouverte des heures).
  if (etatsPdc && Date.now() - etatsCharges < DUREE_ETATS_MS) return Promise.resolve(etatsPdc);
  if (etatsPdc) {
    etatsPdc = null;
    chargementEtats = null;
  }
  chargementEtats ??= (async () => {
    try {
      const cache = typeof caches !== "undefined" ? await caches.open(CACHE_ETATS) : null;
      const garde = await cache?.match("etats.json");
      if (garde && Date.now() - Number(garde.headers.get("x-date")) < DUREE_ETATS_MS) {
        etatsPdc = await garde.json();
        etatsCharges = Number(garde.headers.get("x-date"));
        return etatsPdc;
      }
      const resp = await fetch(URL_ETATS);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      etatsPdc = lireEtatsCsv(await resp.text());
      etatsCharges = Date.now();
      await cache?.put("etats.json", new Response(JSON.stringify(etatsPdc), { headers: { "content-type": "application/json", "x-date": String(Date.now()) } }));
      return etatsPdc;
    } catch (e) {
      console.warn("[IRVE] État des points de charge indisponible", e);
      chargementEtats = null; // réessayer plus tard
      return null;
    }
  })();
  return chargementEtats;
}

// Synthèse pour une station officielle : points hors service, et points
// libres si l'information est récente.
export function etatStation(officiel) {
  const ids = officiel?.ids_pdc;
  if (!etatsPdc || !ids?.length) return null;
  let horsService = 0;
  let libres = 0;
  let occupes = 0;
  let dateSignalement = 0;
  let dateOccupation = 0;
  const limite = Date.now() - OCCUPATION_RECENTE_MS;
  for (const id of ids) {
    const e = etatsPdc[id];
    if (!e) continue;
    if (e.e === "hors_service") {
      horsService++;
      dateSignalement = Math.max(dateSignalement, e.t || 0);
    } else if (e.e === "en_service" && e.t > limite) {
      if (e.o === "libre") libres++;
      else if (e.o === "occupe" || e.o === "reserve") occupes++;
      if (e.o === "libre" || e.o === "occupe" || e.o === "reserve") dateOccupation = Math.max(dateOccupation, e.t);
    }
  }
  if (!horsService && !libres && !occupes) return null;
  return {
    total: ids.length,
    hors_service: horsService,
    tous_hors_service: horsService === ids.length,
    libres,
    occupes,
    date_signalement: dateSignalement || null,
    // Panne déclarée il y a longtemps : l'information elle-même est douteuse.
    signalement_ancien: !!dateSignalement && Date.now() - dateSignalement > SIGNALEMENT_ANCIEN_MS,
    // Heure de la dernière occupation connue (toujours de moins d'une heure).
    date_occupation: dateOccupation || null,
  };
}

function ressemblance(a, b) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = n(a);
  const y = n(b);
  return x && y && (x.includes(y) || y.includes(x)) ? 1 : 0;
}

// Renvoie la station officielle la plus proche (≤ 150 m) de la borne Open
// Charge Map donnée, ou null si aucune (borne hors France, ou non déclarée).
export async function infosOfficiellesBorne(lat, lon, indices = {}) {
  if (lat == null || lon == null) return null;
  const cle = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  if (cache.has(cle)) return cache.get(cle);

  const promesse = (async () => {
    const dLat = RAYON_RECHERCHE_M / 111000;
    const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const params = new URLSearchParams({
      consolidated_latitude__greater: (lat - dLat).toFixed(6),
      consolidated_latitude__less: (lat + dLat).toFixed(6),
      consolidated_longitude__greater: (lon - dLon).toFixed(6),
      consolidated_longitude__less: (lon + dLon).toFixed(6),
      page_size: "50",
    });
    try {
      const resp = await fetch(`${API}?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const lignes = (await resp.json()).data || [];
      const stations = new Map();
      for (const l of lignes) {
        const id = l.id_station_itinerance || `${l.consolidated_latitude},${l.consolidated_longitude}`;
        if (!stations.has(id)) stations.set(id, []);
        stations.get(id).push(l);
      }
      let meilleure = null;
      for (const groupe of stations.values()) {
        const l0 = groupe[0];
        const distanceM = haversineKm(lat, lon, Number(l0.consolidated_latitude), Number(l0.consolidated_longitude)) * 1000;
        if (!(distanceM <= RAYON_RECHERCHE_M)) continue;
        // à distance comparable, préférer le même opérateur/enseigne
        const note = distanceM - 60 * (ressemblance(indices.operateur, l0.nom_operateur) || ressemblance(indices.operateur, l0.nom_enseigne));
        if (!meilleure || note < meilleure.note) meilleure = { note, groupe, distanceM };
      }
      return meilleure ? agregerStation(meilleure.groupe, meilleure.distanceM) : null;
    } catch (e) {
      console.warn("[IRVE] Infos officielles indisponibles", e);
      cache.delete(cle); // réessayer la prochaine fois
      return { indisponible: true };
    }
  })();
  cache.set(cle, promesse);
  return promesse;
}

// ── Bornes d'une zone, directement depuis la base officielle ───────────────
// Complète Open Charge Map (base collaborative, incomplète en France).
// L'API renvoie une ligne par point de charge, 50 par page : on resserre la
// zone autour du centre si elle en contient trop, pour garder les plus proches.

function prixDepuisTarifs(tarifs) {
  for (const tarif of tarifs || []) {
    const centimes = /(\d+(?:[.,]\d+)?)\s*(?:cts?|centimes?|c€)\s*\/?\s*kwh/i.exec(tarif);
    const prix = centimes ? parseFloat(centimes[1].replace(",", ".")) / 100 : extrairePrixKwh(tarif);
    if (prix !== null && prix > 0 && prix < 2) return prix;
  }
  return null;
}

function parametresZone(lat, lon, rayonKm, puissanceMin) {
  const dLat = rayonKm / 111;
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const p = new URLSearchParams({
    consolidated_latitude__greater: (lat - dLat).toFixed(6),
    consolidated_latitude__less: (lat + dLat).toFixed(6),
    consolidated_longitude__greater: (lon - dLon).toFixed(6),
    consolidated_longitude__less: (lon + dLon).toFixed(6),
  });
  if (puissanceMin > 0) p.set("puissance_nominale__greater", String(puissanceMin - 0.1));
  return p;
}

async function page(params, numero, taille) {
  const p = new URLSearchParams(params);
  p.set("page", String(numero));
  p.set("page_size", String(taille));
  const resp = await fetch(`${API}?${p}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function borneDepuisStation(o, lat, lon) {
  const prix = prixDepuisTarifs(o.tarifs);
  return {
    nom: o.nom_station || o.enseigne || o.operateur || "Borne de recharge",
    adresse: o.adresse,
    lat: o._lat,
    lon: o._lon,
    distance_km: Math.round(haversineKm(lat, lon, o._lat, o._lon) * 10) / 10,
    puissance_max_kw: o.puissance_max_kw,
    operateur: o.operateur || o.enseigne || null,
    statut: null,
    nombre_points: o.nombre_points,
    connecteurs: o.prises.map((p) => ({ type: p.libelle, puissance_kw: p.puissance_max_kw, quantite: p.nombre, statut: "Déclaré" })),
    cout_texte: o.tarifs.join(" · ") || null,
    prix_kwh_eur: prix ?? PRIX_KWH_ESTIME_DEFAUT_EUR,
    prix_est_estimation: prix === null,
    prix_source: prix !== null ? "officiel" : undefined,
    fraicheur: null,
    type_acces: o.condition_acces || null,
    paiement_cb_probable: o.puissance_max_kw >= 50,
    officiel: { ...o, distance_m: 0 },
    source: "irve",
  };
}

export async function stationsOfficiellesZone(lat, lon, rayonKm, { puissanceMin = 0, maxLignes = 400 } = {}) {
  const cle = `irve|${lat.toFixed(3)}|${lon.toFixed(3)}|${rayonKm}|${puissanceMin}|${maxLignes}`;
  const r = await avecMemoire(cle, 10 * 60 * 1000, () => stationsOfficiellesZoneReseau(lat, lon, rayonKm, puissanceMin, maxLignes));
  if (r.ok) {
    for (const b of r.bornes) b.distance_km = Math.round(haversineKm(lat, lon, b.lat, b.lon) * 10) / 10;
    r.bornes.sort((a, b) => a.distance_km - b.distance_km);
  }
  return r;
}

async function stationsOfficiellesZoneReseau(lat, lon, rayonKm, puissanceMin, maxLignes) {
  try {
    let rayon = rayonKm;
    let params = parametresZone(lat, lon, rayon, puissanceMin);
    let total = (await page(params, 1, 1)).meta?.total || 0;
    let incomplet = false;
    if (total > maxLignes) {
      incomplet = true;
      rayon = Math.max(0.3, rayonKm * Math.sqrt(maxLignes / total) * 0.9);
      params = parametresZone(lat, lon, rayon, puissanceMin);
      total = (await page(params, 1, 1)).meta?.total || 0;
    }
    const nbPages = Math.min(Math.ceil(Math.min(total, maxLignes) / 50), Math.ceil(maxLignes / 50));
    const pages = await Promise.all(Array.from({ length: nbPages }, (_, i) => page(params, i + 1, 50)));
    const lignes = pages.flatMap((p) => p.data || []).filter((l) => l.consolidated_latitude != null && l.consolidated_longitude != null);

    const groupes = new Map();
    for (const l of lignes) {
      const id = l.id_station_itinerance || `${Number(l.consolidated_latitude).toFixed(5)},${Number(l.consolidated_longitude).toFixed(5)}`;
      if (!groupes.has(id)) groupes.set(id, []);
      groupes.get(id).push(l);
    }
    const bornes = [...groupes.values()]
      .map((g) => {
        const o = agregerStation(g, 0);
        o._lat = Number(g[0].consolidated_latitude);
        o._lon = Number(g[0].consolidated_longitude);
        return borneDepuisStation(o, lat, lon);
      })
      .sort((a, b) => a.distance_km - b.distance_km);
    return { ok: true, bornes, rayonKm: rayon, incomplet };
  } catch (e) {
    console.warn("[IRVE] Recherche de zone indisponible", e);
    return { ok: false, bornes: [], erreur: String(e) };
  }
}

// Fusionne Open Charge Map et la base officielle sans doublons : une station
// officielle à moins de 80 m d'une borne OCM est la même borne (on lui
// rattache alors les infos officielles).
export function fusionnerBornes(bornesOcm, bornesOfficielles) {
  const resultat = [...bornesOcm];
  for (const s of bornesOfficielles) {
    let proche = null;
    let dMin = 0.08;
    for (const b of bornesOcm) {
      const d = haversineKm(b.lat, b.lon, s.lat, s.lon);
      if (d < dMin) {
        dMin = d;
        proche = b;
      }
    }
    if (proche) {
      if (proche.officiel === undefined || proche.officiel === null) {
        proche.officiel = { ...s.officiel, distance_m: Math.round(dMin * 1000) };
        if (proche.prix_est_estimation && !s.prix_est_estimation) {
          proche.prix_kwh_eur = s.prix_kwh_eur;
          proche.prix_est_estimation = false;
          proche.prix_source = "officiel";
        }
      }
    } else {
      resultat.push(s);
    }
  }
  return resultat.sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
}

// Ajoute `officiel` à chaque borne ; si Open Charge Map n'avait pas de
// tarif, reprend le tarif officiel déclaré (quand il est en €/kWh).
// attendreEtats : le calcul d'un trajet attend l'état des points de charge
// (éviter une station en panne compte) ; la liste des bornes non, elle
// l'affichera dès qu'il sera arrivé.
export async function enrichirBornes(bornes, { attendreEtats = false } = {}) {
  const etats = chargerEtatsDynamiques();
  await Promise.all(
    bornes.map(async (b) => {
      if (b.officiel === undefined) b.officiel = await infosOfficiellesBorne(b.lat, b.lon, { operateur: b.operateur });
      const prix = b.prix_est_estimation ? prixDepuisTarifs(b.officiel?.tarifs) : null;
      if (prix !== null) {
        b.prix_kwh_eur = prix;
        b.prix_est_estimation = false;
        b.prix_source = "officiel";
      }
    }),
  );
  // Points hors service (et occupation récente) déclarés par l'opérateur.
  if (attendreEtats) await etats;
  for (const b of bornes) b.etat_dynamique = etatStation(b.officiel && !b.officiel.indisponible ? b.officiel : null);
  return bornes;
}
