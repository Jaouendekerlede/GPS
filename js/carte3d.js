// Vue 3D de la navigation : carte vectorielle affichée par MapLibre,
// inclinée vers l'horizon, bâtiments en relief. Deux fournisseurs :
// OpenFreeMap (données OpenStreetMap, gratuit, sans clé ni quota) et TomTom
// (même clé que les itinéraires) ; si l'un est refusé, on essaie l'autre.
// Mêmes fonctions que la partie navigation de carte.js, pour que
// navigation.js puisse passer de l'une à l'autre. MapLibre n'est chargé
// qu'au premier démarrage d'une navigation en 3D.

import { getApiKeys } from "./config.js";
import { haversineKm, densifier, recalerSurRoutes, pointSurLigne, lisser } from "./geo.js";
import { classePuissance, puissanceBorne, htmlIconeParking, couleurBouchon, texteBatterieArret, decalageNavGauche } from "./carte.js";
import { lireRefusTomTom } from "./tomtom.js";
import { svgVoiture } from "./icones-voiture.js";
import { icone } from "./icones.js";

const MAPLIBRE = "vendor/maplibre/maplibre-gl";
const DELAI_CHARGEMENT_MS = 30000;
// Inclinaison de la caméra en navigation (degrés) : plus elle est grande,
// plus on voit loin devant, jusqu'à l'horizon. Réglable dans le Profil.
let INCLINAISON = 70;
const INCLINAISON_MIN = 40;
const INCLINAISON_MAX = 78;
// À échelle égale, le zoom MapLibre (tuiles 512 px) vaut celui de Leaflet
// moins 1 ; l'inclinaison éloigne l'horizon, on rapproche un peu.
const ECART_ZOOM = -0.7;
// Tracé : vert sur la carte de nuit, bleu franc sur la carte claire (plus
// lisible sur les routes jaunes et le fond beige).
const COULEUR_RESTANT_NUIT = "#7c3aed";
const COULEUR_RESTANT_JOUR = "#7c3aed";
let COULEUR_RESTANT = COULEUR_RESTANT_NUIT;
let fondActif = "sombre";
const COULEUR_PARCOURU = "#6b7385";
// line-gradient n'accepte qu'une expression fondée sur line-progress.
let DEGRADE_RESTANT = ["step", ["line-progress"], COULEUR_RESTANT, 1, COULEUR_RESTANT];

function couleursSelonFond(fond) {
  fondActif = fond;
  COULEUR_RESTANT = fond === "plan" ? COULEUR_RESTANT_JOUR : COULEUR_RESTANT_NUIT;
  DEGRADE_RESTANT = ["step", ["line-progress"], COULEUR_RESTANT, 1, COULEUR_RESTANT];
}

export const FOURNISSEURS = {
  libre: "OpenFreeMap",
  tomtom: "TomTom",
};

let carte = null;
let styleCharge = null;
let chargementLib = null;
let conteneur = null;
let voiture = null;
let marqueursRoute = [];
let marqueursBornes = [];
let marqueursRadars = [];
let marqueursFeux = [];
// Feux tricolores : seuls ceux proches de la voiture sont posés. Chaque
// marqueur est replacé à chaque image ; des centaines de feux sur un long
// trajet ralentissaient le guidage.
const RAYON_FEUX_KM = 3;
const RELANCE_FEUX_KM = 1;
let feuxNav = [];
let centreFeux = null;
let positionVoiture = null;
let bornesVisibles = false;
let cumRoute = null;
// Dernier tracé de navigation : à redessiner si la carte est recréée en
// route (changement de fond au coucher du soleil, par exemple).
let traceNav = null;
let flecheNav = null;
let surDeplacementManuel = null;
let coucheBatiments = null;
let nomFournisseur = "";
let raisonEchec = "";
let avertissement = "";
const surPannes = new Set();
let tuilesKoDeSuite = 0;
let horsService = false;

function chargerMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  chargementLib ??= new Promise((ok, echecBrut) => {
    const echec = (e) => {
      chargementLib = null;
      echecBrut(e);
    };
    setTimeout(() => echec(new Error("réseau trop lent pour télécharger le moteur 3D")), DELAI_CHARGEMENT_MS);
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${MAPLIBRE}.css`;
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = `${MAPLIBRE}.js`;
    script.onload = ok;
    script.onerror = () => echec(new Error("moteur 3D (MapLibre) non téléchargé : réseau ?"));
    document.head.appendChild(script);
  });
  return chargementLib;
}

function webglDisponible() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function urlStyle(fournisseur, sombre) {
  if (fournisseur === "tomtom") {
    return `https://api.tomtom.com/style/1/style/*?map=2/basic_street-${sombre ? "dark" : "light"}&key=${encodeURIComponent(getApiKeys().tomtom)}`;
  }
  // Style détaillé dans les deux cas ; la version nuit est calculée ici.
  return "https://tiles.openfreemap.org/styles/liberty";
}

// Fond satellite (images Esri, sans clé, comme en 2D) : pas de bâtiments,
// mais routes et noms de lieux par-dessus.
function styleSatellite() {
  const esri = (chemin) => ({ type: "raster", tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/${chemin}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 });
  return {
    version: 8,
    sources: {
      images: { ...esri("World_Imagery"), attribution: "Imagerie © Esri" },
      routes: esri("Reference/World_Transportation"),
      lieux: esri("Reference/World_Boundaries_and_Places"),
    },
    layers: [
      { id: "images", type: "raster", source: "images" },
      { id: "routes", type: "raster", source: "routes" },
      { id: "lieux", type: "raster", source: "lieux" },
    ],
  };
}

const NOM_FRANCAIS = ["coalesce", ["get", "name:fr"], ["get", "name"], ["get", "name_en"]];

// ── Version nuit du style détaillé ─────────────────────────────────────────
// Le style sombre d'OpenFreeMap est trop pauvre (rues à peine visibles). On
// garde donc le style détaillé « liberty » et on assombrit ses couleurs :
// surfaces sombres, routes et textes clairs, teintes conservées.

function versHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function lireCouleur(texte) {
  const t = texte.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [...versHsl(n(0), n(2), n(4)), h.length === 8 ? n(6) : 1];
  }
  m = t.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [...versHsl(r / 255, g / 255, b / 255), a];
  }
  m = t.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const [h, s, l, a = "1"] = m[1].split(/[\s,/]+/).filter(Boolean);
    return [parseFloat(h), parseFloat(s) / 100, parseFloat(l) / 100, parseFloat(a)];
  }
  return null;
}

// role : "surface" (fonds, zones, bâtiments, bordures de route),
// "trait" (routes, voies ferrées, rivières), "texte", "halo".
function couleurNuit(texte, role) {
  const c = lireCouleur(texte);
  if (!c) return texte;
  const [h, s, l, a] = c;
  let nl;
  let ns = s;
  if (role === "surface") {
    nl = 0.09 + (1 - l) * 0.28;
    ns = s * 0.55;
  } else if (role === "trait") {
    nl = 0.3 + l * 0.42;
    ns = s * 0.8;
  } else if (role === "discret") {
    nl = 0.2 + l * 0.12;
    ns = s * 0.5;
  } else if (role === "texte") {
    nl = 0.93 - l * 0.35;
  } else {
    nl = 0.08;
    ns = s * 0.4;
  }
  return `hsla(${Math.round(h)}, ${Math.round(ns * 100)}%, ${Math.round(nl * 100)}%, ${a})`;
}

function convertirCouleurs(valeur, role) {
  if (typeof valeur === "string") return couleurNuit(valeur, role);
  if (Array.isArray(valeur)) return valeur.map((v) => convertirCouleurs(v, role));
  if (valeur && typeof valeur === "object") {
    const copie = { ...valeur };
    if (Array.isArray(copie.stops)) copie.stops = copie.stops.map(([z, v]) => [z, convertirCouleurs(v, role)]);
    return copie;
  }
  return valeur;
}

