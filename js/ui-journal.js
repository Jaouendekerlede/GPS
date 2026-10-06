// Journal des recharges (Menu › Outils) : bilan mensuel, ajout manuel.

import { $, toast, euros, nombre, nombreOuUndefined, hint, tuile } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { obtenirProfilVehicule, listerJournal, ajouterAuJournal, retirerDuJournal } from "./storage.js";

function moisLisible(cle) {
  const [a, m] = cle.split("-").map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

// Km : ceux parcourus avec ces kWh, d'après la consommation du profil.
function bilanRecharges(entrees) {
  const consoVe = obtenirProfilVehicule().consommation_kwh_100km || 15;
  const kwh = entrees.reduce((s, e) => s + (e.kwh || 0), 0);
  const cout = entrees.reduce((s, e) => s + (e.cout_eur || 0), 0);
  const km = (kwh / consoVe) * 100;
  return { n: entrees.length, kwh, cout, km };
}

export function rendreJournal() {
  const journal = listerJournal();
  if (!journal.length) {
    $("ev-journal-bilan").innerHTML = hint("Aucune recharge enregistrée pour l'instant.");
    $("ev-journal-liste").innerHTML = "";
    return;
  }
  const parMois = new Map();
  for (const e of journal) {
    const d = new Date(e.ts);
    const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!parMois.has(cle)) parMois.set(cle, []);
    parMois.get(cle).push(e);
  }
  const lignes = [...parMois.entries()].slice(0, 6).map(([cle, entrees]) => {
    const b = bilanRecharges(entrees);
    return `<div class="ev-journal-mois"><strong>${escapeHtml(moisLisible(cle))}</strong><span>${b.n} recharge${b.n > 1 ? "s" : ""} · ${nombre(b.kwh, 1)} kWh · ${euros(b.cout)} · ~${nombre(b.km)} km</span></div>`;
  });
  const total = bilanRecharges(journal);
  $("ev-journal-bilan").innerHTML = `<div class="ev-tuiles">${tuile("cyan", `${nombre(total.kwh)} kWh`, "Énergie totale")}${tuile("violet", euros(total.cout), "Dépensé")}${tuile("good", `~${nombre(total.km)} km`, "Parcourus avec")}</div>${lignes.join("")}`;
  $("ev-journal-liste").innerHTML = journal
    .slice(0, 15)
    .map(
      (e) => `<div class="ev-journal-ligne"><span>${new Date(e.ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${escapeHtml(e.lieu || "Recharge")}</span><span>${nombre(e.kwh, 1)} kWh · ${euros(e.cout_eur || 0)}${e.prix_estime ? " (estimé)" : ""}</span><button type="button" class="ev-lien" data-journal="${escapeHtml(e.id)}" title="Supprimer">✕</button></div>`,
    )
    .join("");
  $("ev-journal-liste")
    .querySelectorAll("[data-journal]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        retirerDuJournal(btn.dataset.journal);
        rendreJournal();
      }),
    );
}

export function cablerJournal() {
  $("ev-journal-ajouter-btn").addEventListener("click", () => {
    const kwh = nombreOuUndefined($("ev-journal-kwh").value);
    if (!kwh || kwh <= 0) return toast("Indique l'énergie rechargée (kWh).");
    ajouterAuJournal({ lieu: $("ev-journal-lieu").value.trim() || "Recharge", kwh, cout_eur: nombreOuUndefined($("ev-journal-cout").value) ?? 0, source: "manuel" });
    for (const id of ["ev-journal-lieu", "ev-journal-kwh", "ev-journal-cout"]) $(id).value = "";
    toast("✅ Recharge ajoutée au journal");
    rendreJournal();
  });
}
