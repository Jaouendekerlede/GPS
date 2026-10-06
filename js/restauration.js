// Lien de restauration : toutes les données de l'appli (clés, profil,
// réglages, journal…) compressées dans l'adresse de l'appli, après le « # ».
// Envoyé par e-mail à soi-même, il suffit de le toucher sur un nouveau
// téléphone pour tout retrouver. La partie après « # » n'est jamais envoyée
// au serveur (GitHub) : les clés ne quittent que par l'e-mail choisi.

import { exporterDonnees } from "./storage.js";

const MARQUE = "#restaurer=";
// Suivi des envois (hors clé « trajetve_ » : pas dans la sauvegarde elle-même).
const CLE_SUIVI = "tve_lien_sauvegarde";
const JOUR_MS = 24 * 60 * 60 * 1000;
const DELAI_RAPPEL_MS = 30 * JOUR_MS;
const DELAI_PLUS_TARD_MS = 7 * JOUR_MS;

async function transformer(octets, flux) {
  const sortie = new Blob([octets]).stream().pipeThrough(flux);
  return new Uint8Array(await new Response(sortie).arrayBuffer());
}

function versBase64Url(octets) {
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(binaire).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function depuisBase64Url(texte) {
  const binaire = atob(texte.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binaire, (c) => c.charCodeAt(0));
}

// Empreinte courte des données : sert à savoir si elles ont changé depuis
// le dernier lien envoyé.
export function empreinteDonnees(donnees) {
  const texte = JSON.stringify(Object.keys(donnees).sort().map((k) => [k, donnees[k]]));
  let h = 5381;
  for (let i = 0; i < texte.length; i++) h = ((h * 33) ^ texte.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Adresse de l'appli (sans « # » ni paramètres) + données compressées.
export async function creerLienRestauration(adresse = location.href) {
  const sauvegarde = exporterDonnees();
  const octets = await transformer(new TextEncoder().encode(JSON.stringify(sauvegarde)), new CompressionStream("deflate"));
  const base = adresse.split("#")[0].split("?")[0];
  return { lien: `${base}${MARQUE}${versBase64Url(octets)}`, empreinte: empreinteDonnees(sauvegarde.donnees), date: sauvegarde.date };
}

export function estLienRestauration(hash) {
  return typeof hash === "string" && hash.startsWith(MARQUE);
}

// Sauvegarde contenue dans le « # » de l'adresse (lève une erreur si le lien
// est abîmé, par exemple coupé par la messagerie).
export async function lireLienRestauration(hash) {
  if (!estLienRestauration(hash)) return null;
  const octets = await transformer(depuisBase64Url(hash.slice(MARQUE.length)), new DecompressionStream("deflate"));
  return JSON.parse(new TextDecoder().decode(octets));
}

function lireSuivi() {
  try {
    return JSON.parse(localStorage.getItem(CLE_SUIVI)) || {};
  } catch {
    return {};
  }
}

function ecrireSuivi(suivi) {
  try {
    localStorage.setItem(CLE_SUIVI, JSON.stringify(suivi));
  } catch {
    // Stockage plein : le rappel reviendra simplement plus tôt.
  }
}

export function noterLienEnvoye(empreinte, maintenant = Date.now()) {
  ecrireSuivi({ envoye_le: maintenant, empreinte });
}

export function reporterRappel(maintenant = Date.now()) {
  ecrireSuivi({ ...lireSuivi(), plus_tard_jusqu: maintenant + DELAI_PLUS_TARD_MS });
}

export function dateDernierLien() {
  return lireSuivi().envoye_le || null;
}

// Rappeler d'envoyer le lien : jamais envoyé alors que des clés sont
// réglées, ou données modifiées depuis plus d'un mois. Pas avant la date
// choisie avec « Plus tard ».
export function rappelSauvegardeNecessaire(maintenant = Date.now()) {
  const donnees = exporterDonnees().donnees;
  let cles = {};
  try {
    cles = JSON.parse(donnees.trajetve_api_keys || "{}") || {};
  } catch {
    // Clés illisibles : rien d'important à sauvegarder.
  }
  if (!cles.tomtom && !cles.openChargeMap) return false;
  const suivi = lireSuivi();
  if (suivi.plus_tard_jusqu && maintenant < suivi.plus_tard_jusqu) return false;
  if (!suivi.envoye_le) return true;
  return suivi.empreinte !== empreinteDonnees(donnees) && maintenant - suivi.envoye_le >= DELAI_RAPPEL_MS;
}