function styleNuit(style) {
  for (const couche of style.layers) {
    const p = couche.paint;
    if (!p) continue;
    const bordure = /casing|outline/.test(couche.id);
    // Trottoirs, chemins, pistes : utiles mais secondaires en voiture.
    const secondaire = /path|foot|pedestrian|track|steps|cycle|bridleway/.test(couche.id);
    const regles = {
      "background-color": "surface",
      "fill-color": "surface",
      "fill-outline-color": "surface",
      "fill-extrusion-color": "surface",
      "line-color": bordure ? "surface" : secondaire ? "discret" : "trait",
      "text-color": "texte",
      "text-halo-color": "halo",
      "icon-color": "texte",
    };
    for (const [prop, role] of Object.entries(regles)) if (p[prop] !== undefined) p[prop] = convertirCouleurs(p[prop], role);
    // Relief ombré en image : trop clair la nuit.
    if (couche.type === "raster") p["raster-brightness-max"] = 0.35;
    // Hachures (images claires, non recolorables) : à peine visibles.
    if (p["fill-pattern"] !== undefined) p["fill-opacity"] = 0.12;
  }
  return style;
}

// Style OpenFreeMap : noms en français (il affiche sinon l'anglais),
// bâtiments en relief s'il n'en a pas, version nuit si besoin.
function adapterStyleLibre(style, sombre) {
  if (sombre) styleNuit(style);
  for (const couche of style.layers) {
    const texte = couche.layout?.["text-field"];
    if (texte && /name/.test(JSON.stringify(texte))) couche.layout["text-field"] = NOM_FRANCAIS;
  }
  if (!style.layers.some((c) => c.type === "fill-extrusion")) {
    const avantTextes = style.layers.findIndex((c) => c.type === "symbol");
    style.layers.splice(avantTextes < 0 ? style.layers.length : avantTextes, 0, {
      id: "batiments-3d",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": sombre ? "#2b3342" : "#d8d2ca",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
  return style;
}

// Style JSON brut (avant adaptation), gardé en mémoire pour la durée de la
// page seulement -- jamais sur disque (le style TomTom n'a pas le droit
// d'être stocké). But : éviter de retélécharger le même style à chaque
// navigation démarrée/arrêtée dans la même session -- l'utilisateur a
// signalé le 2026-09-27 consommer son quota TomTom "Maps" au fil de la
// journée (le routage, sur un quota séparé, tient toute la journée sans
// souci). Ça ne supprime pas le quota, mais réduit vraiment le nombre
// d'appels à ce produit précis.
const cacheStyles = new Map();

// Le style est téléchargé ici (et non par MapLibre) pour lire la raison
// d'un éventuel refus.
async function telechargerStyle(fournisseur, sombre) {
  const url = urlStyle(fournisseur, sombre);
  let styleBrut = cacheStyles.get(url);
  if (!styleBrut) {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), DELAI_CHARGEMENT_MS);
    try {
      const r = await fetch(url, { signal: controleur.signal });
      if (!r.ok) {
        const detail = await lireRefusTomTom(r);
        throw new Error(`carte ${FOURNISSEURS[fournisseur]} refusée (HTTP ${r.status}${detail ? ` : « ${detail} »` : ""})`);
      }
      styleBrut = await r.json();
      cacheStyles.set(url, styleBrut);
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`réseau trop lent pour la carte ${FOURNISSEURS[fournisseur]}`);
      if (e instanceof TypeError) throw new Error(`carte ${FOURNISSEURS[fournisseur]} inaccessible (réseau ?)`);
      throw e;
    } finally {
      clearTimeout(minuteur);
    }
  }
  // Clone : adapterStyleLibre modifie l'objet en place (ajout de la couche
  // bâtiments, textes en français...) -- le refaire sur le même objet en
  // cache doublerait la couche à chaque navigation.
  const style = JSON.parse(JSON.stringify(styleBrut));
  return fournisseur === "libre" ? adapterStyleLibre(style, sombre) : style;
}

// Nos tracés vont au-dessus de toutes les routes du fond (pointillés,
// tunnels, ponts compris) mais sous les noms : lisibles d'un coup d'œil.
function coucheSousLesNoms() {
  const couches = carte.getStyle().layers;
  const derniereLigne = couches.map((c) => c.type).lastIndexOf("line");
  return couches.slice(derniereLigne + 1).find((c) => c.type === "symbol")?.id;
}

function ajouterCouchesTrajet() {
  // Bâtiments en relief : présents mais masqués dans le style TomTom.
  coucheBatiments = carte.getStyle().layers.find((c) => c.type === "fill-extrusion")?.id || null;
  if (coucheBatiments) {
    carte.setLayoutProperty(coucheBatiments, "visibility", "visible");
    carte.setPaintProperty(coucheBatiments, "fill-extrusion-opacity", 0.85);
  }
  carte.addSource("trajet", { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true });
  const dessous = coucheSousLesNoms();
  carte.addLayer({ id: "trajet-halo", type: "line", source: "trajet", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": fondActif === "plan" ? "#0b3a7a" : "#062a1e", "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 17, 22] } }, dessous);
  carte.addLayer({
    id: "trajet-ligne",
    type: "line",
    source: "trajet",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 17, 14], "line-gradient": DEGRADE_RESTANT },
  }, dessous);
  // Flèche blanche du prochain virage, posée sur le tracé (largeur en
  // mètres, comme sa pointe, pour garder les proportions à tout zoom).
  carte.addSource("nav-fleche", { type: "geojson", data: VIDE });
  const trait = ["==", ["geometry-type"], "LineString"];
  const pointe = ["==", ["geometry-type"], "Polygon"];
  carte.addLayer({ id: "nav-fleche-contour", type: "line", source: "nav-fleche", filter: trait, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "rgba(10,42,92,0.5)", "line-width": largeurMetres(4.2) } }, dessous);
  carte.addLayer({ id: "nav-fleche-trait", type: "line", source: "nav-fleche", filter: trait, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-opacity": 0.92, "line-width": largeurMetres(2.6) } }, dessous);
  carte.addLayer({ id: "nav-fleche-pointe", type: "fill", source: "nav-fleche", filter: pointe, paint: { "fill-color": "#ffffff", "fill-opacity": 0.92, "fill-antialias": true } }, dessous);
}

// Largeur de ligne correspondant à `m` mètres au sol (vers 46° de latitude).
function largeurMetres(m) {
  const pixelsParMetreZoom0 = 512 / (40075016 * Math.cos((46 * Math.PI) / 180));
  return ["interpolate", ["exponential", 2], ["zoom"], 10, m * pixelsParMetreZoom0 * 2 ** 10, 22, m * pixelsParMetreZoom0 * 2 ** 22];
}

// fleche : { ligne, pointe } ([lon, lat]) ou null pour l'effacer.
export function dessinerFlecheManoeuvre(fleche) {
  flecheNav = fleche;
  const source = carte?.getSource("nav-fleche");
  if (!source) return;
  if (fleche && recalage?.segs?.length) {
    const ligne = recalerSurRoutes(fleche.ligne, recalage.segs, ECART_RECALAGE_M);
    const [fin, finR] = [fleche.ligne[fleche.ligne.length - 1], ligne[ligne.length - 1]];
    const [dx, dy] = [finR[0] - fin[0], finR[1] - fin[1]];
    fleche = { ligne, pointe: fleche.pointe.map(([x, y]) => [x + dx, y + dy]) };
  }
  source.setData(
    fleche
      ? {
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: { type: "LineString", coordinates: fleche.ligne }, properties: {} },
            { type: "Feature", geometry: { type: "Polygon", coordinates: [[...fleche.pointe, fleche.pointe[0]]] }, properties: {} },
          ],
        }
      : VIDE,
  );
}

// Raison du dernier échec, affichée à l'utilisateur pour le diagnostic.
export function derniereErreur() {
  return raisonEchec;
}

// Rempli quand le fournisseur choisi a été refusé et que l'autre a pris le
// relais (à signaler, sans bloquer).
export function dernierAvertissement() {
  return avertissement;
}

