// SOS (accident, panne) : où suis-je exactement ? Route (A83…), sens,
// point kilométrique (PR, bornes OpenStreetMap « milestone »), commune et
// coordonnées GPS — ce que demandent les secours sur autoroute et voie express.

import { interrogerOverpass } from "./parkings.js";
import { haversineKm } from "./geo.js";

const EXCLUS = /^(footway|path|cycleway|steps|pedestrian|track|bridleway|corridor|elevator|proposed|construction)$/;

// Position GPS précise (ou la dernière connue si le GPS ne répond pas).
export function localiserSOS(derniere = null) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(derniere);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, precision: Math.round(p.coords.accuracy || 0), cap: p.coords.heading }),
      () => resolve(derniere),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 },
    );
  });
}

// Route la plus proche (numéro, nom) et PR le plus proche (km affiché).
export async function routeEtPR(lat, lon) {
  const q = `[out:json][timeout:15];way(around:40,${lat},${lon})["highway"];out tags center;node(around:2500,${lat},${lon})["highway"="milestone"];out;`;
  const r = await interrogerOverpass(q);
  if (!r.ok) return { route: null, pr: null };
  const voies = r.elements.filter((e) => e.type === "way" && !EXCLUS.test(e.tags?.highway || ""));
  const rang = (h) => ["motorway", "trunk", "motorway_link", "trunk_link", "primary", "secondary", "tertiary"].indexOf(h);
  voies.sort((a, b) => (rang(a.tags.highway) + 1 || 99) - (rang(b.tags.highway) + 1 || 99));
  const v = voies[0]?.tags;
  const route = v ? { numero: v.ref || "", nom: v.name || "", type: v.highway, rapide: /^(motorway|trunk)/.test(v.highway) } : null;
  const bornes = r.elements
    .filter((e) => e.type === "node")
    .map((e) => ({ km: e.tags?.distance || e.tags?.pk || e.tags?.name || e.tags?.ref || "", d: haversineKm(lat, lon, e.lat, e.lon) * 1000 }))
    .filter((b) => b.km)
    .sort((a, b) => a.d - b.d);
  const pr = bornes[0] ? { km: String(bornes[0].km).replace(".", ","), distanceM: Math.round(bornes[0].d / 10) * 10 } : null;
  return { route, pr };
}

// Commune (Nominatim, adresse inverse).
export async function communeSOS(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=fr`);
    if (!r.ok) return "";
    const a = (await r.json()).address || {};
    return [a.road, a.village || a.town || a.city || a.municipality, a.postcode].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

const POINTS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
export function capEnClair(cap) {
  return Number.isFinite(cap) ? POINTS[Math.round((((cap % 360) + 360) % 360) / 45) % 8] : "";
}

function routeTexte(route) {
  if (!route) return "";
  return route.numero ? `${route.numero}${route.nom && !route.nom.includes(route.numero) ? ` (${route.nom})` : ""}` : route.nom;
}

// info : { lat, lon, precision, route, pr, commune, sens, cap, reperes }
export function texteSOS(info, motif = "panne ou accident") {
  const lignes = [`🆘 ${motif[0].toUpperCase()}${motif.slice(1)} : j'ai besoin d'aide.`];
  const r = routeTexte(info.route);
  if (r) lignes.push(`Route : ${r}${info.sens ? `, sens ${info.sens}` : info.cap != null && capEnClair(info.cap) ? `, direction ${capEnClair(info.cap)}` : ""}`);
  if (info.reperes) lignes.push(`Repère : ${info.reperes}`);
  if (info.pr) lignes.push(`Point kilométrique (PR) le plus proche : ${info.pr.km}${info.pr.distanceM > 50 ? ` (à ${info.pr.distanceM} m)` : ""}`);
  if (info.commune) lignes.push(`Lieu : ${info.commune}`);
  lignes.push(`GPS : ${info.lat.toFixed(5)}, ${info.lon.toFixed(5)}${info.precision ? ` (précision ${info.precision} m)` : ""}`);
  lignes.push(`Carte : https://www.google.com/maps?q=${info.lat.toFixed(5)},${info.lon.toFixed(5)}`);
  lignes.push("Véhicule : voiture électrique (Hyundai Kona).");
  return lignes.join("\n");
}

// Version à lire à voix haute (pour la dicter au téléphone).
export function phraseSOS(info) {
  const morceaux = [];
  const r = routeTexte(info.route);
  if (r) morceaux.push(`Vous êtes sur ${r.replace(/^A\s?(\d+)/, "l'autoroute A $1").replace(/^N\s?(\d+)/, "la nationale $1")}${info.sens ? `, sens ${info.sens}` : ""}`);
  if (info.reperes) morceaux.push(info.reperes);
  if (info.pr) morceaux.push(`près du point kilométrique ${info.pr.km}`);
  if (info.commune) morceaux.push(`lieu : ${info.commune}`);
  morceaux.push(`coordonnées GPS : ${info.lat.toFixed(5).replace(".", " virgule ")}, ${info.lon.toFixed(5).replace(".", " virgule ")}`);
  return `${morceaux.join(", ")}. Voiture électrique.`;
}
