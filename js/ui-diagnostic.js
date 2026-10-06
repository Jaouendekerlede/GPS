// « 🛟 Signaler un problème » : rassemble l'état de l'appli et le journal en
// un texte à envoyer (partage Android, sinon copie).

import { $, toast } from "./ui-commun.js";
import { getApiKeys } from "./config.js";
import { lireReglages } from "./storage.js";
import { appelsTomTomDuJour } from "./tomtom.js";
import { etatDiagnostic } from "./navigation.js";
import { lister, effacer, construireRapport } from "./journal-erreurs.js";

// Réglages qui contiennent des adresses ou identifiants : jamais dans le rapport.
const REGLAGES_PRIVES = ["adresse_domicile", "adresse_travail", "drive_client_id", "arrets_imposes", "conseil_recharge_vu"];

async function versionAppli() {
  try {
    const noms = (await caches.keys()).filter((n) => /^trajetve-v\d+$/.test(n)).sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    return noms.length ? noms[noms.length - 1].replace("trajetve-v", "") : "?";
  } catch {
    return "?";
  }
}

export async function rapportActuel() {
  const reglages = Object.fromEntries(Object.entries(lireReglages()).filter(([k]) => !REGLAGES_PRIVES.includes(k)));
  const cles = getApiKeys();
  let batterie = null;
  try {
    batterie = Math.round(((await navigator.getBattery?.())?.level ?? NaN) * 100);
    if (!Number.isFinite(batterie)) batterie = null;
  } catch {
    // API absente : pas d'information
  }
  const info = {
    version: await versionAppli(),
    date: new Date().toLocaleString("fr-FR"),
    appareil: navigator.userAgent,
    ecran: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}`,
    standalone: window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true,
    reseau: navigator.onLine,
    batterie_telephone: batterie,
    reglages,
    cles: { tomtom: !!cles.tomtom, openChargeMap: !!cles.openChargeMap },
    quota_tomtom: appelsTomTomDuJour(),
    navigation: etatDiagnostic(),
  };
  return construireRapport(info, lister(), [cles.tomtom, cles.openChargeMap]);
}

export async function envoyerRapport() {
  const texte = await rapportActuel();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Rapport GPS", text: texte });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(texte);
    toast("📋 Rapport copié : collez-le dans un message.");
  } catch {
    toast("⚠️ Envoi impossible sur ce navigateur.");
  }
}

export function majCompteurJournal() {
  const el = $("ev-diag-info");
  if (el) el.textContent = `${lister().length} événement(s) dans le journal de ce téléphone.`;
}

export function cablerDiagnostic() {
  $("ev-diag-envoyer").addEventListener("click", envoyerRapport);
  $("ev-diag-effacer").addEventListener("click", () => {
    if (!confirm("Effacer le journal de diagnostic ?")) return;
    effacer();
    majCompteurJournal();
  });
  majCompteurJournal();
}