// cb(raison) : la carte 3D ne peut plus s'afficher (tuiles refusées,
// moteur graphique coupé par Android) ; la navigation repasse en 2D.
export function definirSurPanne(cb) {
  surPannes.add(cb);
}

function panne(raison) {
  if (horsService) return;
  horsService = true;
  raisonEchec = raison;
  console.warn("[3D] Panne :", raison);
  for (const cb of surPannes) cb(raison);
}

// Ciel MapLibre visible au-dessus de l'horizon quand la carte est inclinée.
// Il se configure au niveau du style, pas comme une couche cartographique.
function ajouterCiel(sombre) {
  carte.setSky(
    sombre
      ? {
          "sky-color": "#1b3152",
          "horizon-color": "#6884a3",
          "fog-color": "#1b3152",
          "sky-horizon-blend": 0.35,
          "horizon-fog-blend": 0.5,
          "fog-ground-blend": 0.2,
        }
      : {
          "sky-color": "#8ac8f5",
          "horizon-color": "#e8f5ff",
          "fog-color": "#cfe8ff",
          "sky-horizon-blend": 0.35,
          "horizon-fog-blend": 0.5,
          "fog-ground-blend": 0.2,
        },
  );
  // Filet de sécurité : rendu noir malgré la couche "sky" sur deux essais
  // précédents -- signalé de nouveau le 2026-09-28. Le conteneur est peint de
  // la même couleur que le ciel demandé ; avec le canevas rendu transparent
  // (canvasContextAttributes dans creerCarte), ce fond apparaît là où
  // MapLibre ne peint rien, quelle que soit la cause exacte du problème.
  conteneur.style.background = sombre ? "#1b3152" : "linear-gradient(#5b9bd9, #cfe8ff 55%, #eaf6ff)";
}

// Relief du terrain : altitudes « Terrain Tiles » (données ouvertes
// hébergées par AWS, sans clé). Un peu exagéré pour être perceptible.
const TUILES_RELIEF = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
let reliefKo = 0;

function ajouterRelief() {
  reliefKo = 0;
  carte.addSource("relief", { type: "raster-dem", tiles: [TUILES_RELIEF], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: "Relief : Terrain Tiles (AWS)" });
  carte.setTerrain({ source: "relief", exaggeration: 1.3 });
}

