// « 🕐 Quand partir ? » : durée du trajet selon l'heure de départ, d'après
// le trafic prévu par TomTom (recharges comprises). Une barre par horaire,
// la valeur écrite sur chaque ligne, le plus court marqué d'une étoile.

import { $ } from "./ui-commun.js";
import { getApiKeys } from "./config.js";
import { calculerItineraireTomTom } from "./tomtom.js";
import { formaterMinutes } from "./planner.js";

const DECALAGES_MIN = [0, 30, 60, 120, 180];

const heure = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function boutonQuandPartir() {
  return `<button type="button" id="ev-quand-partir-btn" class="ev-btn ev-btn-plein">🕐 Quand partir ? (trafic prévu)</button><div id="ev-quand-partir" class="ev-quand-partir"></div>`;
}

export async function quandPartir(p) {
  const zone = $("ev-quand-partir");
  zone.innerHTML = `<div class="ev-hint">⏳ Calcul selon l'heure de départ…</div>`;
  const cle = getApiKeys().tomtom;
  const etapes = (p.arrets || []).map((a) => ({ lat: a.lat, lon: a.lon }));
  const charge = p.temps_charge_total_min || 0;
  const lignes = [];
  for (const d of DECALAGES_MIN) {
    const depart = new Date(Date.now() + d * 60000);
    const r = await calculerItineraireTomTom(cle, p.from_lat, p.from_lon, p.to_lat, p.to_lon, { etapes, departAt: d ? depart.toISOString().replace(/\.\d{3}Z$/, "Z") : null });
    if (!r.erreur) lignes.push({ d, depart, min: Math.round(r.summary.travelTimeInSeconds / 60) + charge });
  }
  if (!lignes.length) {
    zone.innerHTML = `<div class="ev-hint">⚠️ Trafic prévu indisponible pour le moment.</div>`;
    return;
  }
  const max = Math.max(...lignes.map((l) => l.min));
  const meilleur = Math.min(...lignes.map((l) => l.min));
  zone.innerHTML = lignes
    .map((l) => {
      const arrivee = new Date(l.depart.getTime() + l.min * 60000);
      const libelle = l.d ? heure(l.depart) : "Maintenant";
      const titre = `Départ ${libelle} → arrivée ${heure(arrivee)} (${formaterMinutes(l.min)})`;
      return `<div class="ev-qp-ligne" title="${titre}"><span class="ev-qp-heure">${libelle}</span><span class="ev-qp-barre"><i style="width:${Math.max(6, (l.min / max) * 100).toFixed(1)}%"></i></span><span class="ev-qp-valeur">${formaterMinutes(l.min)}${l.min === meilleur ? " ⭐" : ""}<small>→ ${heure(arrivee)}</small></span></div>`;
    })
    .join("") + `<div class="ev-hint">⭐ = le plus court. Recharges comprises ; trafic prévu par TomTom.</div>`;
}
