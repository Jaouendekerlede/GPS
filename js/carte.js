// Carte plein écran : fonds (sombre / plan / satellite), épingles de bornes
// colorées selon la puissance, position de l'utilisateur, itinéraire (aller
// vert, retour orange pointillé, arrêts 🔋) et curseur "où serai-je ?".
// Le panneau coulissant cache le bas de la carte : `decalageBas` permet de
// centrer et cadrer dans la partie réellement visible.

// Cette carte 2D (Leaflet) peut être remplacée à l'écran par la carte 3D
// (carte3d.js) : les fonctions d'affichage alimentent toujours les deux,
// celles de cadrage s'adressent à la carte visible.

import { escapeHtml } from "./util.js";
import { getApiKeys } from "./config.js";
import { lireReglages } from "./storage.js";
import * as c3d from "./carte3d.js";
import { svgVoiture } from "./icones-voiture.js";
import { icone } from "./icones.js";

let explo3D = false;
let surDeplacement = null;

let carte = null;
let fond = null;
let nomFond = "sombre";
let coucheBornes = null;
let coucheSelection = null;
let coucheTrajet = null;
// Itinéraires proposés mais non choisis : dans coucheTrajet pour être
// masqués avec lui pendant la navigation.
let coucheAlternatives = null;
// Points de passage imposés choisis à la planification (appui long).
let couchePointsPassage = null;
let curseur = null;
let marqueurPosition = null;
let cerclePrecisionPosition = null;
let selection = null;
let decalageBas = 0;
const marqueurs = new Map();

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION_OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// Fonds TomTom (clé déjà utilisée pour les itinéraires) : tuiles en double
// densité, donc nettes sur les écrans de téléphone, là où les tuiles OSM
// sont agrandies et floues. Sans clé, ou si TomTom refuse les tuiles, on
// retombe sur OSM (le fond sombre est alors OSM inversé par un filtre CSS).
// detectRetina : sur un écran dense, on charge le niveau de zoom au-dessus
// (2× plus de pixels) au lieu d'agrandir une tuile 256 px.
// Au-delà du dernier niveau fourni (zoom 18,5 à 19,5 aux carrefours en
// guidage), la tuile est agrandie : sans cela la couche disparaît et la carte
// devient noire. Sur écran dense, detectRetina demande déjà un niveau de plus.
const ZOOM_MAX_AFFICHE = 22;
const tuilesJusqua = (niveau) => ({ maxZoom: ZOOM_MAX_AFFICHE, maxNativeZoom: L.Browser.retina ? niveau - 1 : niveau, detectRetina: true });
const osmSombre = () => L.tileLayer(OSM, { ...tuilesJusqua(19), attribution: ATTRIBUTION_OSM, className: "gps-tuiles-sombres" });
const osmPlan = () => L.tileLayer(OSM, { ...tuilesJusqua(19), attribution: ATTRIBUTION_OSM });

// Après un refus (quota, clé), on ne réessaie TomTom qu'au bout d'un moment,
// sinon chaque changement de fond repasse par un écran noir.
const PAUSE_APRES_REFUS_MS = 10 * 60 * 1000;
let tomtomRefuseJusqua = 0;

function fondTomTom(style, repli) {
  const cle = getApiKeys().tomtom;
  if (!cle || Date.now() < tomtomRefuseJusqua) return repli();
  // Une tuile TomTom 512 px couvre la même zone qu'une tuile 256 px : on
  // l'affiche en 256 px CSS, soit deux pixels d'image par pixel d'écran.
  const couche = L.tileLayer(`https://api.tomtom.com/map/1/tile/basic/${style}/{z}/{x}/{y}.png?key=${encodeURIComponent(cle)}&tileSize=512&language=fr-FR`, {
    maxZoom: ZOOM_MAX_AFFICHE,
    maxNativeZoom: 20,
    attribution: '© <a href="https://www.tomtom.com/">TomTom</a>',
  });
  let erreursDeSuite = 0;
  couche.on("tileload", () => (erreursDeSuite = 0));
  couche.on("tileerror", () => {
    // Clé refusée, quota du jour épuisé ou réseau : les tuiles suivantes
    // échouent toutes et la carte se remplit de noir. Une tuile ratée
    // isolée (réseau instable) ne suffit pas.
    if (++erreursDeSuite >= 6 && fond === couche) {
      console.warn("[CARTE] Tuiles TomTom refusées, retour sur OpenStreetMap");
      tomtomRefuseJusqua = Date.now() + PAUSE_APRES_REFUS_MS;
      carte.removeLayer(couche);
      fond = repli();
      if (!explo3D) fond.addTo(carte).bringToBack();
    }
  });
  return couche;
}

const FONDS = {
  sombre: () => fondTomTom("night", osmSombre),
  plan: () => fondTomTom("main", osmPlan),
  osm: osmPlan,
  satellite: () =>
    L.layerGroup([
      L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { ...tuilesJusqua(19), attribution: "Imagerie © Esri" }),
      L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, tuilesJusqua(19)),
      L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, tuilesJusqua(19)),
    ]),
};
export const ORDRE_FONDS = ["sombre", "plan", "osm", "satellite"];
export const ICONES_FONDS = { sombre: "🌙", plan: "🗺️", osm: "🌍", satellite: "🛰️" };