function surveiller() {
  carte.on("error", (e) => {
    if (!e.sourceId) return;
    // Relief indisponible : on s'en passe, la carte reste utilisable.
    // Trafic refusé (clé sans ce service) : la carte, elle, va bien.
    if (e.sourceId === "trafic") return;
    if (e.sourceId === "relief") {
      if (++reliefKo >= 5 && carte.getTerrain()) {
        console.warn("[3D] Relief indisponible, carte à plat");
        carte.setTerrain(null);
      }
      return;
    }
    // Refus en série (clé, quota, réseau coupé) : sans tuiles, la carte
    // devient noire. Une tuile ratée isolée ne suffit pas.
    if (++tuilesKoDeSuite >= 8) panne(`cartes ${nomFournisseur} refusées${e.error?.status ? `, HTTP ${e.error.status}` : ", réseau ?"}`);
  });
  carte.on("sourcedata", (e) => {
    if (e.tile && e.sourceId !== "relief") tuilesKoDeSuite = 0;
  });
  carte.on("webglcontextlost", () => panne("moteur graphique coupé par le téléphone"));
  // Le style OpenFreeMap cite quelques icônes absentes de son catalogue :
  // image vide plutôt qu'un avertissement par icône.
  carte.on("styleimagemissing", (e) => {
    if (!carte.hasImage(e.id)) carte.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
}

async function creerCarte(fournisseur, fond, relief) {
  const style = fond === "satellite" ? styleSatellite() : await telechargerStyle(fournisseur, fond === "sombre");
  // Changement de style en cours d'exploration : on garde le même cadrage.
  const vueAvant = carte ? { center: carte.getCenter(), zoom: carte.getZoom(), pitch: carte.getPitch(), bearing: carte.getBearing() } : null;
  if (carte) {
    for (const m of [...explo.marqueursBornes.values(), ...explo.grappes, ...explo.marqueursParkings]) m.remove();
    explo.grappes = [];
    explo.marqueursParkings = [];
    for (const m of [...explo.marqueursTrajet, explo.marqueurPosition, explo.marqueurCurseur]) m?.remove();
    explo.marqueurPosition = null;
    explo.marqueurCurseur = null;
    carte.remove();
    carte = null;
  }
  horsService = false;
  tuilesKoDeSuite = 0;
  // Invisible mais à sa taille pendant le chargement : MapLibre a besoin
  // des dimensions, et l'écran ne reste pas noir en attendant.
  conteneur.classList.remove("hidden");
  conteneur.classList.add("gps-3d-invisible");
  carte = new maplibregl.Map({
    container: conteneur,
    style,
    center: [2.4, 46.6],
    zoom: 5,
    pitch: INCLINAISON,
    attributionControl: { compact: true },
    dragRotate: false,
    maxPitch: 80, // 60 par défaut : trop peu pour une vue « horizon »
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: 0,
    // Bords lissés (désactivé par défaut dans MapLibre : routes et bâtiments
    // en escalier) et rendu à la densité réelle de l'écran. Sur ordinateur
    // (souris, grand écran), on force au moins 2x : un écran d'ordinateur
    // gagne alors en finesse et le GPU s'en sort largement. Sur téléphone
    // (écran tactile, celui qui navigue réellement en conduisant), on
    // plafonne à 2x SANS forcer de plancher : demander jusqu'à 3x sur un
    // petit GPU de milieu de gamme, en pleine navigation avec bâtiments en
    // relief et caméra qui bouge en continu, provoquait des saccades
    // visibles (tracé qui clignote, flèche qui saute, bascule en vue
    // horizon hachée -- signalé par l'utilisateur le 2026-09-27).
    antialias: true,
    pixelRatio: matchMedia("(pointer: coarse)").matches ? Math.min(2, window.devicePixelRatio || 1) : Math.min(3, Math.max(window.devicePixelRatio || 1, 2)),
    // Fond du canevas transparent : si la couche "sky" ne peint pas certains
    // pixels au-dessus de l'horizon (constaté noir même avec le bon réglage
    // -- signalé par l'utilisateur le 2026-09-28), le dégradé posé en CSS
    // sur le conteneur (voir ajouterCiel) apparaît à la place, quelle que
    // soit la cause exacte côté MapLibre.
    canvasContextAttributes: { alpha: true },
  });
  // Seules les ressources du style (icônes, polices) sont attendues : les
  // tuiles arrivent ensuite.
  await new Promise((ok, echec) => {
    const minuteur = setTimeout(() => echec(new Error(`réseau trop lent pour la carte ${FOURNISSEURS[fournisseur]}`)), DELAI_CHARGEMENT_MS);
    carte.once("style.load", () => {
      clearTimeout(minuteur);
      ok();
    });
  });
  ajouterCouchesTrajet();
  ajouterCouchesExplo();
  ajouterCiel(fond === "sombre");
  // Relief du terrain : confirmé trop gourmand sur téléphone (webGL saturé,
  // tracé qui clignote, écran qui devient noir par intermittence -- signalé
  // par l'utilisateur le 2026-09-27, résolu en désactivant ce réglage).
  // Bloqué ici plutôt que seulement dans le réglage : même si la préférence
  // reste enregistrée à true (réglage déjà fait avant ce correctif, ou
  // repris d'un autre appareil), un écran tactile ne l'active jamais.
  if (relief && fond !== "satellite" && !matchMedia("(pointer: coarse)").matches) ajouterRelief();
  appliquerTrafic();
  carte.on("dragstart", (e) => e.originalEvent && surDeplacementManuel?.());
  carte.on("zoomstart", (e) => e.originalEvent && surDeplacementManuel?.());
  surveiller();
  // Mention des sources repliée (« i ») : dépliée, elle recouvre la carte.
  conteneur.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  nomFournisseur = fond === "satellite" ? "satellite Esri" : FOURNISSEURS[fournisseur];
  if (vueAvant) carte.jumpTo(vueAvant);
  if (enNavigation) {
    if (traceNav) dessinerRouteNavigation(...traceNav);
    if (flecheNav) dessinerFlecheManoeuvre(flecheNav);
    voiture?.addTo(carte);
    if (bornesVisibles) for (const m of marqueursBornes) m.addTo(carte);
    for (const m of marqueursRadars) m.addTo(carte);
    centreFeux = null;
    if (positionVoiture) poserFeuxProches(positionVoiture.lat, positionVoiture.lon);
  }
  if (explo.actif) {
    gestesExploration(!enNavigation);
    rendreExplo();
  }
}

// Prépare la carte 3D avec le fournisseur préféré, sinon l'autre. Renvoie
// false si aucun ne marche : la navigation reste alors en 2D.
// Les préparations s'exécutent l'une après l'autre : deux changements de
// fond rapprochés ne doivent pas se croiser (le dernier demandé l'emporte).
let fileAttente = Promise.resolve();

// Un fournisseur refusé (403, quota...) l'est en général encore quelques
// minutes plus tard -- pas la peine de retenter puis d'afficher à nouveau
// l'avertissement à chaque navigation démarrée ou bascule 2D/3D entre-temps
// (signalé par l'utilisateur le 2026-09-27 : "toujours des messages 403
// tomtom"). On se souvient de l'échec et on saute directement à l'autre
// fournisseur pendant ce délai, sans nouvelle tentative ni nouvel avis.
const DELAI_AVANT_NOUVEL_ESSAI_MS = 10 * 60 * 1000;
const dernierEchecFournisseur = {};

export function preparer(options) {
  const suite = fileAttente.then(() => preparerMaintenant(options));
  fileAttente = suite.catch(() => {});
  return suite;
}

async function preparerMaintenant({ sombre = true, fond = sombre ? "sombre" : "plan", fournisseur = "libre", relief = false } = {}) {
  avertissement = "";
  couleursSelonFond(fond);
  if (!webglDisponible()) {
    raisonEchec = "WebGL absent sur ce navigateur";
    return false;
  }
  conteneur = document.getElementById("gps-carte-3d");
  try {
    await chargerMapLibre();
  } catch (e) {
    raisonEchec = e.message;
    return false;
  }
  // Le satellite ne dépend pas du fournisseur de carte vectorielle.
  const ordre = fond === "satellite" ? ["satellite"] : [fournisseur, fournisseur === "tomtom" ? "libre" : "tomtom"].filter((f) => f !== "tomtom" || getApiKeys().tomtom);
  const echecs = [];
  for (const f of ordre) {
    const cleStyle = `${f}-${fond}-${relief}`;
    if (carte && styleCharge === cleStyle && !horsService) return true;
    // Ce fournisseur a échoué il y a moins de 10 min : on ne retente pas
    // (sauf si c'est le seul choix restant), pour ne pas relancer la même
    // requête refusée -- et le même avertissement -- à chaque navigation.
    const echecRecent = dernierEchecFournisseur[f];
    if (echecRecent && Date.now() - echecRecent < DELAI_AVANT_NOUVEL_ESSAI_MS && f !== ordre[ordre.length - 1]) {
      echecs.push(`carte ${FOURNISSEURS[f]} récemment refusée`);
      continue;
    }
    try {
      await creerCarte(f, fond, relief);
      styleCharge = cleStyle;
      raisonEchec = "";
      delete dernierEchecFournisseur[f];
      if (echecs.length) avertissement = `${echecs.join(" ; ")} : carte ${FOURNISSEURS[f]} utilisée à la place`;
      // Reste affichée si la carte des bornes est déjà en 3D.
      if (!explo.actif && !enNavigation) conteneur.classList.add("hidden");
      conteneur.classList.remove("gps-3d-invisible");
      return true;
    } catch (e) {
      dernierEchecFournisseur[f] = Date.now();
      echecs.push(e.message || String(e));
      console.warn("[3D]", e.message || e);
    }
  }
  raisonEchec = echecs.join(" ; ") || "aucune carte 3D disponible";
  if (carte) carte.remove();
  carte = null;
  styleCharge = null;
  conteneur.classList.add("hidden");
  conteneur.classList.remove("gps-3d-invisible");
  return false;
}

// ── Carte des bornes en 3D (exploration) ────────────────────────────────────
// carte.js transmet ici toutes les données affichées (bornes, trajet…), même
// quand la 3D est éteinte : à l'allumage, tout est déjà connu. Pendant une
// navigation 3D, ces éléments sont masqués puis rétablis à la fin.

const INCLINAISON_EXPLO = 50;
const SANS_MARGE = { top: 0, left: 0, right: 0, bottom: 0 };
const VIDE = { type: "FeatureCollection", features: [] };
const COUCHES_EXPLO = ["alt-ligne", "alt-zone", "plan-halo", "plan-aller", "plan-retour", "plan-bouchons", "autonomie-ligne"];

const explo = {
  actif: false,
  onDeplacement: null,
  decalageBas: 0,
  vue: null,
  bornes: [],
  onClicBorne: null,
  bornesVisibles: true,
  selection: null,
  marqueursBornes: new Map(),
  grappes: [],
  parkings: [],
  parkingsVisibles: false,
  marqueursParkings: [],
  position: null,
  marqueurPosition: null,
  trajet: null,
  onClicArret: null,
  marqueursTrajet: [],
  alternatives: [],
  curseur: null,
  marqueurCurseur: null,
};
let enNavigation = false;

function ajouterCouchesExplo() {
  carte.addSource("plan", { type: "geojson", data: VIDE });
  carte.addSource("plan-alternatives", { type: "geojson", data: VIDE });
  carte.addSource("autonomie", { type: "geojson", data: VIDE });
  const dessous = coucheSousLesNoms();
  const rond = { "line-cap": "round", "line-join": "round" };
  carte.addLayer({ id: "alt-ligne", type: "line", source: "plan-alternatives", layout: rond, paint: { "line-color": "#c4b5fd", "line-width": 5, "line-opacity": 0.8 } }, dessous);
  // Zone de toucher bien plus large que le trait (doigt sur téléphone).
  carte.addLayer({ id: "alt-zone", type: "line", source: "plan-alternatives", layout: rond, paint: { "line-color": "#000000", "line-width": 26, "line-opacity": 0.01 } }, dessous);
  const filtre = (type) => ["==", ["get", "type"], type];
  carte.addLayer({ id: "plan-halo", type: "line", source: "plan", filter: filtre("aller"), layout: rond, paint: { "line-color": "#04221a", "line-width": 11, "line-opacity": 0.35 } }, dessous);
  carte.addLayer({ id: "plan-aller", type: "line", source: "plan", filter: filtre("aller"), layout: rond, paint: { "line-color": "#7c3aed", "line-width": 6, "line-opacity": 0.95 } }, dessous);
  carte.addLayer({ id: "plan-retour", type: "line", source: "plan", filter: filtre("retour"), paint: { "line-color": "#ffb400", "line-width": 4, "line-opacity": 0.85, "line-dasharray": [2, 2] } }, dessous);
  // Ralentissements et bouchons par-dessus le tracé (couleur calculée par carte.js).
  carte.addLayer({ id: "plan-bouchons", type: "line", source: "plan", filter: filtre("bouchon"), layout: rond, paint: { "line-color": ["get", "couleur"], "line-width": 6, "line-opacity": 0.95 } }, dessous);
  carte.addLayer({ id: "autonomie-ligne", type: "line", source: "autonomie", paint: { "line-color": "#1a6fe8", "line-width": 3, "line-dasharray": [2, 2] } }, dessous);
  carte.on("click", "alt-zone", (e) => explo.alternatives[e.features?.[0]?.properties?.i]?.onClic?.());
  carte.on("moveend", () => {
    if (!explo.actif || enNavigation) return;
    explo.vue = vueExplo();
    // Distances à l'écran changées (zoom, rotation, inclinaison) : regrouper à nouveau.
    rendreBornes();
    explo.onDeplacement?.();
  });
}

function vueExplo() {
  const c = carte.getCenter();
  return { lat: c.lat, lon: c.lng, zoom: carte.getZoom() - ECART_ZOOM_EXPLO };
}

// Zooms de l'interface exprimés à l'échelle Leaflet (tuiles 256 px).
const ECART_ZOOM_EXPLO = -1;

function gestesExploration(actifs) {
  const action = actifs ? "enable" : "disable";
  carte.dragRotate[action]();
  carte.touchPitch[action]();
  if (actifs) carte.touchZoomRotate.enableRotation();
  else carte.touchZoomRotate.disableRotation();
}

function marqueur(element, lat, lon, options = {}) {
  return new maplibregl.Marker({ element, ...options }).setLngLat([lon, lat]);
}

function afficherSiVisible(m, visible = true) {
  if (visible && explo.actif && !enNavigation && carte) m.addTo(carte);
  return m;
}

function rendreBorne(b) {
  explo.marqueursBornes.get(b)?.remove();
  const el = iconeBorne(b, b === explo.selection);
  el.style.zIndex = String(puissanceBorne(b) * 2 + (b === explo.selection ? 10000 : 0));
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    explo.onClicBorne?.(b);
  });
  explo.marqueursBornes.set(b, afficherSiVisible(marqueur(el, b.lat, b.lon, { anchor: "bottom" }), explo.bornesVisibles));
}

