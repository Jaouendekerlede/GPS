// Profil › ☁️ Google Drive : connecter, sauvegarder, restaurer. Ensuite,
// sauvegarde automatique à la fin de chaque trajet guidé (« Terminer »).

import { $, toast } from "./ui-commun.js";
import { exporterDonnees, importerDonnees, lireReglages, sauverReglages } from "./storage.js";
import { obtenirJeton, envoyerSauvegarde, lireSauvegarde, sauvegardeEstPlusPauvre } from "./drive.js";
import { empreinteDonnees } from "./restauration.js";
import { DRIVE_CLIENT_ID } from "./config.js";

// Identifiant choisi dans le Profil (avancé), sinon celui de l'appli.
const clientId = () => lireReglages().drive_client_id || DRIVE_CLIENT_ID;

// Suivi (hors sauvegarde, propre à ce téléphone).
const CLE_SUIVI = "tve_drive";
const JOUR_MS = 24 * 3600000;

function suivi() {
  try {
    return JSON.parse(localStorage.getItem(CLE_SUIVI)) || {};
  } catch {
    return {};
  }
}

function majInfo() {
  const s = suivi();
  const el = $("gps-drive-info");
  if (!el) return;
  el.textContent = s.le ? `Dernière sauvegarde sur Drive : ${new Date(s.le).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Pas encore de sauvegarde sur Drive : touchez « Sauvegarder maintenant ».";
}

export async function sauvegarderSurDrive({ silencieux = false } = {}) {
  try {
    const jeton = await obtenirJeton(clientId(), { silencieux });
    const donnees = exporterDonnees();
    // Ne pas écraser une sauvegarde riche (clés, voiture…) par des données vides.
    const distante = await lireSauvegarde(jeton).catch(() => null);
    if (distante && sauvegardeEstPlusPauvre(donnees, distante.sauvegarde)) {
      const quand = new Date(distante.date).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      if (silencieux || !confirm(`La sauvegarde Drive du ${quand} contient vos clés API, mais cet appareil n'en a pas. La remplacer quand même (vous perdriez les clés sauvegardées) ?`)) return false;
    }
    await envoyerSauvegarde(jeton, donnees);
    localStorage.setItem(CLE_SUIVI, JSON.stringify({ le: Date.now(), empreinte: empreinteDonnees(donnees.donnees) }));
    sauverReglages({ drive_actif: true });
    majInfo();
    toast("☁️ Sauvegardé sur Google Drive");
    return true;
  } catch (e) {
    if (!silencieux) {
      toast(`⚠️ Drive : ${e.message}`);
      // Le toast disparaît vite : le message complet reste dans le bloc Drive.
      const info = $("gps-drive-info");
      if (info) info.textContent = `⚠️ ${e.message}`;
    }
    return false;
  }
}

async function restaurerDepuisDrive() {
  try {
    const jeton = await obtenirJeton(clientId());
    const r = await lireSauvegarde(jeton);
    if (!r) return toast("☁️ Aucune sauvegarde trouvée sur ce compte Google.");
    const quand = new Date(r.date).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    if (!confirm(`Restaurer la sauvegarde Drive du ${quand} ? Les données de ce téléphone seront remplacées.`)) return;
    const n = importerDonnees(r.sauvegarde);
    // Sauvegarde Drive gardée active sur ce téléphone après la restauration.
    sauverReglages({ drive_actif: true });
    toast(`✅ ${n} éléments restaurés : redémarrage…`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(`⚠️ Drive : ${e.message}`);
    const info = $("gps-drive-info");
    if (info) info.textContent = `⚠️ ${e.message}`;
  }
}

// Fin de trajet (appui sur « Terminer ») : sauvegarde si les données ont
// changé et que la dernière a plus d'un jour.
export function sauvegardeApresTrajet() {
  if (!lireReglages().drive_actif) return;
  const s = suivi();
  if (s.le && Date.now() - s.le < JOUR_MS && s.empreinte === empreinteDonnees(exporterDonnees().donnees)) return;
  sauvegarderSurDrive({ silencieux: true });
}

export function cablerDrive() {
  $("gps-drive-client").value = lireReglages().drive_client_id || "";
  $("gps-drive-client").placeholder = "Identifiant de l'appli (laisser vide)";
  $("gps-drive-client").addEventListener("change", (e) => {
    sauverReglages({ drive_client_id: e.target.value.trim() });
    majInfo();
  });
  $("gps-drive-sauver-btn").addEventListener("click", () => sauvegarderSurDrive());
  $("gps-drive-restaurer-btn").addEventListener("click", restaurerDepuisDrive);
  majInfo();
}