let rotationDispo = false;
let coucheNav = null;
let ligneParcourue = null;
let ligneRestante = null;
// Positions du tracé converties une seule fois, et dernier point de route
// dépassé : le tracé n'est redécoupé que lorsque ce point change.
let pointsRoute = [];
let indiceDecoupe = -1;
let raccordParcouru = null;
let raccordRestant = null;
let marqueursRadars = [];
let marqueursFeux = [];
let marqueurVoiture = null;
let surDeplacementManuel = null;

const ZOOM_SNAP = 0.5;

export function carteLeaflet() {
  return carte;
}

export function initCarte(idElement, { fondInitial = "sombre", onDeplacement } = {}) {
  carte = L.map(idElement, {
    zoomControl: false,
    attributionControl: true,
    zoomSnap: ZOOM_SNAP,
    // module leaflet-rotate : carte orientable (navigation "sens de marche")
    rotate: true,
    bearing: 0,
    rotateControl: false,
    touchRotate: false,
    shiftKeyRotate: false,
  }).setView([46.6, 2.4], 6);
  rotationDispo = typeof carte.setBearing === "function";
  carte.attributionControl.setPrefix(false);
  choisirFond(fondInitial);
  coucheBornes = creerCoucheBornes(); // GPS : bornes non affichées
  coucheSelection = L.layerGroup().addTo(carte);
  coucheTrajet = L.layerGroup().addTo(carte);
  coucheAlternatives = L.layerGroup();
  couchePointsPassage = L.layerGroup().addTo(carte);
  surDeplacement = onDeplacement;
  carte.on("moveend", () => !explo3D && onDeplacement?.());
  // Panne de la 3D (tuiles refusées, moteur graphique coupé) : retour en 2D.
  c3d.definirSurPanne((raison) => {
    if (!explo3D) return;
    activerCarte3D(false);
    document.dispatchEvent(new CustomEvent("carte3d-panne", { detail: raison }));
  });
  carte.on("dragstart zoomstart", (e) => {
    if (e.type === "dragstart" || e.originalEvent) surDeplacementManuel?.();
  });
  return carte;
}

// ── Mode navigation ─────────────────────────────────────────────────────────

export function entrerNavigation({ onDeplacementManuel } = {}) {
  surDeplacementManuel = onDeplacementManuel;
  montrerBornes2D(false);
  if (carte.hasLayer(coucheTrajet)) carte.removeLayer(coucheTrajet);
  placerCurseur2D(undefined, undefined);
  coucheNav = coucheNav || L.layerGroup();
  coucheNav.clearLayers();
  coucheNav.addTo(carte);
  // Zoom continu pour que l'animation de navigation le fasse varier en douceur.
  carte.options.zoomSnap = 0;
  // Carte des bornes en 3D : elle s'efface le temps de cette navigation 2D.
  if (explo3D) {
    c3d.masquerExploration(true);
    if (fond && !carte.hasLayer(fond)) fond.addTo(carte).bringToBack?.();
  }
  setTimeout(() => carte.invalidateSize(), 50);
}

export function quitterNavigation() {
  surDeplacementManuel = null;
  if (coucheNav) {
    coucheNav.clearLayers();
    carte.removeLayer(coucheNav);
  }
  if (marqueurVoiture) {
    carte.removeLayer(marqueurVoiture);
    marqueurVoiture = null;
  }
  feuxNav = [];
  centreFeux = null;
  if (rotationDispo) carte.setBearing(0);
  carte.options.zoomSnap = ZOOM_SNAP;
  carte.setZoom(Math.round(carte.getZoom() / ZOOM_SNAP) * ZOOM_SNAP, { animate: false });
  if (!carte.hasLayer(coucheTrajet)) carte.addLayer(coucheTrajet);
  if (explo3D) {
    if (fond) carte.removeLayer(fond);
    c3d.masquerExploration(false);
  }
  setTimeout(() => carte.invalidateSize(), 50);
}

export function dessinerRouteNavigation(coords, arrets, destination) {
  coucheNav.clearLayers();
  coucheFleche = null;
  const ll = coords.map(([lon, lat]) => L.latLng(lat, lon));
  pointsRoute = ll;
  indiceDecoupe = -1;
  const restant = { color: "#1a6fe8", weight: 9, opacity: 0.95, interactive: false };
  const parcouru = { color: "#6b7385", weight: 9, opacity: 0.9, interactive: false };
  L.polyline(ll, { color: "#062a1e", weight: 14, opacity: 0.55, interactive: false }).addTo(coucheNav);
  ligneRestante = L.polyline(ll, restant).addTo(coucheNav);
  raccordRestant = L.polyline([], restant).addTo(coucheNav);
  ligneParcourue = L.polyline([], parcouru).addTo(coucheNav);
  raccordParcouru = L.polyline([], parcouru).addTo(coucheNav);
  for (const a of arrets || []) {
    L.marker([a.lat, a.lon], { icon: pastille(32, "rgba(79,224,255,.95)", "🔋"), zIndexOffset: 5000, interactive: false }).addTo(coucheNav);
  }
  if (destination) L.marker([destination.lat, destination.lon], { icon: pastille(26, "#ff6b35", "🏁"), zIndexOffset: 5000, interactive: false }).addTo(coucheNav);
  marqueursRadars = [];
}

