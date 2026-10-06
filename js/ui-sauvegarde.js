// Sauvegarde et restauration de toutes les données (changement de téléphone) :
// lien de restauration envoyé par e-mail, ou fichier.

import { $, toast, telechargerTexte, bandeau } from "./ui-commun.js";
import { exporterDonnees, importerDonnees } from "./storage.js";
import { creerLienRestauration, estLienRestauration, lireLienRestauration, empreinteDonnees, noterLienEnvoye, reporterRappel, dateDernierLien, rappelSauvegardeNecessaire } from "./restauration.js";
import { navigationActive } from "./navigation.js";

// Sauvegarde : partage du fichier (Drive, Gmail…) si le téléphone le
// permet, sinon téléchargement.
export async function exporterSauvegarde() {
  const texte = JSON.stringify(exporterDonnees(), null, 1);
  const nom = `trajetve-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  const fichier = new File([texte], nom, { type: "application/json" });
  if (navigator.canShare?.({ files: [fichier] })) {
    try {
      await navigator.share({ files: [fichier], title: "Sauvegarde GPS" });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  telechargerTexte(nom, texte);
}

export async function importerSauvegarde(fichier) {
  try {
    const n = importerDonnees(JSON.parse(await fichier.text()));
    toast(`✅ Sauvegarde restaurée (${n} éléments) : redémarrage…`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(`⚠️ Import impossible : ${e.message}`);
  }
}

// ── Lien de restauration ────────────────────────────────────────────────────

const TEXTE_LIEN = (jour) =>
  `GPS : lien de restauration du ${jour}.\nSur un nouveau téléphone, touche ce lien : l'appli s'ouvre avec toutes tes données.\nIl contient tes clés : ne le transfère à personne.`;

export function majInfoLien() {
  const el = $("ev-lien-sauvegarde-info");
  if (!el) return;
  const d = dateDernierLien();
  el.textContent = d ? `Dernier lien envoyé le ${new Date(d).toLocaleDateString("fr-FR")}` : "Aucun lien envoyé pour l'instant";
}

// Partage (Gmail, Drive, Messages…) si le téléphone le permet, sinon copie
// du lien, sinon e-mail. Renvoie true si le lien est parti.
export async function envoyerLienRestauration() {
  let r;
  try {
    r = await creerLienRestauration();
  } catch (e) {
    toast(`⚠️ Lien impossible : ${e.message}`);
    return false;
  }
  const texte = TEXTE_LIEN(new Date().toLocaleDateString("fr-FR"));
  const envoye = (message) => {
    noterLienEnvoye(r.empreinte);
    majInfoLien();
    toast(message);
    return true;
  };
  if (navigator.share) {
    try {
      await navigator.share({ title: "Sauvegarde GPS", text: texte, url: r.lien });
      return envoye("✅ Lien envoyé. Garde bien cet e-mail.");
    } catch (e) {
      if (e.name === "AbortError") return false;
    }
  }
  try {
    await navigator.clipboard.writeText(r.lien);
    return envoye("📋 Lien copié : colle-le dans un e-mail à toi-même.");
  } catch {
    location.href = `mailto:?subject=${encodeURIComponent("Sauvegarde GPS")}&body=${encodeURIComponent(`${texte}\n\n${r.lien}`)}`;
    return envoye("📧 E-mail préparé : envoie-le à toi-même.");
  }
}

// Au démarrage, avant l'interface : l'appli a été ouverte par un lien de
// restauration. Renvoie le nombre d'éléments restaurés (0 sinon).
export async function restaurerDepuisAdresse() {
  const hash = location.hash;
  if (!estLienRestauration(hash)) return 0;
  // Le lien (et les clés) ne reste pas dans la barre d'adresse.
  history.replaceState(null, "", location.pathname + location.search);
  let sauvegarde;
  try {
    sauvegarde = await lireLienRestauration(hash);
  } catch {
    alert("⚠️ Ce lien de restauration est abîmé (coupé par la messagerie ?). Renvoie-en un depuis l'ancien téléphone, ou utilise un fichier de sauvegarde (Profil).");
    return 0;
  }
  const jour = sauvegarde?.date ? new Date(sauvegarde.date).toLocaleDateString("fr-FR") : "date inconnue";
  const dejaReglee = !!localStorage.getItem("trajetve_api_keys");
  if (!confirm(`Restaurer tes données GPS du ${jour} (clés, voiture, favoris, journal, réglages) ?${dejaReglee ? "\n\nLes données actuelles de ce téléphone seront remplacées." : ""}`)) return 0;
  try {
    const n = importerDonnees(sauvegarde);
    // Ces données sont celles du lien : pas de rappel de sauvegarde tout de suite.
    noterLienEnvoye(empreinteDonnees(exporterDonnees().donnees));
    return n;
  } catch (e) {
    alert(`⚠️ Restauration impossible : ${e.message}`);
    return 0;
  }
}

// Rappel discret au démarrage : données jamais sauvegardées, ou modifiées
// depuis plus d'un mois. Jamais pendant une navigation.
export function proposerRappelSauvegarde() {
  if (navigationActive() || !rappelSauvegardeNecessaire()) return;
  bandeau({
    id: "ev-rappel-sauvegarde",
    texte: dateDernierLien() ? "💾 Tes réglages ont changé : renvoie-toi le lien de restauration" : "💾 Envoie-toi le lien de restauration (utile si tu changes de téléphone)",
    boutons: [
      { libelle: "Plus tard", secondaire: true, action: () => reporterRappel() },
      { libelle: "Envoyer", action: () => envoyerLienRestauration() },
    ],
  });
}
