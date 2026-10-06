// « 🚗 Ma voiture » : où elle est garée (enregistré à l'arrivée d'une
// navigation), et comment y retourner à pied.

import { $, bandeau } from "./ui-commun.js";
import { voitureGaree, oublierVoitureGaree } from "./storage.js";
import { marquerVoitureGaree, centrer } from "./carte.js";
import { lienAPied } from "./util.js";

export function cablerVoitureGaree() {
  const chip = $("ev-voiture-chip");
  const maj = () => {
    const v = voitureGaree();
    chip.classList.toggle("hidden", !v);
    marquerVoitureGaree(v);
  };
  maj();
  document.addEventListener("ev-voiture-garee", maj);
  chip.addEventListener("click", () => {
    const v = voitureGaree();
    if (!v) return;
    centrer(v.lat, v.lon, 17);
    const quand = new Date(v.date).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    document.getElementById("ev-bandeau-garee")?.remove();
    bandeau({
      id: "ev-bandeau-garee",
      texte: `🚗 Garée ${quand}${v.lieu ? ` · ${v.lieu}` : ""}`,
      boutons: [
        { libelle: "Oublier", secondaire: true, action: () => (oublierVoitureGaree(), maj()) },
        { libelle: "🚶 Y aller", action: () => window.open(lienAPied(v.lat, v.lon), "_blank", "noopener") },
      ],
    });
  });
}