// Radars (officiels OSM ou signalés soi-même) sur le tracé : un symbole de
// radar plutôt qu'une épingle générique -- demande explicite de
// l'utilisateur le 2026-09-27. Ajoutés à coucheNav (donc effacés avec le
// reste au prochain dessinerRouteNavigation -- à rappeler ensuite).
export function dessinerRadars(radars) {
  for (const m of marqueursRadars) m.remove();
  const symbole = `<span style="color:#fff;display:flex">${icone("radar", 16)}</span>`;
  marqueursRadars = (radars || []).map((r) => L.marker([r.lat, r.lon], { icon: pastille(28, "rgba(255,70,60,.95)", symbole), zIndexOffset: 4500, interactive: false }).addTo(coucheNav));
}

// Feux tricolores sur le tracé (OpenStreetMap) : demande du 2026-10-03, déjà
// utilisés pour les annonces vocales (« au deuxième feu… »), maintenant
// visibles aussi sur la carte. Ajoutés à coucheNav (effacés et redessinés
// avec le reste au prochain dessinerRouteNavigation).
export function dessinerFeux(feux) {
  feuxNav = feux || [];
  centreFeux = null;
  for (const m of marqueursFeux) m.remove();
  marqueursFeux = [];
  if (marqueurVoiture) poserFeuxProches(marqueurVoiture.getLatLng());
}

// Seuls les feux proches de la voiture sont posés : en « sens de marche »,
// chaque marqueur est replacé à chaque rotation de la carte, et un long
// trajet en compte des centaines.
const RAYON_FEUX_M = 3000;
const RELANCE_FEUX_M = 1000;
let feuxNav = [];
let centreFeux = null;

function poserFeuxProches(position) {
  if (centreFeux && carte.distance(centreFeux, position) < RELANCE_FEUX_M) return;
  centreFeux = L.latLng(position.lat, position.lng);
  for (const m of marqueursFeux) m.remove();
  const symbole = `<span style="font-size:14px;line-height:1;display:flex">🚦</span>`;
  marqueursFeux = feuxNav
    .filter((f) => carte.distance(centreFeux, [f.lat, f.lon]) < RAYON_FEUX_M)
    .map((f) => L.marker([f.lat, f.lon], { icon: pastille(24, "rgba(40,40,45,.92)", symbole), zIndexOffset: 4400, interactive: false }).addTo(coucheNav));
}

// Flèche blanche du prochain virage sur le tracé (null : l'effacer).
let coucheFleche = null;
export function dessinerFlecheManoeuvre(fleche) {
  coucheFleche?.remove();
  coucheFleche = null;
  if (!fleche || !coucheNav) return;
  const ll = (pts) => pts.map(([lon, lat]) => [lat, lon]);
  coucheFleche = L.layerGroup([
    L.polyline(ll(fleche.ligne), { color: "#0a2a5c", opacity: 0.5, weight: 10, lineCap: "round", lineJoin: "round", interactive: false }),
    L.polyline(ll(fleche.ligne), { color: "#ffffff", opacity: 0.92, weight: 6, lineCap: "round", lineJoin: "round", interactive: false }),
    L.polygon(ll(fleche.pointe), { stroke: false, fillColor: "#ffffff", fillOpacity: 0.92, interactive: false }),
  ]).addTo(coucheNav);
}

export function majProgressionNavigation(coords, indice, lat, lon) {
  if (!ligneRestante) return;
  if (pointsRoute.length !== coords.length) {
    pointsRoute = coords.map(([x, y]) => L.latLng(y, x));
    indiceDecoupe = -1;
  }
  // Appelée plusieurs fois par seconde : redessiner tout le tracé (des
  // milliers de points sur un long trajet) à chaque fois saccadait la carte.
  // Les deux grandes lignes ne changent qu'au passage d'un point de la route ;
  // entre deux, seuls les deux courts raccords jusqu'à la voiture bougent.
  if (indice !== indiceDecoupe) {
    indiceDecoupe = indice;
    ligneParcourue.setLatLngs(pointsRoute.slice(0, indice + 1));
    ligneRestante.setLatLngs(pointsRoute.slice(indice + 1));
  }
  const actuel = [lat, lon];
  raccordParcouru.setLatLngs(pointsRoute[indice] ? [pointsRoute[indice], actuel] : []);
  raccordRestant.setLatLngs(pointsRoute[indice + 1] ? [actuel, pointsRoute[indice + 1]] : []);
}

