// Recherche de bornes de recharge réelles via Open Charge Map -- porté
// depuis jarvis_ev_charge_runtime.py (_requete_open_charge_map,
// rechercher_bornes_proches, rechercher_bornes_zone, _borne_compatible).
// Open Charge Map exige désormais une clé gratuite (inscription sur
// openchargemap.org), même pour une simple recherche.

import { haversineKm } from "./geo.js";
import { PRIX_KWH_ESTIME_DEFAUT_EUR } from "./config.js";
import { avecMemoire } from "./util.js";

const MOTIF_PRIX_KWH = /(\d+(?:[.,]\d+)?)\s*(?:€|eur)\s*\/?\s*kwh/i;

export function extrairePrixKwh(usageCost) {
  if (!usageCost) return null;
  const m = MOTIF_PRIX_KWH.exec(usageCost);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  return Number.isNaN(val) ? null : val;
}

function fraicheurBorne(derniereMaj) {
  if (!derniereMaj) return { label: "Date de mise à jour inconnue", niveau: "inconnu" };
  const dateMaj = new Date(derniereMaj);
  if (Number.isNaN(dateMaj.getTime())) return { label: "Date de mise à jour inconnue", niveau: "inconnu" };
  const jours = Math.floor((Date.now() - dateMaj.getTime()) / 86400000);
  if (jours < 1) return { label: "Mise à jour aujourd'hui", niveau: "recent" };
  if (jours <= 30) return { label: `Mise à jour il y a ${jours} jour(s)`, niveau: "recent" };
  if (jours <= 365) return { label: `Mise à jour il y a ${Math.floor(jours / 30)} mois`, niveau: "ancien" };
  return { label: `Information ancienne (${Math.floor(jours / 365)} an(s))`, niveau: "ancien" };
}

// Même zone (à ~100 m près) redemandée dans les 10 min : réponse gardée,
// distances recalculées depuis le point exact.
const DUREE_MEMOIRE_MS = 10 * 60 * 1000;

async function requeteOpenChargeMap(apiKey, lat, lon, rayonKm, maxResultats) {
  const cle = `ocm|${lat.toFixed(3)}|${lon.toFixed(3)}|${rayonKm}|${maxResultats}`;
  const r = await avecMemoire(cle, DUREE_MEMOIRE_MS, () => requeteOpenChargeMapReseau(apiKey, lat, lon, rayonKm, maxResultats));
  if (r.ok) {
    for (const b of r.bornes) b.distance_km = Math.round(haversineKm(lat, lon, b.lat, b.lon) * 10) / 10;
    r.bornes.sort((a, b) => a.distance_km - b.distance_km);
  }
  return r;
}

