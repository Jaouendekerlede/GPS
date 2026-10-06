// Petits outils partagés par les écrans de l'interface.

import { escapeHtml } from "./util.js";

export const $ = (id) => document.getElementById(id);

export function toast(message) {
  const el = $("ev-toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toast.minuteur);
  toast.minuteur = setTimeout(() => el.classList.remove("visible"), 2800);
}

export function euros(x) {
  return `${Number(x).toFixed(2).replace(".", ",")} €`;
}

export function nombre(x, dec = 0) {
  return Number(x).toFixed(dec).replace(".", ",");
}

export function nomCourt(nom) {
  const parts = String(nom || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  if (/^\d/.test(parts[0]) && parts[1]) return `${parts[0]} ${parts[1]}${parts[2] ? `, ${parts[2]}` : ""}`;
  return parts.slice(0, 2).join(", ");
}

export function nombreOuUndefined(valeur) {
  const n = parseFloat(valeur);
  return Number.isFinite(n) ? n : undefined;
}

export function hint(texte) {
  return `<div class="ev-hint">${escapeHtml(texte)}</div>`;
}

export function alerte(texte) {
  return `<div class="ev-alerte">${escapeHtml(texte)}</div>`;
}

export function tuile(couleur, valeur, label) {
  return `<div class="ev-tuile ${couleur}"><span class="t-valeur">${escapeHtml(valeur)}</span><span class="t-label">${escapeHtml(label)}</span></div>`;
}

export function telechargerTexte(nomFichier, texte) {
  const url = URL.createObjectURL(new Blob([texte], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nomFichier;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("⬇️ Fichier enregistré dans Téléchargements");
}

// ── Pastille de l'opérateur ────────────────────────────────────────────────
// Sigle aux couleurs des grands réseaux (pas les logos officiels, protégés et
// hébergés ailleurs) : on reconnaît le réseau d'un coup d'œil.

const RESEAUX = [
  [/tesla/i, "T", "#e82127"],
  [/ionity/i, "IO", "#2e2a78"],
  [/total/i, "TE", "#ed0000"],
  [/izivia|sodetrel/i, "IZ", "#00a19a"],
  [/electra/i, "EL", "#12b39a"],
  [/fastned/i, "FN", "#f5c400", "#1a1a1a"],
  [/allego/i, "AL", "#3fa535"],
  [/engie|vianeo/i, "EN", "#00aaff"],
  [/power\s*dot/i, "PD", "#e6007e"],
  [/freshmile/i, "FM", "#00a39a"],
  [/zunder/i, "ZU", "#0bb07b"],
  [/atlante/i, "AT", "#009ee0"],
  [/lidl/i, "LI", "#0050aa"],
  [/leclerc/i, "LC", "#0066b3"],
  [/carrefour/i, "CA", "#1e5bc6"],
  [/auchan/i, "AU", "#e2001a"],
  [/intermarch/i, "IM", "#d2001e"],
  [/super\s*u|syst[eè]me\s*u/i, "U", "#e2001a"],
  [/ouest\s*charge/i, "OC", "#0f6db3"],
  [/chargepoint/i, "CP", "#ff6a13"],
  [/shell|newmotion/i, "SH", "#fbce07", "#1a1a1a"],
  [/bp\b|pulse/i, "BP", "#009b3a"],
  [/mobilize|renault/i, "MO", "#1f2a44"],
];

export function badgeOperateur(nom) {
  if (!nom) return "";
  const reseau = RESEAUX.find(([motif]) => motif.test(nom));
  let sigle;
  let fond;
  let texte = "#ffffff";
  if (reseau) [, sigle, fond, texte = "#ffffff"] = reseau;
  else {
    // Réseau inconnu : initiales et couleur stable tirée du nom.
    const mots = nom.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((m) => m.length > 1);
    sigle = (mots.length > 1 ? mots[0][0] + mots[1][0] : (mots[0] || "?").slice(0, 2)).toUpperCase();
    let h = 0;
    for (const c of nom) h = (h * 31 + c.charCodeAt(0)) % 360;
    fond = `hsl(${h}, 45%, 38%)`;
  }
  return `<span class="ev-badge-op" style="background:${fond};color:${texte}" title="${escapeHtml(nom)}">${escapeHtml(sigle)}</span>`;
}

// Bandeau en bas de l'écran avec des boutons (un seul à la fois ; il se
// ferme au premier appui). boutons : [{ libelle, action, secondaire }].
export function bandeau({ id, texte, boutons }) {
  if (document.querySelector(".ev-maj")) return null;
  const el = document.createElement("div");
  el.id = id;
  el.className = "ev-maj";
  el.innerHTML = `<span></span><div class="ev-maj-boutons"></div>`;
  el.querySelector("span").textContent = texte;
  for (const b of boutons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = b.secondaire ? "ev-lien" : "ev-btn";
    btn.textContent = b.libelle;
    btn.addEventListener("click", () => {
      el.remove();
      b.action?.();
    });
    el.querySelector(".ev-maj-boutons").appendChild(btn);
  }
  document.body.appendChild(el);
  return el;
}