let styleVoiture = "fleche_bleue";

function iconeVoiture() {
  return L.divIcon({ className: "", iconSize: [56, 56], iconAnchor: [28, 28], html: `<div class="gps-voiture">${svgVoiture(styleVoiture)}</div>` });
}

// Réglage Profil > Navigation.
export function definirIconeVoiture(style) {
  styleVoiture = style || "fleche_bleue";
  marqueurVoiture?.setIcon(iconeVoiture());
}

export function majVoiture(lat, lon, cap) {
  if (!marqueurVoiture) marqueurVoiture = L.marker([lat, lon], { icon: iconeVoiture(), interactive: false, zIndexOffset: 30000 }).addTo(carte);
  else marqueurVoiture.setLatLng([lat, lon]);
  if (feuxNav.length) poserFeuxProches(marqueurVoiture.getLatLng());
  // leaflet-rotate tourne la carte dans le sens horaire : un cap apparaît
  // à l'écran décalé de +bearing.
  const relatif = (cap || 0) + (rotationDispo ? carte.getBearing() : 0);
  const el = marqueurVoiture.getElement()?.querySelector(".gps-voiture");
  if (el) el.style.transform = `rotate(${relatif}deg)`;
}

// Suit la voiture : en mode "sens de marche", la carte tourne pour que la
// route devant soit en haut ; la voiture est placée vers le bas de l'écran
// pour voir plus loin devant.
// Largeur de la colonne de consignes quand le téléphone est à l'horizontale
// (0 en portrait) : lue sur l'écran, partagée avec la carte 3D.
// Appelée à chaque image par les deux cartes : la mesure est gardée une
// seconde, la relire à chaque fois obligeait à recalculer la mise en page.
let colonneGauche = { t: -Infinity, px: 0 };
export function decalageNavGauche() {
  const maintenant = performance.now();
  if (maintenant - colonneGauche.t < 1000) return colonneGauche.px;
  let px = 0;
  if (matchMedia("(orientation: landscape) and (max-height: 560px)").matches) {
    const colonne = document.querySelector(".gps-nav-haut");
    px = colonne ? colonne.getBoundingClientRect().right : 0;
  }
  colonneGauche = { t: maintenant, px };
  return px;
}

export function cameraNavigation(lat, lon, cap, zoom, sensDeMarche, anime = true) {
  // Mesuré : setBearing(90) met l'est en BAS de l'écran (rotation horaire).
  // Pour avoir le cap en haut, il faut donc tourner de -cap.
  const bearing = rotationDispo && sensDeMarche ? (360 - (cap || 0)) % 360 : 0;
  if (rotationDispo && Math.abs(((carte.getBearing() - bearing + 540) % 360) - 180) > 0.5) carte.setBearing(bearing);
  const hauteur = carte.getSize().y;
  const recul = hauteur * 0.2;
  // Le haut et la droite de l'écran, exprimés dans le plan non tourné de la
  // carte. En paysage, la colonne de gauche cache une partie de la carte :
  // la voiture se place au milieu de ce qui reste visible.
  const angle = (-bearing * Math.PI) / 180;
  const decalage = decalageNavGauche() / 2;
  const point = carte
    .project([lat, lon], zoom)
    .add([Math.sin(angle) * recul - Math.cos(angle) * decalage, -Math.cos(angle) * recul - Math.sin(angle) * decalage]);
  carte.setView(carte.unproject(point, zoom), zoom, { animate: anime, duration: 0.9, easeLinearity: 1 });
}

export function apercuNavigation(coords) {
  if (rotationDispo) carte.setBearing(0);
  if (!coords?.length) return;
  carte.fitBounds(L.latLngBounds(coords.map(([lon, lat]) => [lat, lon])), { paddingTopLeft: [40, 190], paddingBottomRight: [40, 150] });
}

export function choisirFond(nom) {
  if (!FONDS[nom]) nom = "sombre";
  // Déjà en place (le démarrage le demande plusieurs fois) : ne pas
  // recharger les mêmes tuiles.
  if (fond && nom === nomFond) return nom;
  return poserFond(nom);
}

function poserFond(nom) {
  if (fond) carte.removeLayer(fond);
  fond = FONDS[nom]();
  nomFond = nom;
  // En 3D, les tuiles 2D sont inutiles (et consommeraient le quota TomTom).
  if (!explo3D) {
    fond.addTo(carte);
    if (fond.bringToBack) fond.bringToBack();
  } else {
    c3d.preparer(optionsCarte3D()).then((ok) => ok || activerCarte3D(false));
  }
  return nom;
}

export function fondCourant() {
  return nomFond;
}

export function optionsCarte3D() {
  const r = lireReglages();
  return { fond: nomFond === "osm" ? "plan" : nomFond, fournisseur: r.carte_3d || "libre", relief: r.relief_3d === true };
}

export function carte3DActive() {
  return explo3D;
}

