// « 📤 Partager ce trajet » : résumé lisible (départ, arrivée, arrêts) et
// lien Google Maps avec les recharges comme étapes.

import { toast } from "./ui-commun.js";
import { formaterMinutes } from "./planner.js";

const nomCourt = (n) => String(n || "").split(",")[0].trim();
const heure = (ms) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function boutonPartage() {
  return `<button type="button" id="ev-partager-trajet-btn" class="ev-btn ev-btn-plein">📤 Partager ce trajet</button>`;
}

export function texteTrajet(p) {
  const depart = p.depart_ms || Date.now();
  const total = p.duree_totale_min ?? p.duree_min ?? 0;
  const lignes = [`🚗 ${nomCourt(p.from_name)} → ${nomCourt(p.to_name)}`, `Départ ${heure(depart)}, arrivée vers ${heure(depart + total * 60000)} · ${Math.round(p.distance_km)} km · ${formaterMinutes(total)}`];
  for (const a of p.arrets || []) lignes.push(`🔋 ${a.nom_borne} (km ${Math.round(a.km_depuis_depart)}, ~${a.temps_charge_min} min)`);
  const etapes = (p.arrets || []).map((a) => `${a.lat.toFixed(5)},${a.lon.toFixed(5)}`).join("|");
  const lien = `https://www.google.com/maps/dir/?api=1&origin=${p.from_lat},${p.from_lon}&destination=${p.to_lat},${p.to_lon}${etapes ? `&waypoints=${encodeURIComponent(etapes)}` : ""}&travelmode=driving`;
  return { texte: lignes.join("\n"), lien };
}

export async function partagerTrajet(p) {
  const { texte, lien } = texteTrajet(p);
  if (navigator.share) {
    try {
      await navigator.share({ title: "Mon trajet", text: texte, url: lien });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${texte}\n${lien}`);
    toast("📋 Trajet copié : colle-le dans un message.");
  } catch {
    toast("⚠️ Partage impossible sur ce navigateur.");
  }
}
