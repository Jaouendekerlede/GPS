// Commandes vocales (reconnaissance vocale du navigateur, en français) :
// « prochaine borne ? », « coupe le son », « trouve une boulangerie »,
// « aller à Nantes »…

export function reconnaissanceDispo() {
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Écoute une phrase ; renvoie le texte reconnu, ou null.
export function ecouter() {
  return new Promise((resolve) => {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return resolve(null);
    const r = new R();
    r.lang = "fr-FR";
    r.interimResults = false;
    r.maxAlternatives = 1;
    let fini = false;
    const finir = (texte) => {
      if (fini) return;
      fini = true;
      resolve(texte);
    };
    r.onresult = (e) => finir(e.results?.[0]?.[0]?.transcript || null);
    r.onerror = () => finir(null);
    r.onend = () => finir(null);
    try {
      r.start();
    } catch {
      finir(null);
    }
  });
}

const RECHERCHES = [
  [/caf[ée]/, "café"],
  [/boulang|pain|croissant/, "boulangerie"],
  [/restau|manger|d[ée]jeuner|d[îi]ner/, "restaurant"],
  [/supermarch|courses|magasin/, "supermarché"],
  [/toilette|wc|pipi/, "toilettes"],
  [/lavage|laver la voiture/, "lavage auto"],
];

// Texte reconnu → { action, ... }. Actions : voix (valeur), barree, hud,
// partage, parkings, batterie, arrivee, borne, recherche (requete), aller
// (lieu), inconnu.
export function interpreterCommande(texte) {
  const t = String(texte || "").toLowerCase().replace(/[’']/g, "'").trim();
  if (!t) return { action: "inconnu" };
  if (/(coupe|couper|silence|tais[- ]toi|muet|arr[êe]te de parler)/.test(t)) return { action: "voix", valeur: false };
  if (/(remet|active|rallume|r[ée]active).*(son|voix)/.test(t)) return { action: "voix", valeur: true };
  if (/(route|rue|c'est) (est )?(barr[ée]|coup[ée]|ferm[ée])/.test(t)) return { action: "barree" };
  if (/(t[êe]te haute|hud|pare-brise)/.test(t)) return { action: "hud" };
  if (/(partag|envoi|pr[ée]vien)/.test(t)) return { action: "partage" };
  if (/(autre borne|changer de borne|borne (est )?(en panne|occup|hors))/.test(t)) return { action: "secours" };
  if (/(\bsos\b|urgence|accident|\bpanne\b|au secours|aidez-moi)/.test(t)) return { action: "sos" };
  if (/(signal(e|er) (un |le )?(probl[èe]me|bug)|note (ça|cela)|il y a un bug|\bbug\b)/.test(t)) return { action: "signaler" };
  if (/(il y a un radar|signal(e|er).*radar|radar (ici|l[àa])|attention radar)/.test(t)) return { action: "radar" };
  if (/(station[- ]service|essence|carburant|pompe|faire le plein|plein d'essence)/.test(t)) return { action: "essence" };
  if (/(aire de repos|aire de service|aire|pause caf|o[ùu] me reposer)/.test(t)) return { action: "repos" };
  if (/(parking|garer|stationner)/.test(t)) return { action: "parkings" };
  for (const [motif, requete] of RECHERCHES) if (motif.test(t)) return { action: "recherche", requete };
  if (/(batterie|autonomie|pourcentage)/.test(t)) return { action: "batterie" };
  if (/(prochaine borne|borne|recharge)/.test(t)) return { action: "borne" };
  if (/(heure d'arriv|quand .*arriv|combien de temps|temps restant|on arrive)/.test(t)) return { action: "arrivee" };
  if (/(maison|chez moi|domicile)/.test(t)) return { action: "aller", lieu: "Chez moi" };
  const m = /^(?:aller|va|allons|emm[eè]ne[- ]moi|conduis[- ]moi|direction|trajet|itin[ée]raire|je veux aller|guide[- ]moi)\s+(?:à|a|au|aux|vers|jusqu'à|jusqu'au|pour|en)?\s*(.+)$/.exec(t);
  if (m) return { action: "aller", lieu: m[1].charAt(0).toUpperCase() + m[1].slice(1) };
  return { action: "inconnu", texte: t };
}

// Réponse « oui / non » à une question posée à la voix : true, false, ou
// null (pas compris, pas de réponse → on ne change rien).
export function interpreterOuiNon(texte) {
  const t = String(texte || "").toLowerCase();
  if (!t.trim()) return null;
  if (/\b(non|pas|laisse|annule|surtout pas|jamais)\b/.test(t)) return false;
  if (/\b(oui|ouais|d'accord|ok|okay|vas-y|allez|volontiers|prends|go|bien sûr|exact)\b/.test(t)) return true;
  return null;
}

// « la deuxième », « le premier », « 3 »… → index (0, 1, 2), -1 pour
// « non / aucun », null si pas compris.
export function interpreterChoix(texte, nombre) {
  const t = String(texte || "").toLowerCase();
  if (!t.trim()) return null;
  if (/\b(non|aucun|aucune|rien|annule|laisse)\b/.test(t)) return -1;
  const mots = [/\b(premi[eè]re?|un|une|1)\b/, /\b(deuxi[eè]me|second|seconde|deux|2)\b/, /\b(troisi[eè]me|trois|3)\b/];
  for (let i = 0; i < Math.min(nombre, mots.length); i++) if (mots[i].test(t)) return i;
  return null;
}