// Passe la carte des bornes en 3D (ou revient en 2D) au même endroit.
// Renvoie false si la 3D n'a pas pu s'afficher (raison : c3d.derniereErreur()).
export async function activerCarte3D(actif) {
  if (!actif) {
    if (!explo3D) return true;
    const vue = c3d.desactiverExploration();
    explo3D = false;
    if (fond && !carte.hasLayer(fond)) {
      fond.addTo(carte);
      if (fond.bringToBack) fond.bringToBack();
    }
    if (vue) carte.setView([vue.lat, vue.lon], vue.zoom, { animate: false });
    surDeplacement?.();
    return true;
  }
  if (explo3D) return true;
  if (!(await c3d.preparer(optionsCarte3D()))) return false;
  const centre = carte.getCenter();
  c3d.activerExploration({ lat: centre.lat, lon: centre.lng, zoom: carte.getZoom(), onDeplacement: surDeplacement, decalageBas });
  explo3D = true;
  if (fond) carte.removeLayer(fond);
  return true;
}

export const derniereErreur3D = () => c3d.derniereErreur();

// Après un changement de clé TomTom : passer aux tuiles nettes (ou en revenir).
export function rechargerFond() {
  return poserFond(nomFond);
}

export function fondSuivant() {
  return choisirFond(ORDRE_FONDS[(ORDRE_FONDS.indexOf(nomFond) + 1) % ORDRE_FONDS.length]);
}

function definirDecalageBas2D(px) {
  // Une mesure absente (undefined, NaN) donnerait NaN partout : on retient 0.
  decalageBas = Number.isFinite(px) ? Math.max(0, px) : 0;
}

// Centre de la partie visible (au-dessus du panneau)
function centreVisible2D() {
  const taille = carte.getSize();
  const p = carte.containerPointToLatLng([taille.x / 2, Math.max(1, (taille.y - decalageBas) / 2)]);
  return { lat: p.lat, lon: p.lng };
}

function rayonVisibleKm2D() {
  const taille = carte.getSize();
  const c = carte.containerPointToLatLng([taille.x / 2, Math.max(1, (taille.y - decalageBas) / 2)]);
  const coin = carte.containerPointToLatLng([taille.x, 0]);
  return c.distanceTo(coin) / 1000;
}

function zoomActuel2D() {
  return carte.getZoom();
}

function centrer2D(lat, lon, zoom) {
  const z = zoom ?? carte.getZoom();
  const point = carte.project([lat, lon], z).add([0, decalageBas / 2]);
  carte.setView(carte.unproject(point, z), z, { animate: true });
}

// ── Bornes ──────────────────────────────────────────────────────────────────

export function classePuissance(kw) {
  return kw >= 150 ? "ultra" : kw >= 50 ? "rapide" : kw >= 22 ? "acc" : "lent";
}

export function puissanceBorne(b) {
  return Math.round(Math.max(b.puissance_max_kw || 0, b.officiel?.puissance_max_kw || 0));
}

function cbConfirmee(b) {
  const cb = b.officiel && !b.officiel.indisponible ? b.officiel.paiement_cb : null;
  return cb === "oui" || cb === "partiel";
}

// Bornes proches regroupées en un rond « nombre » quand elles se
// chevaucheraient ; séparées à partir du zoom 16. Sans l'extension (réseau),
// simple couche sans regroupement.
const ZOOM_SANS_REGROUPEMENT = 16;

function creerCoucheBornes() {
  if (!L.markerClusterGroup) return L.layerGroup();
  return L.markerClusterGroup({
    maxClusterRadius: 42,
    disableClusteringAtZoom: ZOOM_SANS_REGROUPEMENT,
    removeOutsideVisibleBounds: true,
    chunkedLoading: true,
    chunkInterval: 100,
    chunkDelay: 25,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: false,
    iconCreateFunction: (groupe) => {
      const enfants = groupe.getAllChildMarkers();
      const kwMax = Math.max(0, ...enfants.map((m) => m.options.kw || 0));
      return L.divIcon({ className: "", iconSize: [40, 40], html: `<div class="gps-grappe ${classePuissance(kwMax)}">${enfants.length}</div>` });
    },
  });
}

function iconeBorne(b) {
  const kw = puissanceBorne(b);
  return L.divIcon({
    className: "",
    iconSize: [36, 46],
    iconAnchor: [18, 44],
    tooltipAnchor: [0, -40],
    html: `<div class="gps-pin ${classePuissance(kw)}${b === selection ? " selection" : ""}"><span>${kw || "?"}</span>${cbConfirmee(b) ? '<b class="gps-pin-cb">CB</b>' : ""}</div>`,
  });
}

// La borne sélectionnée vit hors des groupes, pour rester toujours visible.
function afficherBornes2D(bornes, onClic) {
  coucheBornes.clearLayers();
  coucheSelection.clearLayers();
  marqueurs.clear();
  const aRegrouper = [];
  for (const b of bornes) {
    const m = L.marker([b.lat, b.lon], { icon: iconeBorne(b), kw: puissanceBorne(b), zIndexOffset: puissanceBorne(b) * 2 + (b === selection ? 10000 : 0) });
    m.on("click", () => onClic(b));
    if (b === selection) coucheSelection.addLayer(m);
    else aRegrouper.push(m);
    marqueurs.set(b, m);
  }
  if (typeof coucheBornes.addLayers === "function") coucheBornes.addLayers(aRegrouper);
  else for (const marqueur of aRegrouper) coucheBornes.addLayer(marqueur);
}

