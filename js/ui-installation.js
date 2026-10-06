// Installation de l'appli sur l'écran d'accueil : Chrome ne l'autorise que
// sur un appui de l'utilisateur, on lui présente donc un bouton plutôt que
// de l'envoyer chercher « Installer » dans le menu ⋮.

import { $, toast, bandeau } from "./ui-commun.js";
import { navigationActive } from "./navigation.js";

// Refus du bandeau (hors clé « trajetve_ » : propre à ce téléphone).
const CLE_REFUS = "tve_installation_refusee";
const DELAI_APRES_REFUS_MS = 14 * 24 * 60 * 60 * 1000;

let invite = null;
let insister = false;

export function estInstallee() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

export function majBoutonInstallation() {
  $("gps-installer-btn")?.classList.toggle("hidden", !invite || estInstallee());
}

function refuseRecemment() {
  try {
    return Date.now() - Number(localStorage.getItem(CLE_REFUS) || 0) < DELAI_APRES_REFUS_MS;
  } catch {
    return false;
  }
}

// Bandeau « Installer » dès que Chrome le permet. insister : juste après
// une restauration (le refus d'avant ne compte pas).
export function proposerInstallation(options = {}) {
  return; // GPS : pas de bandeau d'installation
  if (options.insister) insister = true;
  if (!invite || estInstallee() || navigationActive() || (!insister && refuseRecemment())) return;
  bandeau({
    id: "gps-bandeau-installation",
    texte: "📲 Installer GPS sur l'écran d'accueil ?",
    boutons: [
      {
        libelle: "Non merci",
        secondaire: true,
        action: () => {
          try {
            localStorage.setItem(CLE_REFUS, String(Date.now()));
          } catch {
            // Tant pis : le bandeau reviendra.
          }
        },
      },
      { libelle: "Installer", action: installerAppli },
    ],
  });
}

export async function installerAppli() {
  if (!invite) {
    alert(estInstallee() ? "GPS est déjà installée." : "Dans Chrome : menu ⋮ en haut à droite, puis « Installer l'application » (ou « Ajouter à l'écran d'accueil »).");
    return;
  }
  const i = invite;
  invite = null;
  majBoutonInstallation();
  await i.prompt();
  const { outcome } = await i.userChoice;
  if (outcome !== "accepted") toast("Installation annulée : bouton dans 🚗 Profil > Sauvegarde.");
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  invite = e;
  majBoutonInstallation();
  proposerInstallation();
});

window.addEventListener("appinstalled", () => {
  invite = null;
  majBoutonInstallation();
  toast("✅ GPS est installée sur l'écran d'accueil");
});