// Bornes qui se chevaucheraient à l'écran : un seul rond « nombre », de la
// couleur de la plus puissante ; le toucher rapproche la carte. Comme en 2D,
// plus de regroupement à partir du zoom 16, et la sélection reste à part.
const RAYON_GRAPPE_PX = 42;
const ZOOM_SANS_REGROUPEMENT = 16;

function grappe(groupe) {
  const kwMax = Math.max(0, ...groupe.map(puissanceBorne));
  const lat = groupe.reduce((s, b) => s + b.lat, 0) / groupe.length;
  const lon = groupe.reduce((s, b) => s + b.lon, 0) / groupe.length;
  const el = document.createElement("div");
  el.className = `gps-grappe ${classePuissance(kwMax)}`;
  el.textContent = String(groupe.length);
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    carte.easeTo({ center: [lon, lat], zoom: carte.getZoom() + 2, duration: 500 });
  });
  return afficherSiVisible(marqueur(el, lat, lon), explo.bornesVisibles);
}

function rendreBornes() {
  for (const m of explo.marqueursBornes.values()) m.remove();
  explo.marqueursBornes.clear();
  for (const m of explo.grappes) m.remove();
  explo.grappes = [];
  if (!carte) return;
  const seules = [];
  const autres = explo.bornes.filter((b) => b !== explo.selection);
  if (explo.selection && explo.bornes.includes(explo.selection)) seules.push(explo.selection);
  if (exploZoom() >= ZOOM_SANS_REGROUPEMENT) {
    seules.push(...autres);
  } else {
    const points = autres.map((b) => ({ b, p: carte.project([b.lon, b.lat]) })).sort((x, y) => puissanceBorne(y.b) - puissanceBorne(x.b));
    const pris = new Set();
    for (let i = 0; i < points.length; i++) {
      if (pris.has(i)) continue;
      pris.add(i);
      const groupe = [points[i].b];
      for (let j = i + 1; j < points.length; j++) {
        if (!pris.has(j) && Math.hypot(points[i].p.x - points[j].p.x, points[i].p.y - points[j].p.y) < RAYON_GRAPPE_PX) {
          pris.add(j);
          groupe.push(points[j].b);
        }
      }
      if (groupe.length === 1) seules.push(groupe[0]);
      else explo.grappes.push(grappe(groupe));
    }
  }
  for (const b of seules) rendreBorne(b);
}

// Cercle d'autonomie : { lat, lon, rayonKm } ou null.
export function exploAutonomie(cercle) {
  explo.autonomie = cercle;
  rendreAutonomie(true);
}

function rendreAutonomie(cadrer = false) {
  const source = carte?.getSource("autonomie");
  if (!source) return;
  const c = explo.autonomie;
  if (!c) return source.setData(VIDE);
  const dLat = c.rayonKm / 111.32;
  const dLon = c.rayonKm / (111.32 * Math.cos((c.lat * Math.PI) / 180));
  const contour = Array.from({ length: 73 }, (_, i) => [c.lon + dLon * Math.cos((i * Math.PI) / 36), c.lat + dLat * Math.sin((i * Math.PI) / 36)]);
  source.setData({ type: "Feature", geometry: { type: "LineString", coordinates: contour }, properties: {} });
  if (cadrer && explo.actif && !enNavigation) carte.fitBounds([[c.lon - dLon, c.lat - dLat], [c.lon + dLon, c.lat + dLat]], { padding: 30, duration: 600 });
}

function rendrePosition() {
  explo.marqueurPosition?.remove();
  explo.marqueurPosition = null;
  if (!carte || !explo.position) return;
  const el = document.createElement("div");
  el.innerHTML = '<div class="gps-position"></div>';
  explo.marqueurPosition = afficherSiVisible(marqueur(el, explo.position.lat, explo.position.lon));
}

function rendreCurseur() {
  explo.marqueurCurseur?.remove();
  explo.marqueurCurseur = null;
  if (!carte || !explo.curseur) return;
  const el = pastille(22, "rgba(0,229,255,.95)");
  el.classList.add("gps-curseur-3d");
  el.insertAdjacentHTML("beforeend", `<span class="gps-curseur-3d-texte"></span>`);
  el.querySelector(".gps-curseur-3d-texte").textContent = explo.curseur.label || "Position estimée";
  explo.marqueurCurseur = afficherSiVisible(marqueur(el, explo.curseur.lat, explo.curseur.lon));
}

function rendreAlternatives() {
  if (!carte) return;
  const features = explo.alternatives
    .map((a, i) => (a.coords?.length ? { type: "Feature", properties: { i }, geometry: { type: "LineString", coordinates: a.coords } } : null))
    .filter(Boolean);
  carte.getSource("plan-alternatives").setData({ type: "FeatureCollection", features });
}

function marqueurArret(arret, taille, couleur, titre) {
  const el = pastille(taille, couleur, "🔋");
  el.title = titre;
  const batterie = texteBatterieArret(arret);
  if (batterie) {
    el.style.position = "relative";
    el.insertAdjacentHTML("beforeend", `<span class="gps-etiquette-arret gps-etiquette-arret-3d"></span>`);
    el.lastElementChild.textContent = batterie;
  }
  el.style.cursor = "pointer";
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    explo.onClicArret?.(arret);
  });
  return marqueur(el, arret.lat, arret.lon);
}

function rendreTrajet(recadrer) {
  for (const m of explo.marqueursTrajet) m.remove();
  explo.marqueursTrajet = [];
  if (!carte) return;
  const d = explo.trajet;
  if (!d?.coords?.length) {
    carte.getSource("plan").setData(VIDE);
    return;
  }
  const features = [{ type: "Feature", properties: { type: "aller" }, geometry: { type: "LineString", coordinates: d.coords } }];
  for (const b of d.bouchons || []) {
    const morceau = d.coords.slice(b.debut, b.fin + 1);
    if (morceau.length >= 2) features.push({ type: "Feature", properties: { type: "bouchon", couleur: couleurBouchon(b) }, geometry: { type: "LineString", coordinates: morceau } });
  }
  const limites = d.coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(d.coords[0], d.coords[0]));
  const m = [];
  if (d.retour?.ok && d.retour.coords?.length) {
    features.push({ type: "Feature", properties: { type: "retour" }, geometry: { type: "LineString", coordinates: d.retour.coords } });
    for (const c of d.retour.coords) limites.extend(c);
    for (const a of d.retour.arrets || []) if (a.lat !== undefined) m.push(marqueurArret(a, 24, "rgba(255,180,0,.95)", `Retour : ${a.nom_borne || "Borne"}`));
  }
  carte.getSource("plan").setData({ type: "FeatureCollection", features });
  if (d.from_lat !== undefined) {
    const el = pastille(18, "#1a6fe8");
    el.title = d.from_name || "Départ";
    m.push(marqueur(el, d.from_lat, d.from_lon));
  }
  if (d.to_lat !== undefined) {
    const el = pastille(22, "#ff6b35", "🏁");
    el.title = d.to_name || "Arrivée";
    m.push(marqueur(el, d.to_lat, d.to_lon));
  }
  (d.arrets || []).forEach((a, i) => a.lat !== undefined && m.push(marqueurArret(a, 30, "rgba(79,224,255,.95)", `Arrêt ${i + 1} : ${a.nom_borne || "Borne"}`)));
  explo.marqueursTrajet = m.map((x) => afficherSiVisible(x));
  if (recadrer && explo.actif && !enNavigation) {
    carte.fitBounds(limites, { padding: { top: 130, bottom: explo.decalageBas + 30, left: 30, right: 30 }, duration: 700, maxZoom: 16 });
  }
}

