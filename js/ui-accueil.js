// Accueil du premier lancement (et « Revoir la présentation »).

import { escapeHtml } from "./util.js";
import { sauverReglages } from "./storage.js";

const PAGES_ACCUEIL = [
  {
    icone: "⚡",
    titre: "Bienvenue dans GPS",
    texte: "Les bornes de recharge autour de toi, et des trajets en voiture électrique avec les arrêts de recharge calculés pour ta voiture : batterie, météo, relief, prix.",
  },
  {
    icone: "📧",
    titre: "Nouveau téléphone ?",
    texte: "Si tu avais déjà GPS ailleurs, touche simplement le lien de restauration reçu par e-mail : clés, voiture et réglages reviennent tout seuls. Sinon, continue.",
  },
  {
    icone: "🔑",
    titre: "Deux clés gratuites",
    texte: "TomTom calcule les itinéraires, Open Charge Map trouve les bornes. Crée-les gratuitement (liens dans Menu › Clés API) puis colle-les dans « Clés API ». Elles restent dans ce téléphone.",
    action: { libelle: "Saisir mes clés", vue: "profil" },
  },
  {
    icone: "🚗",
    titre: "Ta voiture",
    texte: "Toujours dans 🚗 Profil : capacité de la batterie, consommation, puissances de charge et prises acceptées. Les calculs s'y adaptent.",
  },
  {
    icone: "💡",
    titre: "Quelques astuces",
    texte: "• En roulant, tout se fait à la voix : 🎤 « prochaine borne ? », « trouve un café »… et « oui » / « non » aux questions de l'appli.\n• Toucher le bandeau : prochaines étapes. Appui long sur la carte : y aller.\n• 🎬 Mode démo : essayer la navigation sans rouler.\n• Profil › Aide et astuces : tout le reste.",
  },
];

export function afficherAccueil(ouvrirVue) {
  document.getElementById("ev-accueil")?.remove();
  const fond = document.createElement("div");
  fond.id = "ev-accueil";
  fond.className = "ev-accueil";
  document.body.appendChild(fond);
  let page = 0;
  const fermer = () => {
    sauverReglages({ accueil_vu: true });
    fond.remove();
  };
  const rendre = () => {
    const p = PAGES_ACCUEIL[page];
    const derniere = page === PAGES_ACCUEIL.length - 1;
    fond.innerHTML = `
      <div class="ev-accueil-carte" role="dialog" aria-label="Présentation de l'appli">
        <div class="ev-accueil-icone">${p.icone}</div>
        <h2>${escapeHtml(p.titre)}</h2>
        <p>${escapeHtml(p.texte).replace(/\n/g, "<br>")}</p>
        ${p.action ? `<button type="button" class="ev-btn" data-accueil="action">${escapeHtml(p.action.libelle)}</button>` : ""}
        <div class="ev-accueil-points">${PAGES_ACCUEIL.map((_, i) => `<span class="${i === page ? "actif" : ""}"></span>`).join("")}</div>
        <div class="ev-accueil-boutons">
          <button type="button" class="ev-lien" data-accueil="passer">${derniere ? "" : "Passer"}</button>
          <button type="button" class="ev-btn-principal" data-accueil="suivant">${derniere ? "C'est parti !" : "Suivant"}</button>
        </div>
      </div>`;
    fond.querySelector('[data-accueil="suivant"]').addEventListener("click", () => {
      if (derniere) fermer();
      else {
        page++;
        rendre();
      }
    });
    fond.querySelector('[data-accueil="passer"]').addEventListener("click", fermer);
    fond.querySelector('[data-accueil="action"]')?.addEventListener("click", () => {
      fermer();
      ouvrirVue?.(p.action.vue);
    });
  };
  rendre();
}
