// Routes coupées connues avant de partir : on les marque sur la carte
// (croix de visée au centre), et les itinéraires les évitent ensuite.

import { $, toast } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { listerZonesEvitees, ajouterZoneEvitee, retirerZoneEvitee } from "./storage.js";
import { centreVisible, pixelCentreVisible, centrer } from "./carte.js";

function rendreListe() {
  const zones = listerZonesEvitees();
  $("ev-zones-evitees-liste").innerHTML = zones.length
    ? zones
        .map(
          (z) => `<div class="ev-zone-evitee"><span>🚧 ${escapeHtml(z.nom || "Route coupée")} · ${new Date(z.date).toLocaleDateString("fr-FR")}</span>
            <span><button type="button" data-voir="${z.id}" title="Voir sur la carte">🔍</button><button type="button" data-retirer="${z.id}" title="Ne plus éviter">✕</button></span></div>`,
        )
        .join("")
    : `<div class="ev-hint">Aucune pour l'instant.</div>`;
}

// Mode visée : la carte seule, une croix au centre, « Éviter ici ».
function viser(afficherVue) {
  afficherVue("trajet", { etat: "bas" });
  const croix = document.createElement("div");
  croix.className = "ev-visee";
  const barre = document.createElement("div");
  barre.className = "ev-visee-barre";
  barre.innerHTML = `<span>Déplace la carte pour mettre la croix sur l'endroit coupé, puis valide.</span><div><button type="button" class="ev-lien">Annuler</button><button type="button" class="ev-btn">✅ Éviter ici</button></div>`;
  const placer = () => {
    const p = pixelCentreVisible();
    croix.style.left = `${p.x}px`;
    croix.style.top = `${p.y}px`;
  };
  const fermer = () => {
    clearInterval(minuteur);
    croix.remove();
    barre.remove();
    afficherVue("trajet");
  };
  // Le panneau change de hauteur en s'animant : on suit la position.
  const minuteur = setInterval(placer, 300);
  setTimeout(placer, 50);
  barre.querySelector(".ev-lien").addEventListener("click", fermer);
  barre.querySelector(".ev-btn").addEventListener("click", () => {
    const c = centreVisible();
    ajouterZoneEvitee(c.lat, c.lon);
    fermer();
    rendreListe();
    toast("🚧 Endroit ajouté : les prochains itinéraires l'éviteront (recalcule le trajet).");
  });
  document.body.append(croix, barre);
}

export function cablerZonesEvitees(afficherVue) {
  rendreListe();
  $("ev-zone-eviter-btn").addEventListener("click", () => viser(afficherVue));
  $("ev-zones-evitees-liste").addEventListener("click", (e) => {
    const retirer = e.target.closest("[data-retirer]")?.dataset.retirer;
    const voir = e.target.closest("[data-voir]")?.dataset.voir;
    if (retirer) {
      retirerZoneEvitee(retirer);
      rendreListe();
    } else if (voir) {
      const z = listerZonesEvitees().find((x) => x.id === voir);
      if (z) {
        afficherVue("trajet", { etat: "bas" });
        centrer(z.lat, z.lon, 16);
      }
    }
  });
}
