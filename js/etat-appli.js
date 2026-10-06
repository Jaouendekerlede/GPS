// Menu › État de l'appli : ce qui marche et ce qui manque, en clair, pour
// comprendre un guidage qui se passe mal sans rien envoyer à personne.
// Calcul pur : l'écran lui fournit les faits, il rend les phrases.
// Aucune position n'y figure, seulement sa précision et son âge.

const NIVEAUX_GPS = { bon: "bonne", faible: "moyenne", mauvais: "mauvaise" };

function age(minutes) {
  if (minutes < 1) return "à l'instant";
  if (minutes < 90) return `il y a ${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `il y a ${Math.round(minutes / 60)} h`;
  return `il y a ${Math.round(minutes / 1440)} jours`;
}

// info : {
//   enLigne, gpsPermission ("granted" | "denied" | "prompt" | null),
//   gpsTest : null | { erreur } | { precision, niveau },
//   cles : { tomtom, openChargeMap }, quota : { utilise, max },
//   etatsBornesAgeMin (null si jamais chargés), guidagePrepare : null | { ageMin, nbArrets },
//   regionPreparee (booléen), guidage : null | { signal, niveau, age_s, ecartees, estimations },
// }
// Renvoie [{ niveau: "ok" | "attention" | "info", titre, texte }].
export function lignesEtat(info) {
  const l = [];
  const ligne = (niveau, titre, texte) => l.push({ niveau, titre, texte });

  ligne(info.enLigne ? "ok" : "attention", "Réseau", info.enLigne ? "Connecté à Internet." : "Pas de connexion : pas de calcul d'itinéraire, de recherche de bornes ni de trafic.");

  if (info.gpsTest?.erreur) ligne("attention", "GPS", info.gpsTest.erreur);
  else if (info.gpsTest) {
    const n = info.gpsTest.niveau;
    ligne(n === "bon" ? "ok" : "attention", "GPS", `Position reçue, précision ${NIVEAUX_GPS[n] || "inconnue"} (±${Math.round(info.gpsTest.precision)} m).${n === "bon" ? "" : " Dehors, à ciel dégagé, elle s'améliore en quelques secondes."}`);
  } else if (info.gpsPermission === "denied") ligne("attention", "GPS", "Localisation refusée pour cette appli : autorise-la dans les réglages du téléphone, sinon le guidage ne peut pas démarrer.");
  else if (info.gpsPermission === "granted") ligne("ok", "GPS", "Localisation autorisée. Touche « Tester le GPS » pour connaître la précision actuelle.");
  else ligne("info", "GPS", "Autorisation pas encore demandée : touche « Tester le GPS ».");

  if (info.guidage) {
    const g = info.guidage;
    const etats = { suivi: "position suivie", estime: "position estimée (pas de signal)", perdu: "signal perdu", fige: "pas de signal" };
    const details = [`${etats[g.signal] || "état inconnu"}`];
    if (g.niveau && g.signal === "suivi") details.push(`précision ${NIVEAUX_GPS[g.niveau] || "inconnue"}`);
    if (Number.isFinite(g.age_s)) details.push(`dernière mesure vieille de ${Math.round(g.age_s)} s`);
    details.push(`${g.ecartees || 0} mesure(s) écartée(s)`, `${g.estimations || 0} passage(s) sans signal`);
    ligne(g.signal === "suivi" && g.niveau === "bon" ? "ok" : "attention", "Guidage en cours", `${details.join(", ")}.`);
  }

  ligne(info.cles.tomtom ? "ok" : "attention", "Clé TomTom (itinéraires)", info.cles.tomtom ? `Enregistrée. ${info.quota.utilise} appel(s) aujourd'hui sur ${info.quota.max}.` : "Absente : aucun itinéraire ne peut être calculé (Menu › Clés API).");
  if (info.cles.tomtom && info.quota.utilise >= info.quota.max * 0.9) ligne("attention", "Quota TomTom", "Presque épuisé pour aujourd'hui : les calculs risquent d'être refusés jusqu'à demain.");
  ligne(info.cles.openChargeMap ? "ok" : "info", "Clé Open Charge Map (bornes)", info.cles.openChargeMap ? "Enregistrée." : "Absente : seules les bornes de la base officielle française sont affichées.");

  if (info.etatsBornesAgeMin === null) ligne("info", "État des bornes (libre, occupée, en panne)", "Pas encore téléchargé depuis l'ouverture de l'appli.");
  else ligne(info.etatsBornesAgeMin > 180 ? "attention" : "ok", "État des bornes (libre, occupée, en panne)", `Téléchargé ${age(info.etatsBornesAgeMin)}. L'occupation n'est affichée que si elle a moins d'une heure.`);

  if (info.guidagePrepare) {
    ligne(
      info.guidagePrepare.ageMin > 7 * 1440 ? "attention" : "ok",
      "Trajet préparé pour le hors ligne",
      `Un trajet enregistré ${age(info.guidagePrepare.ageMin)} (${info.guidagePrepare.nbArrets} borne(s) prévue(s)). Il ne sert que pour cette destination et ces bornes.`,
    );
  } else ligne("info", "Trajet préparé pour le hors ligne", "Aucun. Sans réseau, un guidage ne pourra pas démarrer.");
  ligne("info", "Carte de ma région hors ligne", info.regionPreparee ? "Téléchargée." : "Non téléchargée (Menu › Cartes).");
  return l;
}