function rafraichirBorne2D(b) {
  marqueurs.get(b)?.setIcon(iconeBorne(b));
}

function selectionnerBorne2D(b) {
  const ancienne = selection;
  selection = b;
  const mAncienne = marqueurs.get(ancienne);
  if (mAncienne) {
    coucheSelection.removeLayer(mAncienne);
    mAncienne.setZIndexOffset(puissanceBorne(ancienne) * 2);
    coucheBornes.addLayer(mAncienne);
    rafraichirBorne2D(ancienne);
  }
  const m = marqueurs.get(b);
  if (m) {
    coucheBornes.removeLayer(m);
    m.setZIndexOffset(10000);
    coucheSelection.addLayer(m);
    rafraichirBorne2D(b);
  }
}

function montrerBornes2D(visible) {
  for (const couche of [coucheBornes, coucheSelection]) {
    if (visible && !carte.hasLayer(couche)) carte.addLayer(couche);
    if (!visible && carte.hasLayer(couche)) carte.removeLayer(couche);
  }
}

// ── Position de l'utilisateur ───────────────────────────────────────────────

// ── Parkings ────────────────────────────────────────────────────────────────

let coucheParkings = null;

// Icône « P » (⚡ s'il y a des places avec recharge), partagée avec la 3D.
export function htmlIconeParking(p) {
  return `<div class="gps-parking${p.places_recharge ? " recharge" : ""}">P${p.places_recharge ? "<b>⚡</b>" : ""}</div>`;
}

// liste : [{ parking, html }] -- html : fiche affichée au toucher.
// Zone visible au-dessus du panneau, en degrés.
function afficherPosition2D(lat, lon, precision) {
  const icone = L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="gps-position"></div>' });
  if (marqueurPosition) marqueurPosition.setLatLng([lat, lon]);
  else marqueurPosition = L.marker([lat, lon], { icon: icone, interactive: false, zIndexOffset: 20000 }).addTo(carte);
  if (Number.isFinite(precision) && precision > 0) {
    if (cerclePrecisionPosition) cerclePrecisionPosition.setLatLng([lat, lon]).setRadius(precision);
    else cerclePrecisionPosition = L.circle([lat, lon], { radius: precision, color: "#4fe0ff", weight: 1.5, opacity: 0.8, fillColor: "#4fe0ff", fillOpacity: 0.12, interactive: false }).addTo(carte);
    cerclePrecisionPosition.bringToBack();
  } else if (cerclePrecisionPosition) {
    carte.removeLayer(cerclePrecisionPosition);
    cerclePrecisionPosition = null;
  }
}

// ── Itinéraire ──────────────────────────────────────────────────────────────

function pastille(taille, couleur, contenu = "") {
  return L.divIcon({
    className: "",
    iconSize: [taille, taille],
    iconAnchor: [taille / 2, taille / 2],
    html: `<div class="gps-point-trajet" style="width:${taille}px;height:${taille}px;background:${couleur};box-shadow:0 0 12px ${couleur};">${contenu}</div>`,
  });
}

export function couleurBouchon(b) {
  return b.fermeture ? "#8b0000" : b.niveau >= 3 ? "#ff3b30" : "#ffb400";
}

export function texteBouchon(b) {
  const nature = b.fermeture ? "Route fermée" : b.niveau >= 3 ? "Bouchon" : "Ralentissement";
  return b.retard_min ? `${nature} : +${b.retard_min} min` : nature;
}

// Étiquette de batterie d'un arrêt : « 12 → 85 % ».
export function texteBatterieArret(a) {
  return a.pct_arrivee_borne != null && a.pct_depart_borne != null ? `🔋 ${Math.round(a.pct_arrivee_borne)} → ${Math.round(a.pct_depart_borne)} %` : "";
}

function ajouterArrets(arrets, icone, prefixe, onClicArret) {
  (arrets || []).forEach((arret, i) => {
    if (arret.lat === undefined || arret.lon === undefined) return;
    L.marker([arret.lat, arret.lon], { icon: icone, zIndexOffset: 5000 })
      .bindTooltip(`${escapeHtml(prefixe(i))} : ${escapeHtml(arret.nom_borne || "Borne")}`)
      .on("click", () => onClicArret(arret))
      .addTo(coucheTrajet);
    const batterie = texteBatterieArret(arret);
    if (batterie) {
      L.marker([arret.lat, arret.lon], {
        icon: L.divIcon({ className: "", iconSize: [0, 0], iconAnchor: [-18, 10], html: `<span class="gps-etiquette-arret">${escapeHtml(batterie)}</span>` }),
        interactive: false,
        zIndexOffset: 4900,
      }).addTo(coucheTrajet);
    }
  });
}

