// Adresses proposées pendant la saisie (départ, destination), comme les GPS.

import { suggestionsLieux, memoriserLieu } from "./geo.js";
import { centreVisible } from "./carte.js";
import { escapeHtml } from "./util.js";

const DELAI_SAISIE_MS = 300;
const LETTRES_MIN = 3;

export function cablerSuggestions(ids) {
  const liste = document.createElement("div");
  liste.className = "ev-suggestions hidden";
  liste.setAttribute("role", "listbox");
  document.body.appendChild(liste);
  let champ = null;
  let minuteur = null;
  let jeton = 0;
  let controleur = null;
  let resultats = [];
  const cacher = () => liste.classList.add("hidden");
  const placer = () => {
    const r = champ.getBoundingClientRect();
    liste.style.left = `${r.left}px`;
    liste.style.top = `${r.bottom + 4}px`;
    liste.style.width = `${r.width}px`;
  };
  // Garder le clavier ouvert pendant le choix.
  liste.addEventListener("mousedown", (e) => e.preventDefault());
  liste.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b || !champ) return;
    const s = resultats[Number(b.dataset.i)];
    champ.value = s.libelle;
    memoriserLieu(s.libelle, s.lat, s.lon);
    cacher();
    champ.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.setAttribute("autocomplete", "off");
    el.addEventListener("input", () => {
      champ = el;
      controleur?.abort();
      controleur = null;
      clearTimeout(minuteur);
      const texte = el.value.trim();
      if (texte.length < LETTRES_MIN) {
        jeton++;
        return cacher();
      }
      minuteur = setTimeout(async () => {
        const j = ++jeton;
        controleur = new AbortController();
        let pres = null;
        try {
          pres = centreVisible();
        } catch {
          // Carte pas prête : suggestions sans préférence de lieu.
        }
        resultats = await suggestionsLieux(texte, pres, controleur.signal);
        if (j !== jeton || champ !== el || document.activeElement !== el) return;
        if (!resultats.length) return cacher();
        liste.innerHTML = resultats.map((s, i) => `<button type="button" data-i="${i}"><strong>${escapeHtml(s.nom)}</strong>${s.detail ? `<span>${escapeHtml(s.detail)}</span>` : ""}</button>`).join("");
        placer();
        liste.classList.remove("hidden");
      }, DELAI_SAISIE_MS);
    });
    el.addEventListener("blur", () => setTimeout(cacher, 150));
  }
}
