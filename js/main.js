import { brancherCapture, noter } from "./journal-erreurs.js";
import { initialiserUI, executerAction, viderChampsTrajet } from "./ui.js";
import { presentationOuverture } from "./presentation.js";
import { navigationActive, navigationInterrompue } from "./navigation.js";
import { restaurerDepuisAdresse, proposerRappelSauvegarde } from "./ui-sauvegarde.js";
import { proposerInstallation } from "./ui-installation.js";
import { toast } from "./ui-commun.js";

const DELAI_RAPPEL_SAUVEGARDE_MS = 8000;

brancherCapture();
noter("appli", "ouverture");

// Ouverte par un lien de restauration : les données sont remises avant
// que l'interface ne les lise.
const restaures = await restaurerDepuisAdresse();
initialiserUI();
presentationOuverture();
if (restaures) {
  toast(`✅ Données restaurées (${restaures} éléments)`);
  proposerInstallation({ insister: true });
} else setTimeout(proposerRappelSauvegarde, DELAI_RAPPEL_SAUVEGARDE_MS);
// Bandeau « Sauvegarder sur Google Drive ? » retiré : son bouton « Plus
// tard » ne mémorisait pas le report, donc il revenait à chaque ouverture
// tant qu'aucune sauvegarde n'avait abouti -- demande explicite de
// l'utilisateur le 2026-09-28. La sauvegarde Drive reste disponible à la
// main dans Profil.

// Ouverte par un raccourci de l'icône (appui long sur l'icône du téléphone).
const actionRaccourci = new URLSearchParams(location.search).get("action");
if (actionRaccourci) {
  history.replaceState(null, "", location.pathname + location.hash);
  executerAction(actionRaccourci);
}
// Lien ouvert alors que l'appli l'était déjà : même page, pas de nouveau
// démarrage, on le provoque.
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#restaurer=")) location.reload();
});

// Champs départ/destination vidés à chaque réouverture de l'appli -- pas
// seulement au tout premier chargement : sur téléphone, le système ne
// recharge souvent pas vraiment la page en revenant dessus (ni rechargement,
// ni même "pageshow" depuis le cache de navigation), donc on s'appuie sur le
// retour au premier plan. On ne touche à rien pendant une navigation active
// (coupée ou non) ni si un résultat de trajet est actuellement affiché : ce
// n'est alors pas une réouverture, mais une utilisation en cours.
const DELAI_REOUVERTURE_MS = 2 * 60 * 1000;
let masqueeDepuis = null;

function reouvertureEnCours() {
  const resultatAffiche = !document.getElementById("vue-resultat")?.classList.contains("hidden");
  return !navigationActive() && !navigationInterrompue() && !resultatAffiche;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    masqueeDepuis = Date.now();
  } else if (masqueeDepuis && Date.now() - masqueeDepuis >= DELAI_REOUVERTURE_MS && reouvertureEnCours()) {
    viderChampsTrajet();
  }
});
// Restauration depuis le cache de navigation du système (bfcache) : une vraie
// réouverture, même sans passer par "hidden" juste avant (ex. appli jamais
// vraiment masquée mais reprise par le système après un moment).
window.addEventListener("pageshow", (e) => {
  if (e.persisted && reouvertureEnCours()) viderChampsTrajet();
});

const VERIFICATION_MAJ_MS = 30 * 60 * 1000;

// Recharge avec la nouvelle version dès que le guidage est arrêté.
// Version de cette copie de l'application (à mettre à jour à chaque publication, avec le cache du service worker).
const VERSION_EN_COURS = "gps-v43";

// Bandeau « Mettre à jour » : la mise à jour n'est plus automatique, vous la lancez quand vous voulez.
function afficherBandeauMiseAJour() {
  if (document.querySelector(".gps-bandeau-maj")) return;
  const bandeau = document.createElement("div");
  bandeau.className = "gps-bandeau-maj";
  bandeau.setAttribute("role", "status");
  bandeau.innerHTML = "<span>Nouvelle version disponible</span><button type=\"button\">Mettre à jour</button>";
  bandeau.querySelector("button").addEventListener("click", () => {
    if (navigationActive()) { toast("Terminez le guidage, puis mettez à jour."); return; }
    location.reload();
  });
  document.body.appendChild(bandeau);
}

if ("serviceWorker" in navigator) {
  // Au tout premier lancement, l'installation n'est pas une « mise à jour ».
  let avaitUneVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (avaitUneVersion) afficherBandeauMiseAJour();
    else avaitUneVersion = true;
  });
  window.addEventListener("load", async () => {
    try {
      const inscription = await navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" });
      const verifier = () => inscription.update().catch((e) => console.warn("[SW] Vérification de mise à jour échouée", e));
      verifier();
      setInterval(verifier, VERIFICATION_MAJ_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") verifier();
      });
    } catch (e) {
      console.warn("[SW] Enregistrement échoué", e);
    }
  });
}

// Vérifie à chaque ouverture (et au retour sur l'appli) si une version plus récente est publiée.
async function verifierNouvelleVersion() {
  try {
    const texte = await (await fetch("./service-worker.js", { cache: "no-store" })).text();
    const m = texte.match(/CACHE_NOM = "([^"]+)"/);
    if (m && m[1] !== VERSION_EN_COURS) afficherBandeauMiseAJour();
  } catch {
    // Hors ligne : pas de vérification.
  }
}
verifierNouvelleVersion();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") verifierNouvelleVersion();
});
