// Écran de présentation à l'ouverture : nom, propriétaire, droits. Léger
// (fermé d'un toucher, sinon seul au bout de quelques secondes) et jamais
// devant une navigation en cours : au volant, l'appli doit rester immédiate.

export const PROPRIETAIRE = "Jean-Luc RIO";
export const ANNEE = 2026;

export const MENTION_COURTE = `© ${ANNEE} ${PROPRIETAIRE} — Tous droits réservés`;

export const MENTION_LEGALE = `Cette application, son code source, sa conception, ses textes et ses graphismes sont la propriété exclusive de ${PROPRIETAIRE}. Toute reproduction, représentation, modification, adaptation, diffusion ou exploitation, totale ou partielle, sans son autorisation écrite préalable est interdite et constitue une contrefaçon (articles L.122-4 et L.335-2 du Code de la propriété intellectuelle). Les bibliothèques et données tierces (Leaflet, MapLibre, OpenStreetMap, OpenFreeMap, TomTom, Open Charge Map…) restent soumises à leurs propres licences.`;

const DUREE_AFFICHAGE_MS = 4500;

// Pas de présentation : navigation reprise, raccourci de l'icône ou lien de
// restauration (l'utilisateur veut agir tout de suite).
export function presentationAutorisee(adresse, navigationEnCours) {
  return !navigationEnCours && !/[?&]action=/.test(adresse.search || "") && !(adresse.hash || "").startsWith("#restaurer=");
}

export function afficherPresentation(doc = document) {
  const el = doc.getElementById("ev-presentation");
  if (!el) return;
  const fermer = () => {
    el.classList.add("ev-presentation-fermee");
    setTimeout(() => el.remove(), 600);
  };
  el.querySelector(".ev-presentation-mention").textContent = MENTION_COURTE;
  el.querySelector(".ev-presentation-legal").textContent = MENTION_LEGALE;
  el.classList.remove("hidden");
  el.addEventListener("click", fermer, { once: true });
  setTimeout(fermer, DUREE_AFFICHAGE_MS);
}

export function retirerPresentation(doc = document) {
  doc.getElementById("ev-presentation")?.remove();
}
