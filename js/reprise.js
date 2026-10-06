// Reprise d'une navigation coupée (appli fermée par Android, téléphone
// redémarré…). L'état est gardé toutes les 15 s en roulant ; un arrêt voulu
// (✕ Arrêter, arrivée) l'efface. Hors sauvegarde (clé « tve_ »).

const CLE = "tve_navigation_en_cours";
// Passé ce délai, la navigation est oubliée (trop ancienne pour être sûre).
export const DUREE_REPRISE_MS = 6 * 60 * 60 * 1000;
// Coupure très récente : reprise sans rien demander (mains sur le volant).
export const DELAI_REPRISE_AUTO_MS = 10 * 60 * 1000;

// e : { plan, options, arrets_restants, destination, destination_finale, batterie_pct }
export function enregistrerReprise(e, maintenant = Date.now()) {
  try {
    localStorage.setItem(CLE, JSON.stringify({ ts: maintenant, ...e }));
    return true;
  } catch {
    return false; // stockage plein : la reprise ne sera simplement pas proposée
  }
}

export function oublierReprise() {
  try {
    localStorage.removeItem(CLE);
  } catch {
    // rien à effacer
  }
}

// null, ou { plan (arrêts restants et destination actuelle), options,
// batterie_pct, destination (nom), age_ms, automatique }.
export function lireReprise(maintenant = Date.now()) {
  try {
    const s = JSON.parse(localStorage.getItem(CLE));
    if (!s?.plan || maintenant - s.ts > DUREE_REPRISE_MS) return null;
    // Anciennes sauvegardes : seul le nombre d'arrêts faits était gardé.
    const restants = Array.isArray(s.arrets_restants) ? s.arrets_restants : (s.plan.arrets || []).slice(s.arrets_faits || 0);
    const cible = s.destination?.lat != null ? s.destination : { lat: s.plan.to_lat, lon: s.plan.to_lon, nom: s.plan.to_name };
    // _reprise : les km du plan ne correspondent plus au trajet restant.
    const plan = { ...s.plan, arrets: restants, to_lat: cible.lat, to_lon: cible.lon, to_name: cible.nom || s.plan.to_name, _reprise: true };
    const age = maintenant - s.ts;
    return { plan, options: s.options, batterie_pct: s.batterie_pct, destination: plan.to_name, age_ms: age, automatique: age <= DELAI_REPRISE_AUTO_MS };
  } catch {
    return null;
  }
}

export function ageTexte(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  return `il y a ${h} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")}` : ""}`;
}
