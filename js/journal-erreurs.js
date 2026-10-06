// Journal de diagnostic : les dernières erreurs et les événements importants
// (coupure de réseau, GPS, alertes affichées, réponses vocales…), gardés sur
// le téléphone. Un bouton « Signaler un problème » en fait un rapport à
// envoyer, sans clé ni adresse personnelle. Hors sauvegarde (clé « tve_ »).

const CLE = "tve_journal_diag";
export const MAX_ENTREES = 150;
const LONGUEUR_MAX = 240;
const DOUBLON_MS = 30000;

function lireTous() {
  try {
    return JSON.parse(localStorage.getItem(CLE)) || [];
  } catch {
    return [];
  }
}

// Retire ce qui ressemble à une clé ou à un jeton (paramètres d'URL, jetons
// « Bearer »), et toute valeur secrète connue.
export function assainir(texte, secrets = []) {
  let t = String(texte ?? "")
    .replace(/([?&](?:key|apikey|api_key|access_token|token)=)[^&\s"')]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/g, "$1***");
  for (const s of secrets) if (s && String(s).length >= 8) t = t.split(String(s)).join("***");
  return t;
}

// type : « erreur », « alerte », « nav », « reseau », « voix », « gps »,
// « signalement »… ; message : texte court.
export function noter(type, message, maintenant = Date.now()) {
  const msg = assainir(message).replace(/\s+/g, " ").trim().slice(0, LONGUEUR_MAX);
  if (!msg) return;
  const liste = lireTous();
  const dernier = liste[liste.length - 1];
  // Même événement répété coup sur coup : une seule ligne.
  if (dernier && dernier.type === type && dernier.msg === msg && maintenant - dernier.t < DOUBLON_MS) return;
  liste.push({ t: maintenant, type, msg });
  try {
    localStorage.setItem(CLE, JSON.stringify(liste.slice(-MAX_ENTREES)));
  } catch {
    // Stockage plein : le journal est facultatif.
  }
}

export function lister() {
  return lireTous();
}

export function effacer() {
  try {
    localStorage.removeItem(CLE);
  } catch {
    // rien à effacer
  }
}

// À appeler une fois au démarrage : erreurs JavaScript et avertissements
// de l'appli (« [TOMTOM] Erreur… ») rejoignent le journal.
export function brancherCapture(fen = window) {
  fen.addEventListener("error", (e) => noter("erreur", `${e.message || "erreur"} (${(e.filename || "").split("/").pop()}:${e.lineno || 0})`));
  fen.addEventListener("unhandledrejection", (e) => noter("erreur", `promesse rejetée : ${e.reason?.message || e.reason || "?"}`));
  for (const niveau of ["warn", "error"]) {
    const origine = fen.console[niveau].bind(fen.console);
    fen.console[niveau] = (...args) => {
      origine(...args);
      const texte = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : "")).join(" ");
      if (texte) noter(niveau === "warn" ? "avert" : "erreur", texte);
    };
  }
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// info : { version, date, appareil, reseau, standalone, batterie_telephone,
// vue, reglages (objet sans données personnelles), cles (booleens),
// quota_tomtom, navigation (résumé ou null) } ; entrees : le journal.
export function construireRapport(info, entrees, secrets = []) {
  const l = [];
  l.push("RAPPORT TRAJET VE (sans clé ni adresse personnelle)");
  l.push(`Version : ${info.version || "?"} · ${info.date}`);
  l.push(`Appareil : ${info.appareil || "?"}`);
  l.push(`Écran : ${info.ecran || "?"} · ${info.standalone ? "appli installée" : "navigateur"} · réseau : ${info.reseau ? "oui" : "NON"}${info.batterie_telephone != null ? ` · batterie du téléphone : ${info.batterie_telephone} %` : ""}`);
  l.push(`Clés : TomTom ${info.cles?.tomtom ? "oui" : "non"} · Open Charge Map ${info.cles?.openChargeMap ? "oui" : "non"} · appels TomTom du jour : ${info.quota_tomtom ?? "?"}`);
  if (info.navigation) l.push(`Navigation en cours : ${Object.entries(info.navigation).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  else l.push("Navigation : aucune en cours");
  l.push(`Réglages : ${Object.entries(info.reglages || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ") || "(défauts)"}`);
  const signets = entrees.filter((e) => e.type === "signalement");
  if (signets.length) l.push(`SIGNALEMENTS de l'utilisateur : ${signets.map((e) => `${hhmm(e.t)} (${e.msg})`).join(" ; ")}`);
  l.push("");
  l.push(`Journal (${entrees.length} derniers événements) :`);
  for (const e of entrees.slice(-80)) l.push(`${hhmm(e.t)} [${e.type}] ${e.msg}`);
  return assainir(l.join("\n"), secrets);
}