function rendreExplo() {
  rendreAutonomie();
  rendreBornes();
  rendreParkings();
  rendrePosition();
  rendreCurseur();
  rendreAlternatives();
  rendreTrajet(false);
}

// Masque (navigation) ou rétablit les éléments de la carte des bornes.
function montrerElementsExplo(visible) {
  if (!carte) return;
  for (const id of COUCHES_EXPLO) if (carte.getLayer(id)) carte.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  const marqueurs = [...explo.marqueursTrajet, explo.marqueurPosition, explo.marqueurCurseur].filter(Boolean);
  if (explo.bornesVisibles) marqueurs.push(...explo.marqueursBornes.values(), ...explo.grappes);
  if (explo.parkingsVisibles) marqueurs.push(...explo.marqueursParkings);
  for (const m of marqueurs) {
    if (visible) m.addTo(carte);
    else m.remove();
  }
}

export function activerExploration({ lat, lon, zoom, onDeplacement, decalageBas = 0 }) {
  explo.actif = true;
  explo.onDeplacement = onDeplacement;
  explo.decalageBas = decalageBas;
  conteneur.classList.remove("hidden");
  carte.resize();
  gestesExploration(true);
  carte.jumpTo({ center: [lon, lat], zoom: zoom + ECART_ZOOM_EXPLO, pitch: INCLINAISON_EXPLO, bearing: 0, padding: SANS_MARGE });
  explo.vue = vueExplo();
  rendreExplo();
}

// Renvoie le cadrage courant (échelle Leaflet) pour que la 2D reprenne au même endroit.
export function desactiverExploration() {
  const vue = carte ? vueExplo() : explo.vue;
  explo.actif = false;
  montrerElementsExplo(false);
  if (!enNavigation) conteneur?.classList.add("hidden");
  return vue;
}

// Carte 2D en navigation alors que la carte des bornes est en 3D : la 3D
// doit s'effacer pour laisser voir la 2D, puis revenir.
export function masquerExploration(masquer) {
  if (!explo.actif) return;
  conteneur.classList.toggle("hidden", masquer);
  if (!masquer) carte?.resize();
}

// Simple mémorisation : modifier la caméra ici interromprait un cadrage en
// cours (le panneau change de hauteur juste après l'affichage d'un trajet).
export function exploDecalageBas(px) {
  explo.decalageBas = px;
}

// Centre de la partie visible, au-dessus du panneau.
export function exploCentreVisible() {
  const { width, height } = carte.getCanvas().getBoundingClientRect();
  const c = carte.unproject([width / 2, Math.max(1, (height - explo.decalageBas) / 2)]);
  return { lat: c.lat, lon: c.lng };
}

// Carte inclinée : on mesure vers le bas de l'écran (côté proche), l'horizon
// donnerait un rayon démesuré.
export function exploRayonVisibleKm() {
  const { width, height } = carte.getCanvas().getBoundingClientRect();
  const c = exploCentreVisible();
  const coin = carte.unproject([width, Math.max(1, height - explo.decalageBas)]);
  return Math.min(30, haversineKm(c.lat, c.lon, coin.lat, coin.lng) * 1.2);
}

export function exploZoom() {
  return carte.getZoom() - ECART_ZOOM_EXPLO;
}

export function exploCentrer(lat, lon, zoom) {
  // Comme en 2D : le point visé se place au centre de la partie visible.
  carte.easeTo({ center: [lon, lat], zoom: (zoom ?? exploZoom()) + ECART_ZOOM_EXPLO, padding: SANS_MARGE, offset: [0, -explo.decalageBas / 2], duration: 600 });
}

export function exploBornes(bornes, onClic) {
  explo.bornes = bornes;
  explo.onClicBorne = onClic;
  rendreBornes();
}

export function exploRafraichirBorne(b) {
  if (carte && explo.marqueursBornes.has(b)) rendreBorne(b);
}

// La sélection sort de son groupe : on regroupe à nouveau.
export function exploSelection(b) {
  explo.selection = b;
  rendreBornes();
}

export function exploMontrerBornes(visible) {
  explo.bornesVisibles = visible;
  for (const m of [...explo.marqueursBornes.values(), ...explo.grappes]) {
    if (visible && explo.actif && !enNavigation && carte) m.addTo(carte);
    else m.remove();
  }
}

export function exploPosition(lat, lon) {
  explo.position = { lat, lon };
  if (explo.marqueurPosition) explo.marqueurPosition.setLngLat([lon, lat]);
  else rendrePosition();
}

export function exploTrajet(data, onClicArret) {
  explo.trajet = data;
  explo.onClicArret = onClicArret;
  explo.curseur = null;
  explo.alternatives = [];
  rendreCurseur();
  rendreAlternatives();
  rendreTrajet(true);
}

export function exploAlternatives(liste) {
  explo.alternatives = liste;
  rendreAlternatives();
}

export function exploEffacerTrajet() {
  explo.trajet = null;
  explo.curseur = null;
  explo.alternatives = [];
  rendreTrajet(false);
  rendreCurseur();
  rendreAlternatives();
}

// ── Parkings (carte des bornes en 3D) ───────────────────────────────────────

function rendreParkings() {
  for (const m of explo.marqueursParkings) m.remove();
  explo.marqueursParkings = [];
  if (!carte) return;
  explo.marqueursParkings = explo.parkings.map(({ parking: p, html }) => {
    const el = document.createElement("div");
    el.innerHTML = htmlIconeParking(p);
    const m = marqueur(el, p.lat, p.lon).setPopup(new maplibregl.Popup({ offset: 16, maxWidth: "260px" }).setHTML(html));
    return afficherSiVisible(m, explo.parkingsVisibles);
  });
}

// Zone visible au-dessus du panneau : carte inclinée, donc les quatre coins
// (le haut de l'écran regarde plus loin que le bas).
export function exploCurseur(lat, lon, label) {
  explo.curseur = lat === undefined || lon === undefined ? null : { lat, lon, label };
  rendreCurseur();
}

let styleVoiture = "fleche_bleue";

function iconeVoiture() {
  const el = document.createElement("div");
  el.innerHTML = svgVoiture(styleVoiture);
  return el;
}

// Réglage Profil > Navigation : l'icône est refaite au prochain affichage.
export function definirIconeVoiture(style) {
  styleVoiture = style || "fleche_bleue";
  voiture?.remove();
  voiture = null;
}

// Trafic en couleur (tuiles TomTom) sous le tracé ; gardé d'une carte à l'autre.
let traficActif = false;
let cleTrafic = "";

export function afficherTrafic(actif, cle) {
  traficActif = actif;
  cleTrafic = cle || cleTrafic;
  if (carte?.getSource("trajet")) appliquerTrafic();
}

