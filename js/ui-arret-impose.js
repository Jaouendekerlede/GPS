// « 🔌 Recharger à » : une borne ⭐ favorite imposée comme arrêt (aire
// préférée). Le choix est retenu pour la destination tapée.

import { $ } from "./ui-commun.js";
import { listerBornesFavorites, lireReglages, sauverReglages } from "./storage.js";
import { escapeHtml } from "./util.js";

const cleDestination = () => $("ev-destination-input").value.trim().toLowerCase();

// Choix retenu pour cette destination, sinon « Automatique ».
function preselectionner() {
  const sel = $("ev-arret-impose");
  const memo = (lireReglages().arrets_imposes || {})[cleDestination()];
  sel.value = memo && [...sel.options].some((o) => o.value === memo) ? memo : "";
}

export function remplirArretsImposes() {
  const sel = $("ev-arret-impose");
  const favoris = listerBornesFavorites();
  sel.innerHTML = `<option value="">Automatique (le meilleur arrêt)</option>${favoris.map((f) => `<option value="${escapeHtml(f.id)}">⭐ ${escapeHtml(f.nom)}</option>`).join("")}`;
  sel.disabled = !favoris.length;
  $("ev-arret-impose-aide").textContent = favoris.length
    ? "L'itinéraire passe par cette borne et la recharge y est prévue. Retenu pour cette destination."
    : "Pour choisir votre aire préférée : touchez sa borne sur la carte, puis ⭐ (favori).";
  preselectionner();
}

export function cablerArretsImposes() {
  remplirArretsImposes();
  $("ev-arret-impose").addEventListener("change", () => {
    const cle = cleDestination();
    if (!cle) return;
    sauverReglages({ arrets_imposes: { ...(lireReglages().arrets_imposes || {}), [cle]: $("ev-arret-impose").value } });
  });
  $("ev-destination-input").addEventListener("change", preselectionner);
}

// { id, nom, lat, lon, adresse } ou null.
export function arretImposeChoisi() {
  const id = $("ev-arret-impose").value;
  return id ? listerBornesFavorites().find((f) => f.id === id) || null : null;
}