async function requeteOpenChargeMapReseau(apiKey, lat, lon, rayonKm, maxResultats) {
  const params = new URLSearchParams({
    output: "json",
    latitude: lat,
    longitude: lon,
    distance: rayonKm,
    distanceunit: "KM",
    maxresults: maxResultats,
  });
  if (apiKey) params.set("key", apiKey);

  try {
    const resp = await fetch(`https://api.openchargemap.io/v3/poi/?${params.toString()}`);
    if (resp.status === 403) {
      console.warn("[OCM] HTTP 403 : clé API manquante ou invalide.");
      return { ok: false, bornes: [], erreur: "cle_manquante" };
    }
    if (!resp.ok) {
      console.warn(`[OCM] HTTP ${resp.status}`);
      return { ok: false, bornes: [], erreur: `http_${resp.status}` };
    }
    const data = await resp.json();
    const resultats = [];
    for (const poi of data) {
      const addr = poi.AddressInfo || {};
      if (addr.Latitude == null || addr.Longitude == null) continue;
      const connexions = poi.Connections || [];
      const puissanceMax = Math.max(0, ...connexions.map((c) => c.PowerKW || 0));

      const connecteurs = connexions.map((c) => ({
        type: (c.ConnectionType || {}).Title || "Type inconnu",
        puissance_kw: c.PowerKW || 0,
        quantite: c.Quantity || 1,
        statut: (c.StatusType || {}).Title || "Statut inconnu",
      }));

      const usageCost = poi.UsageCost;
      let prixKwh = extrairePrixKwh(usageCost);
      const prixEstEstimation = prixKwh === null;
      if (prixKwh === null) prixKwh = PRIX_KWH_ESTIME_DEFAUT_EUR;

      const derniereMaj = poi.DateLastStatusUpdate || poi.DateLastVerified;

      resultats.push({
        nom: addr.Title || "Borne de recharge",
        adresse: [addr.AddressLine1, addr.Town].filter(Boolean).join(", "),
        lat: addr.Latitude,
        lon: addr.Longitude,
        distance_km: Math.round(haversineKm(lat, lon, addr.Latitude, addr.Longitude) * 10) / 10,
        puissance_max_kw: puissanceMax,
        operateur: (poi.OperatorInfo || {}).Title || null,
        statut: (poi.StatusType || {}).Title || "Statut inconnu",
        nombre_points: poi.NumberOfPoints,
        connecteurs,
        cout_texte: usageCost,
        prix_kwh_eur: prixKwh,
        prix_est_estimation: prixEstEstimation,
        derniere_maj: derniereMaj,
        fraicheur: fraicheurBorne(derniereMaj),
        type_acces: (poi.UsageType || {}).Title || "Accès inconnu",
        paiement_cb_probable: puissanceMax >= 50.0,
      });
    }
    resultats.sort((a, b) => a.distance_km - b.distance_km);
    return { ok: true, bornes: resultats, erreur: null };
  } catch (e) {
    console.warn("[OCM] Erreur recherche bornes", e);
    return { ok: false, bornes: [], erreur: String(e) };
  }
}

// Élargit progressivement le rayon (20 -> 40 -> 70 km) si rien n'est
// trouvé, comme le planificateur JARVIS.
export async function rechercherBornesProches(apiKey, lat, lon, rayonKm = 20, maxResultats = 5) {
  let derniereErreur = null;
  for (const rayon of [rayonKm, rayonKm * 2, rayonKm * 3.5]) {
    const resultat = await requeteOpenChargeMap(apiKey, lat, lon, rayon, maxResultats);
    if (!resultat.ok) return resultat;
    if (resultat.bornes.length) return resultat;
    derniereErreur = resultat;
  }
  return derniereErreur || { ok: true, bornes: [], erreur: null };
}

export async function rechercherBornesZone(apiKey, lat, lon, options = {}) {
  const rayonKm = options.rayonKm ?? 15;
  const maxResultats = options.maxResultats ?? 30;
  const filtreActif = Boolean(options.filtreOperateur || options.filtreTypeAcces || options.carteBancaireUniquement);
  const resultat = await requeteOpenChargeMap(apiKey, lat, lon, rayonKm, filtreActif ? Math.max(maxResultats, 100) : maxResultats);
  if (!resultat.ok || !filtreActif) return resultat;

  let bornes = resultat.bornes;
  if (options.filtreOperateur) {
    const aiguille = options.filtreOperateur.trim().toLowerCase();
    bornes = bornes.filter((b) => (b.operateur || "").toLowerCase().includes(aiguille) || (b.nom || "").toLowerCase().includes(aiguille));
  }
  if (options.filtreTypeAcces) {
    const aiguille = options.filtreTypeAcces.trim().toLowerCase();
    bornes = bornes.filter((b) => (b.type_acces || "").toLowerCase().includes(aiguille));
  }
  if (options.carteBancaireUniquement) {
    bornes = bornes.filter((b) => b.paiement_cb_probable);
  }
  return { ok: true, bornes: bornes.slice(0, maxResultats), erreur: null };
}

export function borneCompatible(borne, connecteursAcceptes) {
  const typesBorne = (borne.connecteurs || []).map((c) => c.type || "");
  if (!typesBorne.length) return true; // Pas d'info -- ne pas exclure a tort.
  const acceptesLower = connecteursAcceptes.map((c) => c.toLowerCase());
  return typesBorne.some((t) => acceptesLower.some((acc) => t.toLowerCase().includes(acc)));
}
