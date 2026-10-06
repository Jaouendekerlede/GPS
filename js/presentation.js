// Présentation à l'ouverture : logo, petite voiture qui prend des virages (2,4 s),
// puis l'écran s'efface seul. Les mentions légales restent lisibles dans l'écran
// et dans Profil › Mentions légales. Jamais affichée pendant un guidage.
import { navigationActive, navigationInterrompue } from "./navigation.js";

export const MENTIONS_LEGALES =
  "GPS est une application de navigation gratuite, sans publicité, réalisée par Jean-Luc Rio avec l'aide de Claude (IA, Anthropic). " +
  "Cartes et routes : © contributeurs OpenStreetMap (licence ODbL). " +
  "Radars fixes : données officielles data.gouv.fr. Météo : Open-Meteo. " +
  "Itinéraire indicatif : respectez toujours le Code de la route et la signalisation.";

const DUREE_ANIMATION_MS = 2200;
const DUREE_TOTALE_MS = 3000;
const TRACE = "M -10 92 C 60 92, 70 22, 140 42 S 230 118, 310 48";

export function presentationOuverture() {
  const mentions = document.getElementById("gps-mention-legale");
  if (mentions) mentions.textContent = MENTIONS_LEGALES;
  if (navigationActive() || navigationInterrompue()) return;

  const ecran = document.createElement("div");
  ecran.className = "gps-presentation";
  ecran.setAttribute("role", "dialog");
  ecran.setAttribute("aria-label", "Présentation de GPS");
  ecran.innerHTML = `
    <img src="icons/gps-192.png" width="96" height="96" alt="">
    <h1>GPS</h1>
    <p class="gps-presentation-sous">Une navigation simple, sans superflu</p>
    <svg viewBox="0 0 300 130" width="300" height="130" aria-hidden="true">
      <path d="${TRACE}" fill="none" stroke="#334155" stroke-width="30" stroke-linecap="round"/>
      <path d="${TRACE}" fill="none" stroke="#e2e8f0" stroke-width="2" stroke-dasharray="8 10" opacity="0.8"/>
      <g>
        <text font-size="30" text-anchor="middle" dominant-baseline="central">🚗</text>
        <animateMotion dur="${DUREE_ANIMATION_MS}ms" begin="0.2s" fill="freeze" rotate="auto" path="${TRACE}"/>
      </g>
    </svg>
    <p class="gps-presentation-legal">${MENTIONS_LEGALES}</p>
    <p class="gps-presentation-suite">Touchez l'écran pour continuer</p>`;
  document.body.appendChild(ecran);

  const fermer = () => {
    ecran.classList.add("gps-presentation-fermee");
    setTimeout(() => ecran.remove(), 500);
  };
  ecran.addEventListener("click", fermer);
  setTimeout(fermer, DUREE_TOTALE_MS - 500);
}
