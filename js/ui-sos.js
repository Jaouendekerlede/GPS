// Panneau 🆘 SOS : position exacte à communiquer, appel du 112, envoi de la
// position, lecture à voix haute, consignes (autoroute, voiture électrique).

import { $, toast } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { localiserSOS, routeEtPR, communeSOS, texteSOS, phraseSOS } from "./sos.js";

let infoActuelle = null;
let surBornes = null;

function lire(texte) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texte);
  u.lang = "fr-FR";
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

function rendre(info, chargement) {
  const r = info?.route;
  const lignes = info
    ? [
        r ? `<div class="ev-sos-ligne"><span>Route</span><strong>${escapeHtml(r.numero || r.nom || "?")}${r.numero && r.nom ? ` <small>${escapeHtml(r.nom)}</small>` : ""}</strong></div>` : "",
        info.sens ? `<div class="ev-sos-ligne"><span>Sens</span><strong>vers ${escapeHtml(info.sens)}</strong></div>` : "",
        info.reperes ? `<div class="ev-sos-ligne"><span>Repère</span><strong>${escapeHtml(info.reperes)}</strong></div>` : "",
        info.pr ? `<div class="ev-sos-ligne"><span>PR (borne km)</span><strong>${escapeHtml(info.pr.km)}${info.pr.distanceM > 50 ? ` <small>à ${info.pr.distanceM} m</small>` : ""}</strong></div>` : "",
        info.commune ? `<div class="ev-sos-ligne"><span>Lieu</span><strong>${escapeHtml(info.commune)}</strong></div>` : "",
        `<div class="ev-sos-ligne"><span>GPS</span><strong>${info.lat.toFixed(5)}, ${info.lon.toFixed(5)}${info.precision ? ` <small>±${info.precision} m</small>` : ""}</strong></div>`,
      ].join("")
    : "";
  $("ev-sos-position").innerHTML = (chargement ? `<div class="ev-hint">⏳ Localisation précise en cours…</div>` : "") + (lignes || (!chargement ? `<div class="ev-hint">⚠️ Position introuvable : activez la localisation.</div>` : ""));
}

// contexte : { pos (dernière position connue), sens (vers…), bornes (fonction « batterie vide ») }
export async function ouvrirSOS(contexte = {}) {
  surBornes = contexte.bornes || surBornes;
  $("ev-sos").classList.remove("hidden");
  infoActuelle = contexte.pos ? { ...contexte.pos, sens: contexte.sens || "", reperes: contexte.reperes || "" } : null;
  rendre(infoActuelle, true);
  const pos = await localiserSOS(contexte.pos || null);
  if (!pos) return rendre(null, false);
  infoActuelle = { ...pos, sens: contexte.sens || "", reperes: contexte.reperes || "" };
  rendre(infoActuelle, true);
  const [rp, commune] = await Promise.all([routeEtPR(pos.lat, pos.lon), communeSOS(pos.lat, pos.lon)]);
  infoActuelle = { ...infoActuelle, ...rp, commune };
  rendre(infoActuelle, false);
  if (contexte.lireAHauteVoix) lire(phraseSOS(infoActuelle));
}

async function partager() {
  if (!infoActuelle) return;
  const texte = texteSOS(infoActuelle);
  if (navigator.share) {
    try {
      await navigator.share({ title: "SOS - ma position", text: texte });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(texte);
    toast("📋 Position copiée : collez-la dans un SMS.");
  } catch {
    toast(texte);
  }
}

export function cablerSOS() {
  $("ev-sos-fermer").addEventListener("click", () => {
    $("ev-sos").classList.add("hidden");
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  });
  $("ev-sos-partager").addEventListener("click", partager);
  $("ev-sos-lire").addEventListener("click", () => infoActuelle && lire(phraseSOS(infoActuelle)));
  $("ev-sos-bornes").addEventListener("click", () => {
    $("ev-sos").classList.add("hidden");
    surBornes?.();
  });
}