function appliquerTrafic() {
  const present = !!carte.getLayer("trafic");
  if (traficActif && cleTrafic && !present) {
    if (!carte.getSource("trafic")) {
      carte.addSource("trafic", { type: "raster", tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(cleTrafic)}&tileSize=256`], tileSize: 256, maxzoom: 20 });
    }
    carte.addLayer({ id: "trafic", type: "raster", source: "trafic", paint: { "raster-opacity": 0.75 } }, carte.getLayer("trajet-halo") ? "trajet-halo" : undefined);
  } else if (!traficActif && present) carte.removeLayer("trafic");
}

function pastille(taille, couleur, contenu = "") {
  const el = document.createElement("div");
  el.innerHTML = `<div class="gps-point-trajet" style="width:${taille}px;height:${taille}px;background:${couleur};box-shadow:0 0 12px ${couleur};">${contenu}</div>`;
  return el;
}

export function entrerNavigation({ onDeplacementManuel } = {}) {
  surDeplacementManuel = onDeplacementManuel;
  enNavigation = true;
  montrerElementsExplo(false);
  gestesExploration(false);
  conteneur.classList.remove("hidden");
  carte.resize();
}

export function quitterNavigation() {
  surDeplacementManuel = null;
  enNavigation = false;
  for (const m of [...marqueursRoute, ...marqueursBornes, ...marqueursRadars, ...marqueursFeux]) m.remove();
  marqueursRoute = [];
  marqueursBornes = [];
  marqueursRadars = [];
  marqueursFeux = [];
  feuxNav = [];
  centreFeux = null;
  positionVoiture = null;
  voiture?.remove();
  voiture = null;
  traceNav = null;
  flecheNav = null;
  if (!carte) return;
  carte.getSource("trajet")?.setData(VIDE);
  carte.getSource("nav-fleche")?.setData(VIDE);
  if (explo.actif) {
    // Retour à la carte des bornes, telle qu'elle était.
    montrerElementsExplo(true);
    gestesExploration(true);
    const v = explo.vue;
    carte.jumpTo({ pitch: INCLINAISON_EXPLO, bearing: 0, padding: SANS_MARGE, ...(v ? { center: [v.lon, v.lat], zoom: v.zoom + ECART_ZOOM_EXPLO } : {}) });
  } else {
    conteneur?.classList.add("hidden");
  }
}

export function dessinerRouteNavigation(coords, arrets, destination) {
  traceNav = [coords, arrets, destination];
  recalage = null;
  cumRoute = [0];
  for (let i = 1; i < coords.length; i++) cumRoute.push(cumRoute[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  // Lissage à l'affichage seulement (les distances/positions ci-dessus
  // restent calculées sur le tracé brut de TomTom) : les virages serrés
  // (ronds-points) paraissaient anguleux, coordonnées trop espacées pour la
  // ligne bleue -- signalé par l'utilisateur le 2026-09-28. La couleur
  // parcouru/restant (majProgressionNavigation) se fait par dégradé GPU sur
  // la longueur de la ligne, indépendant du nombre de points : sans risque.
  carte.getSource("trajet").setData({ type: "Feature", geometry: { type: "LineString", coordinates: lisser(coords) }, properties: {} });
  carte.setPaintProperty("trajet-ligne", "line-gradient", DEGRADE_RESTANT);
  for (const m of marqueursRoute) m.remove();
  marqueursRoute = (arrets || []).map((a) => new maplibregl.Marker({ element: pastille(32, "rgba(79,224,255,.95)", "🔋") }).setLngLat([a.lon, a.lat]).addTo(carte));
  if (destination) marqueursRoute.push(new maplibregl.Marker({ element: pastille(26, "#ff6b35", "🏁") }).setLngLat([destination.lon, destination.lat]).addTo(carte));
}

// Radars (officiels OSM ou signalés soi-même) sur le tracé : un symbole de
// radar plutôt qu'une épingle générique -- demande explicite de
// l'utilisateur le 2026-09-27.
export function dessinerRadars(radars) {
  for (const m of marqueursRadars) m.remove();
  const symbole = `<span style="color:#fff;display:flex">${icone("radar", 16)}</span>`;
  marqueursRadars = (radars || []).map((r) => new maplibregl.Marker({ element: pastille(28, "rgba(255,70,60,.95)", symbole) }).setLngLat([r.lon, r.lat]).addTo(carte));
}

// Feux tricolores sur le tracé (OpenStreetMap), pendant du 2D : demande du
// 2026-10-03.
export function dessinerFeux(feux) {
  feuxNav = feux || [];
  centreFeux = null;
  for (const m of marqueursFeux) m.remove();
  marqueursFeux = [];
  if (positionVoiture) poserFeuxProches(positionVoiture.lat, positionVoiture.lon);
}

function poserFeuxProches(lat, lon) {
  if (centreFeux && haversineKm(centreFeux.lat, centreFeux.lon, lat, lon) < RELANCE_FEUX_KM) return;
  centreFeux = { lat, lon };
  for (const m of marqueursFeux) m.remove();
  const symbole = `<span style="font-size:14px;line-height:1;display:flex">🚦</span>`;
  marqueursFeux = feuxNav
    .filter((f) => haversineKm(lat, lon, f.lat, f.lon) < RAYON_FEUX_KM)
    .map((f) => new maplibregl.Marker({ element: pastille(24, "rgba(40,40,45,.92)", symbole) }).setLngLat([f.lon, f.lat]).addTo(carte));
}

// Parcouru en gris, restant en vert : un dégradé à seuil le long du tracé,
// bien moins coûteux que de redécouper la ligne plusieurs fois par seconde.
export function majProgressionNavigation(coords, indice, lat, lon) {
  if (!cumRoute?.length || !coords[indice]) return;
  const total = cumRoute[cumRoute.length - 1];
  if (total <= 0) return;
  const fait = cumRoute[indice] + haversineKm(coords[indice][1], coords[indice][0], lat, lon);
  const f = Math.min(0.9999, Math.max(0.0001, fait / total));
  carte.setPaintProperty("trajet-ligne", "line-gradient", ["step", ["line-progress"], COULEUR_PARCOURU, f, COULEUR_RESTANT]);
}

// ── Tracé recalé sur les routes dessinées ───────────────────────────────────
// Les tuiles OpenFreeMap simplifient les routes : zoomées très près (rond-
// point), elles s'écartent de quelques mètres du tracé TomTom. Autour de la
// voiture, on recale donc le tracé (et la voiture) sur les routes telles
// qu'elles sont dessinées.
const CLASSES_ROUTES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"]);
const RECALAGE_AVANT_M = 150;
const RECALAGE_APRES_M = 1000;
const RECALAGE_TOUS_LES_M = 300;
const ECART_RECALAGE_M = 14;
let recalage = null;

function segmentsRoutesCarte(bbox) {
  const sources = carte.getStyle()?.sources || {};
  const src = Object.keys(sources).find((k) => sources[k].type === "vector");
  if (!src) return [];
  let features;
  try {
    features = carte.querySourceFeatures(src, { sourceLayer: "transportation" });
  } catch {
    return [];
  }
  const [o, s, e, n] = bbox;
  const dedans = ([x, y]) => x >= o && x <= e && y >= s && y <= n;
  // Lire la géométrie d'une route la décode (coûteux), et la carte inclinée
  // charge des tuiles jusqu'à l'horizon : on écarte d'abord celles qui sont
  // hors de la zone, d'après la tuile de chaque route (« tile », fournie par
  // MapLibre ; absente, toutes les routes sont lues comme avant).
  const tuilesUtiles = new Map();
  const latTuile = (y, n2) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n2))) * 180) / Math.PI;
  const tuileDansZone = (f) => {
    const t = f.tile;
    if (!t || !Number.isFinite(t.z) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return true;
    const cle = `${t.z}/${t.x}/${t.y}`;
    let utile = tuilesUtiles.get(cle);
    if (utile === undefined) {
      const n2 = 2 ** t.z;
      utile = (t.x / n2) * 360 - 180 <= e && ((t.x + 1) / n2) * 360 - 180 >= o && latTuile(t.y + 1, n2) <= n && latTuile(t.y, n2) >= s;
      tuilesUtiles.set(cle, utile);
    }
    return utile;
  };
  const segs = [];
  for (const f of features) {
    if (!CLASSES_ROUTES.has(f.properties?.class) || !tuileDansZone(f)) continue;
    const g = f.geometry;
    const lignes = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const l of lignes) for (let i = 1; i < l.length; i++) if (dedans(l[i - 1]) || dedans(l[i])) segs.push([l[i - 1], l[i]]);
  }
  return segs;
}

function recalerAutour(lat, lon) {
  const coords = traceNav?.[0];
  if (!coords?.length || !carte?.getSource("trajet")) return;
  const maintenant = Date.now();
  if (recalage?.essai && maintenant - recalage.essai < 2000 && !recalage.fenetre) return;
  // Point du tracé le plus proche de la voiture, puis la fenêtre autour.
  let i0 = 0;
  let dMin = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = Math.abs(coords[i][1] - lat) + Math.abs(coords[i][0] - lon);
    if (d < dMin) {
      dMin = d;
      i0 = i;
    }
  }
  let a = i0;
  for (let cum = 0; a > 0 && cum < RECALAGE_AVANT_M; a--) cum += haversineKm(coords[a - 1][1], coords[a - 1][0], coords[a][1], coords[a][0]) * 1000;
  let b = i0;
  for (let cum = 0; b < coords.length - 1 && cum < RECALAGE_APRES_M; b++) cum += haversineKm(coords[b][1], coords[b][0], coords[b + 1][1], coords[b + 1][0]) * 1000;
  const fenetre = densifier(coords.slice(a, b + 1), 4);
  const lats = fenetre.map((p) => p[1]);
  const lons = fenetre.map((p) => p[0]);
  const marge = 0.0005;
  const segs = segmentsRoutesCarte([Math.min(...lons) - marge, Math.min(...lats) - marge, Math.max(...lons) + marge, Math.max(...lats) + marge]);
  recalage = { centre: [lat, lon], trace: coords, essai: maintenant, segs, fenetre: null };
  if (segs.length < 3) return; // tuiles pas encore chargées : nouvel essai bientôt
  recalage.fenetre = recalerSurRoutes(fenetre, segs, ECART_RECALAGE_M);
  const affiche = [...coords.slice(0, a), ...recalage.fenetre, ...coords.slice(b + 1)];
  carte.getSource("trajet").setData({ type: "Feature", geometry: { type: "LineString", coordinates: affiche }, properties: {} });
  if (flecheNav) dessinerFlecheManoeuvre(flecheNav);
}

function voitureRecalee(lat, lon) {
  if (!enNavigation || !traceNav) return { lat, lon };
  const [la, lo] = recalage?.centre || [];
  if (!recalage || recalage.trace !== traceNav[0] || !recalage.fenetre || haversineKm(la, lo, lat, lon) * 1000 > RECALAGE_TOUS_LES_M) recalerAutour(lat, lon);
  return (recalage?.fenetre && pointSurLigne(lat, lon, recalage.fenetre, 15)) || { lat, lon };
}

export function majVoiture(lat, lon, cap) {
  positionVoiture = { lat, lon };
  if (feuxNav.length) poserFeuxProches(lat, lon);
  ({ lat, lon } = voitureRecalee(lat, lon));
  if (!voiture) {
    voiture = new maplibregl.Marker({ element: iconeVoiture(), rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([lon, lat]).addTo(carte);
  } else {
    voiture.setLngLat([lon, lat]);
  }
  voiture.setRotation(cap || 0);
}

// Voiture vers le bas de l'écran pour voir loin devant ; en « nord en
// haut », la carte reste inclinée mais ne tourne plus.
// Inclinaison de la vue en navigation : réduite près des ronds-points et
// carrefours serrés (on distingue mieux les routes), en douceur.
// 22° d'origine jugé trop vertical par l'utilisateur (comparé à Sygic, qui
// garde toujours un peu d'horizon) -- relevé à 40° le 2026-09-28, puis rendu
// réglable (Profil › Navigation) le 2026-09-30.
const INCLINAISON_PLATE_MIN = 15;
const INCLINAISON_PLATE_MAX = 60;
let INCLINAISON_PLATE = 40;
let inclinaisonCible = INCLINAISON;
let inclinaisonActuelle = INCLINAISON;

// Réglage Profil › Navigation (40 à 78°), appliqué tout de suite.
export function definirInclinaison3D(degres) {
  const d = Number(degres);
  if (!Number.isFinite(d)) return;
  INCLINAISON = Math.max(INCLINAISON_MIN, Math.min(INCLINAISON_MAX, d));
  inclinaisonCible = INCLINAISON;
  inclinaisonActuelle = INCLINAISON;
}
// Réglage Profil › Navigation (15 à 60°) : inclinaison réduite près des
// ronds-points et carrefours serrés.
export function definirInclinaisonPlate(degres) {
  const d = Number(degres);
  if (!Number.isFinite(d)) return;
  INCLINAISON_PLATE = Math.max(INCLINAISON_PLATE_MIN, Math.min(INCLINAISON_PLATE_MAX, d));
}
export function inclinaisonNavigation(mode) {
  inclinaisonCible = mode === "plat" ? INCLINAISON_PLATE : INCLINAISON;
}

// Hauteur de la carte relue au plus une fois par seconde : la lire à chaque
// image obligeait le navigateur à recalculer la mise en page.
let hauteurCarte = { t: -Infinity, px: 0 };

export function cameraNavigation(lat, lon, cap, zoom, sensDeMarche, anime = true) {
  const maintenant = performance.now();
  if (maintenant - hauteurCarte.t > 1000) hauteurCarte = { t: maintenant, px: carte.getContainer().clientHeight };
  const hauteur = hauteurCarte.px;
  inclinaisonActuelle += (inclinaisonCible - inclinaisonActuelle) * 0.04;
  const vue = {
    center: [lon, lat],
    zoom: zoom + ECART_ZOOM,
    bearing: sensDeMarche ? cap || 0 : 0,
    pitch: inclinaisonActuelle,
    // En paysage, la colonne de gauche est retirée de la zone utile.
    padding: { top: hauteur * 0.42, bottom: 0, left: decalageNavGauche(), right: 0 },
  };
  if (anime) carte.easeTo({ ...vue, duration: 600 });
  else carte.jumpTo(vue);
}

export function apercuNavigation(coords) {
  if (!coords?.length) return;
  const limites = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  // Le décalage « voiture en bas » de cameraNavigation reste sinon appliqué.
  carte.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  carte.fitBounds(limites, { bearing: 0, pitch: 0, padding: { top: 190, bottom: 150, left: 40, right: 40 }, duration: 800 });
}

function iconeBorne(b, selectionnee = false) {
  const kw = puissanceBorne(b);
  const cb = b.officiel && !b.officiel.indisponible && ["oui", "partiel"].includes(b.officiel.paiement_cb);
  const el = document.createElement("div");
  el.className = "gps-pin-3d";
  el.innerHTML = `<div class="gps-pin ${classePuissance(kw)}${selectionnee ? " selection" : ""}"><span>${kw || "?"}</span>${cb ? '<b class="gps-pin-cb">CB</b>' : ""}</div>`;
  return el;
}

export function afficherBornes(bornes, onClic) {
  for (const m of marqueursBornes) m.remove();
  marqueursBornes = bornes.map((b) => {
    const el = iconeBorne(b);
    el.addEventListener("click", () => onClic(b));
    return new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([b.lon, b.lat]);
  });
  if (bornesVisibles) for (const m of marqueursBornes) m.addTo(carte);
}

export function montrerBornes(visible) {
  bornesVisibles = visible;
  for (const m of marqueursBornes) {
    if (visible) m.addTo(carte);
    else m.remove();
  }
}

let marqueurGaree = null;

// Point de l'écran (px dans la carte) → { lat, lon }.
export function pointVersLatLon(x, y) {
  if (!carte) return null;
  const p = carte.unproject([x, y]);
  return { lat: p.lat, lon: p.lng };
}
