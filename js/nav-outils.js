// Outils de navigation sans écran ni carte (testables) : mise en forme des
// distances et heures, flèches dessinées du bandeau, construction de
// l'itinéraire de guidage à partir de la réponse TomTom, dessin des voies.

import { haversineKm, sortieRondPoint } from "./geo.js";
import { vitessesAutour } from "./zoom-nav.js";

export function heure(ms) {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function distanceAffichee(m) {
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

export function distanceParlee(m) {
  if (m >= 1000) {
    const km = Math.round(m / 100) / 10;
    return `${String(km).replace(".", ",")} kilomètre${km >= 2 ? "s" : ""}`;
  }
  return `${m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10} mètres`;
}

// Petites fautes des instructions TomTom en français.
export function corrigerFrancais(message) {
  return message.replace(/\bla premier\b/g, "la première").replace(/\bLa premier\b/g, "La première");
}

// « Puis… » en une ligne : l'essentiel de la manœuvre suivante.
export function messageCourt(message) {
  return minusculeInitiale(
    String(message || "")
      .replace(/^Vous (êtes|serez) arrivé.*$/i, "arrivée")
      .replace(/^Au rond-point, prenez la /i, "rond-point, ")
      .replace(/,? direction .*$/i, "")
      .replace(/^Tournez /i, "")
      .replace(/^Continuez tout droit/i, "tout droit"),
  );
}

export function minusculeInitiale(texte) {
  return texte ? texte.charAt(0).toLowerCase() + texte.slice(1) : "";
}

// Incertitude (en points de %) de la batterie estimée, après avoir consommé
// `pctConsomme` points depuis le dernier niveau donné par l'utilisateur.
// L'appli ne lit pas la batterie de la voiture : elle déduit le niveau de la
// consommation prévue, dont l'erreur s'accumule avec la distance. 15 % de
// l'énergie consommée est un ordre de grandeur (vent, chauffage, style de
// conduite), pas une mesure : à resserrer avec les écarts constatés aux bornes.
const PART_ERREUR_CONSOMMATION = 0.15;
export function incertitudeBatterie(pctConsomme) {
  return Math.round(1 + PART_ERREUR_CONSOMMATION * Math.max(0, pctConsomme || 0));
}

export function capEntre(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const FLECHES = [
  [/ARRIVE/, "🏁"],
  [/WAYPOINT/, "🔋"],
  [/U_?TURN/, "↩️"],
  [/ROUNDABOUT/, "🔄"],
  [/FERRY/, "⛴️"],
  [/SHARP_RIGHT|TURN_RIGHT/, "➡️"],
  [/SHARP_LEFT|TURN_LEFT/, "⬅️"],
  [/BEAR_RIGHT|KEEP_RIGHT|EXIT_RIGHT|TAKE_EXIT/, "↗️"],
  [/BEAR_LEFT|KEEP_LEFT|EXIT_LEFT/, "↖️"],
];

export function fleche(manoeuvre) {
  for (const [motif, icone] of FLECHES) if (motif.test(manoeuvre || "")) return icone;
  return "⬆️";
}

// Flèches dessinées du bandeau (comme les GPS) : angle de sortie en degrés,
// dans le sens des aiguilles d'une montre depuis « tout droit ».
export const ANGLES_FLECHE = [
  [/SHARP_RIGHT/, 135],
  [/SHARP_LEFT/, -135],
  [/TURN_RIGHT/, 90],
  [/TURN_LEFT/, -90],
  [/BEAR_RIGHT|KEEP_RIGHT|EXIT_RIGHT|TAKE_EXIT|ENTER_|ENTRANCE_RAMP/, 40],
  [/BEAR_LEFT|KEEP_LEFT|EXIT_LEFT/, -40],
];
export const ANGLES_ROND_POINT = { ROUNDABOUT_CROSS: 0, ROUNDABOUT_RIGHT: 90, ROUNDABOUT_LEFT: -90, ROUNDABOUT_BACK: -160 };

export function pointeSvg(x, y, angle, longueur = 15, demi = 14) {
  const r = (angle * Math.PI) / 180;
  const [dx, dy] = [Math.sin(r), -Math.cos(r)];
  const pts = [
    [x + dx * longueur, y + dy * longueur],
    [x - dy * demi, y + dx * demi],
    [x + dy * demi, y - dx * demi],
  ];
  return `<polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`;
}

export function svgFleche(instr) {
  const m = instr?.manoeuvre || "";
  if (/ARRIVE|WAYPOINT|FERRY/.test(m)) return `<span class="ev-nav-fleche-emoji">${fleche(m)}</span>`;
  const trait = `fill="none" stroke="#fff" stroke-width="13" stroke-linejoin="round" stroke-linecap="butt"`;
  let dessin;
  if (/ROUNDABOUT/.test(m) && m in ANGLES_ROND_POINT) {
    const a = Math.max(-165, Math.min(165, instr.angleSortie ?? ANGLES_ROND_POINT[m]));
    const r = (a * Math.PI) / 180;
    const [sx, sy] = [50 + 18 * Math.sin(r), 42 - 18 * Math.cos(r)];
    const [ex, ey] = [50 + 34 * Math.sin(r), 42 - 34 * Math.cos(r)];
    const numero = instr.sortieRondPoint ? `<text x="50" y="49" text-anchor="middle" font-size="20" font-weight="900" fill="#fff" font-family="sans-serif">${instr.sortieRondPoint}</text>` : "";
    dessin = `<circle cx="50" cy="42" r="18" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="8"/><path d="M50 96 V60" ${trait}/><path d="M${sx.toFixed(1)} ${sy.toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)}" ${trait}/>${pointeSvg(ex, ey, a)}${numero}`;
  } else if (/U_?TURN/.test(m)) {
    dessin = `<path d="M64 96 V46 A17 17 0 0 0 30 46 V62" ${trait}/>${pointeSvg(30, 62, 180)}`;
  } else {
    const a = ANGLES_FLECHE.find(([motif]) => motif.test(m))?.[1] ?? 0;
    const r = (a * Math.PI) / 180;
    const [dx, dy] = [Math.sin(r), -Math.cos(r)];
    const [ex, ey] = [50 + 30 * dx, 50 + 30 * dy];
    dessin = `<path d="M50 96 L50 62 Q50 50 ${(50 + 12 * dx).toFixed(1)} ${(50 + 12 * dy).toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)}" ${trait}/>${pointeSvg(ex, ey, a)}`;
  }
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${dessin}</svg>`;
}

export function construireRoute(r) {
  const coords = r.coords;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]) * 1000);
  const dernier = cum.length - 1;

  const instructions = (r.guidance?.instructions || [])
    .filter((i) => i.message || i.maneuver)
    .map((i) => ({
      offset: cum[Math.min(Math.max(0, i.pointIndex ?? 0), dernier)],
      // « …, direction Nantes » quand TomTom ne le dit pas (voix et panneau).
      message: corrigerFrancais(i.message || "") + (i.signpostText && i.message && !i.message.includes(i.signpostText) ? `, direction ${i.signpostText}` : ""),
      manoeuvre: i.maneuver || "",
      type: i.instructionType || "",
      jonction: i.junctionType || "",
      // Pour le bandeau : nom de la rue (ou numéro de route) en gros.
      rue: i.street || "",
      numeros: i.roadNumbers || [],
      sortie: i.exitNumber || "",
      direction: i.signpostText || "",
      sortieRondPoint: i.roundaboutExitNumber || null,
      annonces: new Set(),
    }))
    .sort((a, b) => a.offset - b.offset);

  const limites = new Array(coords.length).fill(null);
  for (const s of r.sections || []) {
    const type = String(s.sectionType || "").toUpperCase().replace(/_/g, "");
    if (type !== "SPEEDLIMIT" || !s.maxSpeedLimitInKmh) continue;
    for (let i = Math.max(0, s.startPointIndex ?? 0); i <= Math.min(dernier, s.endPointIndex ?? 0); i++) limites[i] = s.maxSpeedLimitInKmh;
  }

  // Ronds-points : vraie sortie d'après le tracé (angle du pictogramme,
  // flèche sur la carte jusqu'à elle), et « Sortez ici » juste avant.
  for (const instr of [...instructions]) {
    if (!/ROUNDABOUT_/.test(instr.manoeuvre)) continue;
    const s = sortieRondPoint(coords, cum, instr.offset);
    if (!s) continue;
    instr.angleSortie = s.angle;
    instr.offsetSortie = s.offset;
    if (instructions.some((i) => i !== instr && Math.abs(i.offset - s.offset) < 40)) continue;
    instructions.push({ offset: s.offset, message: `Sortez ici${instr.rue ? ` sur ${instr.rue}` : ""}`, manoeuvre: "EXIT_RIGHT", type: "TURN", jonction: "ROUNDABOUT", rue: instr.rue, numeros: [], sortie: "", direction: "", sortieRondPoint: null, synthetique: true, annonces: new Set([1, 2]) });
  }
  instructions.sort((a, b) => a.offset - b.offset);

  // Limitations avant/après chaque manœuvre : repèrent les bretelles (zoom).
  for (const instr of instructions) {
    const v = vitessesAutour(instr.offset, cum, limites);
    instr.vitesseAvant = v.avant;
    instr.vitesseApres = v.apres;
  }

  // Étapes (bornes) = fins des tronçons TomTom ; durées par tronçon pour l'heure d'arrivée.
  const troncons = [];
  let indice = 0;
  for (const leg of r.legs || []) {
    const debutIdx = indice;
    indice += leg.nbPoints;
    const finIdx = Math.min(indice - 1, dernier);
    troncons.push({ debut: cum[debutIdx] ?? 0, fin: cum[finIdx], duree: leg.summary?.travelTimeInSeconds || 0 });
  }
  if (!troncons.length) troncons.push({ debut: 0, fin: cum[dernier], duree: r.summary?.travelTimeInSeconds || 0 });

  // Voies de circulation : la section se termine sur la manœuvre concernée,
  // et `follow` marque la ou les voies à prendre.
  const voies = (r.sections || [])
    .filter((s) => s.sectionType === "LANES" && s.lanes?.length > 1 && s.lanes.some((l) => l.follow))
    .map((s) => ({ offset: cum[Math.min(Math.max(0, s.endPointIndex ?? 0), dernier)], lanes: s.lanes }))
    .sort((a, b) => a.offset - b.offset);

  // Travaux et fermetures connus de TomTom sur le trajet (pour les annoncer).
  const travaux = (r.sections || [])
    .filter((s) => {
      if (String(s.sectionType || "").toUpperCase() !== "TRAFFIC") return false;
      if (["ROAD_WORK", "ROAD_CLOSURE"].includes(s.simpleCategory)) return true;
      // Ralentissements notables seulement (pas chaque petit ralenti).
      return s.simpleCategory === "JAM" && ((s.magnitudeOfDelay || 0) >= 2 || (s.delayInSeconds || 0) >= 120);
    })
    .map((s) => {
      const i = Math.min(Math.max(0, s.startPointIndex ?? 0), dernier);
      const f = Math.min(Math.max(i, s.endPointIndex ?? i), dernier);
      return { offset: cum[i], fin: cum[f], cle: `${coords[i][1].toFixed(3)},${coords[i][0].toFixed(3)}`, fermeture: s.simpleCategory === "ROAD_CLOSURE", bouchon: s.simpleCategory === "JAM", retard_min: Math.round((s.delayInSeconds || 0) / 60) };
    })
    .sort((a, b) => a.offset - b.offset);

  // Tronçons d'autoroute : le panneau passe en bleu.
  const borne = (i) => cum[Math.min(Math.max(0, i ?? 0), dernier)];
  const autoroutes = (r.sections || []).filter((s) => String(s.sectionType || "").toUpperCase() === "MOTORWAY").map((s) => [borne(s.startPointIndex), borne(s.endPointIndex)]);

  return { coords, cum, total: cum[dernier], instructions, limites, troncons, voies, travaux, autoroutes };
}

// Partie du tracé choisi encore devant la voiture. La recherche repart du
// dernier point atteint pour ne pas s'accrocher à un passage antérieur
// (route qui repasse près d'elle-même).
export function traceRestante(coords, lat, lon, depuis = 0) {
  let meilleur = depuis;
  let dMin = Infinity;
  for (let i = depuis; i < coords.length; i++) {
    const d = haversineKm(lat, lon, coords[i][1], coords[i][0]);
    if (d < dMin) {
      dMin = d;
      meilleur = i;
    }
  }
  return { indice: meilleur, coords: coords.slice(meilleur) };
}

export const FLECHES_VOIE = {
  STRAIGHT: "↑",
  LEFT: "←",
  RIGHT: "→",
  SLIGHT_LEFT: "↖",
  SLIGHT_RIGHT: "↗",
  SHARP_LEFT: "↙",
  SHARP_RIGHT: "↘",
  LEFT_U_TURN: "↶",
  RIGHT_U_TURN: "↷",
};
// Route vue en perspective : les voies à prendre en bleu, avec leurs flèches.
export function dessinVoies(lanes) {
  const n = lanes.length;
  const [haut, bas] = [18, 196];
  const xb = (i) => 8 + (154 * i) / n;
  const xh = (i) => 62 + (46 * i) / n;
  const taille = n <= 3 ? 42 : n <= 5 ? 32 : 22;
  let svg = "";
  lanes.forEach((l, i) => {
    svg += `<polygon points="${xh(i)},${haut} ${xh(i + 1)},${haut} ${xb(i + 1)},${bas} ${xb(i)},${bas}" fill="${l.follow ? "#2f80ff" : "#454d5e"}"/>`;
    const d = l.follow || (l.directions || ["STRAIGHT"])[0];
    svg += `<text x="${(xb(i) + xb(i + 1)) / 2}" y="${bas - 22}" text-anchor="middle" font-size="${taille}" font-weight="900" fill="${l.follow ? "#fff" : "rgba(255,255,255,0.45)"}">${FLECHES_VOIE[d] || "↑"}</text>`;
  });
  for (let i = 1; i < n; i++) svg += `<line x1="${xh(i)}" y1="${haut}" x2="${xb(i)}" y2="${bas}" stroke="#fff" stroke-width="2.5" stroke-dasharray="14 10"/>`;
  svg += `<line x1="${xh(0)}" y1="${haut}" x2="${xb(0)}" y2="${bas}" stroke="#fff" stroke-width="3"/><line x1="${xh(n)}" y1="${haut}" x2="${xb(n)}" y2="${bas}" stroke="#fff" stroke-width="3"/>`;
  return `<svg viewBox="0 0 170 200" aria-hidden="true">${svg}</svg>`;
}

// ── Zones de danger et feux (OpenStreetMap) ────────────────────────────────