// liste : [{ coords, libelle, onClic }] -- sans recadrer la carte, car
// elle est rafraîchie au fil des calculs pendant que l'utilisateur regarde.
function afficherAlternatives2D(liste) {
  coucheAlternatives.clearLayers();
  for (const { coords, libelle, onClic } of liste) {
    if (!coords?.length) continue;
    const latlngs = coords.map(([lon, lat]) => [lat, lon]);
    const trace = L.polyline(latlngs, { color: "#7d8797", weight: 5, opacity: 0.75 }).addTo(coucheAlternatives);
    // Zone de toucher plus large que le trait visible (doigt sur téléphone).
    const zone = L.polyline(latlngs, { color: "#000", weight: 22, opacity: 0 }).addTo(coucheAlternatives);
    for (const l of [trace, zone]) {
      l.bindTooltip(escapeHtml(libelle), { sticky: true }).on("click", onClic);
      l.bringToBack();
    }
  }
}

function afficherTrajet2D(data, onClicArret) {
  coucheTrajet.clearLayers();
  coucheAlternatives.clearLayers();
  coucheAlternatives.addTo(coucheTrajet);
  placerCurseur2D(undefined, undefined);
  if (!data?.coords?.length) return;

  const aller = L.polyline(data.coords.map(([lon, lat]) => [lat, lon]), { color: "#1a6fe8", weight: 6, opacity: 0.9 }).addTo(coucheTrajet);
  // Ralentissements et bouchons par-dessus le tracé.
  for (const b of data.bouchons || []) {
    const morceau = data.coords.slice(b.debut, b.fin + 1).map(([lon, lat]) => [lat, lon]);
    if (morceau.length < 2) continue;
    L.polyline(morceau, { color: couleurBouchon(b), weight: 6, opacity: 0.95, interactive: true })
      .bindTooltip(texteBouchon(b), { sticky: true })
      .addTo(coucheTrajet);
  }
  L.polyline(data.coords.map(([lon, lat]) => [lat, lon]), { color: "#04221a", weight: 10, opacity: 0.35 }).addTo(coucheTrajet).bringToBack();
  let limites = aller.getBounds();

  const retour = data.retour;
  if (retour?.ok && retour.coords?.length) {
    const r = L.polyline(retour.coords.map(([lon, lat]) => [lat, lon]), { color: "#ffb400", weight: 4, opacity: 0.8, dashArray: "8,8" }).addTo(coucheTrajet);
    limites = limites.extend(r.getBounds());
    ajouterArrets(retour.arrets, pastille(24, "rgba(255,180,0,.95)", "🔋"), () => "Retour", onClicArret);
  }

  if (data.from_lat !== undefined) {
    L.marker([data.from_lat, data.from_lon], { icon: pastille(18, "#1a6fe8"), zIndexOffset: 6000 }).bindTooltip(escapeHtml(data.from_name || "Départ")).addTo(coucheTrajet);
  }
  if (data.to_lat !== undefined) {
    L.marker([data.to_lat, data.to_lon], { icon: pastille(22, "#ff6b35", "🏁"), zIndexOffset: 6000 }).bindTooltip(escapeHtml(data.to_name || "Arrivée")).addTo(coucheTrajet);
  }
  ajouterArrets(data.arrets, pastille(30, "rgba(79,224,255,.95)", "🔋"), (i) => `Arrêt ${i + 1}`, onClicArret);

  carte.fitBounds(limites, { paddingTopLeft: [30, 130], paddingBottomRight: [30, decalageBas + 30] });
}

function effacerTrajet2D() {
  coucheTrajet.clearLayers();
  placerCurseur2D(undefined, undefined);
}

function placerCurseur2D(lat, lon, label) {
  if (!carte) return;
  if (curseur) {
    carte.removeLayer(curseur);
    curseur = null;
  }
  if (lat === undefined || lon === undefined) return;
  curseur = L.marker([lat, lon], { icon: pastille(22, "rgba(0,229,255,.95)"), zIndexOffset: 7000 })
    .bindTooltip(escapeHtml(label || "Position estimée"), { permanent: true, direction: "top", offset: [0, -12] })
    .addTo(carte);
}

// ── Aiguillage 2D / 3D ──────────────────────────────────────────────────────
// Données : la 2D et la 3D sont toujours tenues à jour (bascule instantanée).
// Cadrage et mesures : seulement la carte affichée.

export function definirDecalageBas(px) {
  definirDecalageBas2D(px);
  c3d.exploDecalageBas(Math.max(0, px));
}

export function centreVisible() {
  return explo3D ? c3d.exploCentreVisible() : centreVisible2D();
}

export function rayonVisibleKm() {
  return explo3D ? c3d.exploRayonVisibleKm() : rayonVisibleKm2D();
}

export function zoomActuel() {
  return explo3D ? c3d.exploZoom() : zoomActuel2D();
}

