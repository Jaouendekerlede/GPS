// Onglet Outils › 📊 Mes statistiques : tuiles de chiffres (pas de
// graphique : chaque valeur se lit directement).

import { $, euros, nombre, tuile } from "./ui-commun.js";
import { listerJournal, listerTrajetsFaits } from "./storage.js";
import { statistiques } from "./statistiques.js";

let periode = "mois";

export function rendreStats() {
  for (const b of document.querySelectorAll("[data-periode]")) b.classList.toggle("active", b.dataset.periode === periode);
  const s = statistiques(listerTrajetsFaits(), listerJournal(), periode, Date.now());
  $("ev-stats-tuiles").innerHTML = s.trajets || s.recharges
    ? [
        tuile("good", `${nombre(s.km)} km`, `${s.trajets} trajet${s.trajets > 1 ? "s" : ""} guidé${s.trajets > 1 ? "s" : ""}`),
        tuile("good", `${nombre(s.kwh)} kWh`, "Consommés (estimé)"),
        tuile("warn", euros(s.cout_recharges), `${s.recharges} recharge${s.recharges > 1 ? "s" : ""} · ${nombre(s.kwh_recharges)} kWh`),
        tuile("good", `${nombre(s.cout_km * 100, 1)} €`, "Pour 100 km"),
        tuile("good", `${nombre(s.co2_evite_kg)} kg`, "De CO₂ évités (~)"),
      ].join("")
    : `<div class="ev-hint">Rien encore sur cette période : les trajets guidés et le journal des recharges alimentent ces chiffres.</div>`;
}

export function cablerStats() {
  for (const b of document.querySelectorAll("[data-periode]")) {
    b.addEventListener("click", () => {
      periode = b.dataset.periode;
      rendreStats();
    });
  }
}
