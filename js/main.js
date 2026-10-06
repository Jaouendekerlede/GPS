import { brancherCapture, noter } from "./journal-erreurs.js";
import { initialiserUI, executerAction, proposerRechargeMaison, viderChampsTrajet } from "./ui.js";
import { navigationActive, navigationInterrompue } from "./navigation.js";
import { afficherPresentation, retirerPresentation, presentationAutorisee, MENTION_COURTE, MENTION_LEGALE } from "./presentation.js";
import { restaurerDepuisAdresse, proposerRappelSauvegarde } from "./ui-sauvegarde.js";
import { proposerInstallation } from "./ui-installation.js";
import { toast } from "./ui-commun.js";

const DELAI_RAPPEL_SAUVEGARDE_MS = 8000;

brancherCapture();
noter("appli", "ouverture");

// Présentation légère à l'ouverture (jamais devant une navigation à reprendre).
if (presentationAutorisee(location, navigationActive() || !!navigationInterrompue())) afficherPresentation();
else retirerPresentation();
// Mentions dans le Profil.
document.getElementById("ev-mention-profil").textContent = MENTION_COURTE;
document.getElementById("ev-mention-legale").textContent = MENTION_LEGALE;

// Ouverte par un lien de restauration : les données sont remises avant
// que l'interface ne les lise.
const restaures = await restaurerDepuisAdresse();
initialiserUI();
if (restaures) {
  toast(`✅ Données restaurées (${restaures} éléments)`);
  proposerInstallation({ insister: true });
} else setTimeout(proposerRappelSauvegarde, DELAI_RAPPEL_SAUVEGARDE_MS);
setTimeout(proposerRechargeMaison, 3000);
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
function appliquerMiseAJour() {
  if (navigationActive()) {
    setTimeout(appliquerMiseAJour, 15000);
    return;
  }
  location.reload();
}

if ("serviceWorker" in navigator) {
  // Au tout premier lancement, l'installation n'est pas une « mise à jour ».
  let avaitUneVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (avaitUneVersion) appliquerMiseAJour();
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
