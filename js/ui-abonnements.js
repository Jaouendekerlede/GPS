// Abonnements de recharge (Menu › Abonnements de recharge) : prix au kWh par réseau.

import { $, toast, euros, nombreOuUndefined, hint, badgeOperateur } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { listerAbonnements, sauverAbonnements } from "./storage.js";

export function rendreAbonnements() {
  const liste = listerAbonnements();
  $("ev-abonnements-liste").innerHTML = liste.length
    ? liste.map((a, i) => `<div class="ev-journal-ligne"><span>${badgeOperateur(a.reseau)}${escapeHtml(a.reseau)}</span><span>${euros(a.prix)}/kWh</span><button type="button" class="ev-lien" data-abo="${i}" title="Supprimer">✕</button></div>`).join("")
    : hint("Aucun abonnement : les tarifs publics sont utilisés.");
  $("ev-abonnements-liste")
    .querySelectorAll("[data-abo]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        const nouvelle = listerAbonnements();
        nouvelle.splice(Number(btn.dataset.abo), 1);
        sauverAbonnements(nouvelle);
        rendreAbonnements();
      }),
    );
}

export function cablerAbonnements() {
  $("ev-abo-ajouter-btn").addEventListener("click", () => {
    const reseau = $("ev-abo-reseau").value.trim();
    const prix = nombreOuUndefined($("ev-abo-prix").value);
    if (!reseau || !prix || prix <= 0) return toast("Indique le réseau et ton prix au kWh.");
    sauverAbonnements([...listerAbonnements().filter((a) => a.reseau.toLowerCase() !== reseau.toLowerCase()), { reseau, prix }]);
    $("ev-abo-reseau").value = "";
    $("ev-abo-prix").value = "";
    rendreAbonnements();
    toast(`💳 Abonnement ${reseau} enregistré`);
  });
}