export function centrer(lat, lon, zoom) {
  if (explo3D) c3d.exploCentrer(lat, lon, zoom);
  else centrer2D(lat, lon, zoom);
}

export function afficherBornes(bornes, onClic) {
  afficherBornes2D(bornes, onClic);
  c3d.exploBornes(bornes, onClic);
}

export function rafraichirBorne(b) {
  rafraichirBorne2D(b);
  c3d.exploRafraichirBorne(b);
}

export function selectionnerBorne(b) {
  selectionnerBorne2D(b);
  c3d.exploSelection(b);
}

export function montrerBornes(visible) {
  montrerBornes2D(visible);
  c3d.exploMontrerBornes(visible);
}

export function afficherPosition(lat, lon, precision) {
  afficherPosition2D(lat, lon, precision);
  c3d.exploPosition(lat, lon);
}

// Cercle « jusqu'où je peux aller » autour d'un point (rayonKm nul : l'effacer).
let cercleAutonomie = null;
export function afficherAutonomie(lat, lon, rayonKm) {
  if (cercleAutonomie) {
    carte.removeLayer(cercleAutonomie);
    cercleAutonomie = null;
  }
  c3d.exploAutonomie(rayonKm ? { lat, lon, rayonKm } : null);
  if (!rayonKm) return;
  cercleAutonomie = L.circle([lat, lon], { radius: rayonKm * 1000, color: "#1a6fe8", weight: 2.5, dashArray: "8 8", fillColor: "#1a6fe8", fillOpacity: 0.06, interactive: false }).addTo(carte);
  if (!explo3D) carte.fitBounds(cercleAutonomie.getBounds(), { padding: [20, 20] });
}

export function afficherPrecisionGPS(lat, lon, precision) {
  if (!Number.isFinite(precision) || precision <= 0) return;
  afficherPosition2D(lat, lon, precision);
}

export function afficherAlternatives(liste) {
  afficherAlternatives2D(liste);
  c3d.exploAlternatives(liste);
}

export function afficherTrajet(data, onClicArret) {
  afficherTrajet2D(data, onClicArret);
  c3d.exploTrajet(data, onClicArret);
}

export function effacerTrajet() {
  effacerTrajet2D();
  c3d.exploEffacerTrajet();
}

export function placerCurseur(lat, lon, label) {
  placerCurseur2D(lat, lon, label);
  c3d.exploCurseur(lat, lon, label);
}

// Points de passage imposés choisis à la planification (liste de {lat, lon}),
// numérotés dans l'ordre. Uniquement en 2D : c'est l'écran de planification.
export function afficherPointsPassage(liste) {
  couchePointsPassage?.clearLayers();
  (liste || []).forEach((p, i) => {
    L.marker([p.lat, p.lon], { icon: pastille(26, "#7c4dff", String(i + 1)), zIndexOffset: 6800 }).addTo(couchePointsPassage);
  });
}

// Parkings : liste [{ parking, html }].
// Position à l'écran (px) du centre de la partie visible de la carte : là où
// placer une croix de visée qui correspond à centreVisible().
export function pixelCentreVisible() {
  const el = document.getElementById(explo3D ? "gps-carte-3d" : "gps-carte");
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.max(1, (r.height - decalageBas) / 2) };
}

// Trafic en couleur sur toutes les routes (tuiles « flow » de TomTom), en 2D
// comme en 3D, carte des bornes et navigation.
let coucheTrafic = null;

export function afficherTrafic(actif) {
  const cle = getApiKeys().tomtom;
  if (actif && cle && !coucheTrafic) {
    coucheTrafic = L.tileLayer(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(cle)}&tileSize=256`, { opacity: 0.75, zIndex: 10, maxZoom: 22, maxNativeZoom: 20 });
  }
  if (coucheTrafic) {
    if (actif && !carte.hasLayer(coucheTrafic)) coucheTrafic.addTo(carte);
    else if (!actif && carte.hasLayer(coucheTrafic)) carte.removeLayer(coucheTrafic);
  }
  c3d.afficherTrafic(actif, cle);
}

// 🚗 Voiture garée sur la carte des bornes (pos : { lat, lon } ou null).
let marqueurGaree = null;

// Appui long sur la carte (navigation) : cb(lat, lon), ou null.
let appuiLongCb = null;
let appuiLongBranche = false;

export function definirAppuiLong(cb) {
  appuiLongCb = cb;
  if (appuiLongBranche) return;
  appuiLongBranche = true;
  // Appui long au doigt = « contextmenu » pour le navigateur (et clic droit).
  for (const id of ["gps-carte", "gps-carte-3d"]) {
    document.getElementById(id)?.addEventListener("contextmenu", (e) => {
      if (!appuiLongCb) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const [x, y] = [e.clientX - r.left, e.clientY - r.top];
      const p = id === "gps-carte" ? carte.containerPointToLatLng([x, y]) : c3d.pointVersLatLon(x, y);
      if (p) appuiLongCb(p.lat, p.lng ?? p.lon);
    });
  }
}
