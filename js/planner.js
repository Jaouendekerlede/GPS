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


// Minutes pour ajouter kwhAAjouter sur une borne de puissanceBorneKw.
// Avec la batterie de départ et le véhicule (profil), on suit la courbe de
// charge et la limite du chargeur embarqué en courant alternatif ; sans, on
// garde l'ancienne estimation (puissance constante, ×1,5 en charge rapide).




// Algorithme glouton : roule jusqu'à la marge de sécurité, cherche la
// meilleure borne réelle à proximité, recharge jusqu'à la cible,
// recommence -- même algorithme que JARVIS. `options.energie` (voir
// energie.js) donne l'énergie consommée le long du tracé : avec une
// consommation constante, on retrouve exactement les calculs de JARVIS ;
// avec le calcul détaillé, vitesse, relief et météo sont pris en compte.
