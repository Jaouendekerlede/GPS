// Interface "carte d'abord" : carte plein écran avec les bornes autour,
// panneau coulissant (liste, fiche borne, trajet, résultat, favoris,
// outils, profil) et barre de navigation. Les calculs viennent du moteur
// local (trajet.js), portage du panneau GPS de JARVIS.

import { MULTIPLICATEURS_SAISON, getApiKeys, setApiKeys, MODES_TRAJET } from "./config.js";
import { obtenirProfilVehicule, definirProfilVehicule, listerHistoriqueTrajets, supprimerTrajetHistorique, effacerHistoriqueTrajets, listerTrajetsFavoris, ajouterTrajetFavori, retirerTrajetFavori, listerBornesFavorites, estBorneFavorite, basculerFavoriBorne, obtenirNoteBorne, definirNoteBorne, lirePrefs, sauverPrefs, lireReglages, sauverReglages, consoMesuree, appliquerAbonnements, noterTrajetPrevu, trajetPrevu, consoParType, listerTraces, borneEnPanneJusqua, basculerBorneEnPanne, JOURS_BORNE_EN_PANNE, supprimerTrace, destinationHabituelle, facteurChargeAppris, remiseAZero } from "./storage.js";
import { planifierTrajet, planifierAlternative, planifierAllerRetour } from "./trajet.js";
import { diagnostiquerCleTomTom } from "./tomtom.js";

import { exporterTrajetTexte, formaterMinutes } from "./planner.js";
import { carteLeaflet, initCarte, afficherAutonomie, fondSuivant, choisirFond, rechargerFond, activerCarte3D, carte3DActive, fondCourant, derniereErreur3D, definirDecalageBas, centreVisible, rayonVisibleKm, zoomActuel, centrer, classePuissance, puissanceBorne, afficherBornes, rafraichirBorne, selectionnerBorne, montrerBornes, afficherPosition, afficherTrajet, afficherAlternatives, effacerTrajet, placerCurseur, definirAppuiLong, afficherPointsPassage } from "./carte.js";
import { resoudreLieu, haversineKm } from "./geo.js";
import { escapeHtml, lienGoogleMaps, lienWaze, estNuit } from "./util.js";
import { $, toast, bandeau, euros, nombre, nomCourt, nombreOuUndefined, hint, alerte, tuile, telechargerTexte, badgeOperateur } from "./ui-commun.js";
import { exporterSauvegarde, importerSauvegarde, envoyerLienRestauration, majInfoLien } from "./ui-sauvegarde.js";
import { installerAppli, majBoutonInstallation } from "./ui-installation.js";
import { cablerZonesEvitees } from "./ui-zones.js";
import { classeNumero } from "./panneau-nav.js";
import { cablerSuggestions } from "./ui-suggestions.js";
import { lignesEtat } from "./etat-appli.js";
import { niveauPrecision } from "./recalage.js";
import { boutonQuandPartir, quandPartir } from "./ui-quand-partir.js";
import { boutonPartage, partagerTrajet } from "./ui-partage.js";
import { cablerDrive } from "./ui-drive.js";
import { demarrerRadarsCarte } from "./radars-carte.js";
import { cablerPresDeMoi } from "./pres-de-moi.js";
import { meteoDesPoints, alerteMeteo } from "./meteo-route.js";
import { icone, iconeFond } from "./icones.js";
import { appelsTomTomDuJour, QUOTA_TOMTOM_JOUR } from "./tomtom.js";
import { ouvrirSOS, cablerSOS } from "./ui-sos.js";
import { reconnaissanceDispo, ecouter, interpreterCommande } from "./commandes-vocales.js";
import { cablerParkings, planifierParkings, cablerTrafic } from "./ui-parkings.js";
import { demarrerNavigation, etatDiagnostic, navigationActive, retourNavigationEnCours, traceRestante, navigationInterrompue, oublierNavigationInterrompue } from "./navigation.js";
import { ageTexte } from "./reprise.js";
import { cablerDiagnostic } from "./ui-diagnostic.js";
import { estimerPreparation, preparerHorsLigne, guidagePrepare, bilanPreparation, RAYONS_REGION_KM, estimerRegion, preparerRegion, regionPreparee } from "./hors-ligne.js";

const VUES = ["accueil", "trajet", "resultat", "menu", "favoris", "outils", "profil"];
const ETAT_FEUILLE_PAR_VUE = { bornes: "bas", borne: "mi", trajet: "haut", resultat: "mi", menu: "haut", favoris: "haut", outils: "haut", profil: "haut" };
const ONGLET_PAR_VUE = { bornes: "accueil", trajet: "trajet", resultat: "trajet", menu: "menu", favoris: "menu", outils: "menu", profil: "menu" };
const LABELS_MODE = { rapide: "⚡ Rapide", economique: "💶 Économique", confort: "🛋️ Confort", prudent: "🛡️ Prudent" };
const BOUTONS_CALCUL = ["gps-trajet-run-btn", "gps-aller-retour-btn"];
const HAUTEUR_REPLIEE = 172;

let vueCourante = "accueil";
let vueAvantBorne = "accueil";
let etatFeuille = "bas";
let modeTrajet = "confort";
// Suit si marge/objectif ont été touchés à la main APRÈS le choix d'un mode :
// sans ça, recliquer sur un mode écraserait ces réglages sans prévenir.
let slidersModifiesManuellement = false;
let dernierTrajet = null;
let trajetAffiche = false;
let dernierChargeDepartPct = 80;
let dernierScenarios = null;
// Routes proposées pour le dernier trajet : plans[0] = la plus rapide,
// les suivantes = alternatives TomTom dont le plan de recharge est calculé
// en arrière-plan (null en attendant). routes[i] (tracé, distance, durée)
// permet de les montrer avant la fin de ce calcul.
let itineraires = { jeton: 0, plans: [], routes: [] };
let dernieresOptions = null;
// Points de passage imposés choisis à la planification (appui long sur la
// carte) : { lat, lon }. Effacés uniquement à la main (croix sur le chip).
let pointsPassage = [];
let pointChoisiPlanif = null;
let borneOuverte = null;
let calculEnCours = false;
let bornesZone = [];
let derniereZone = null;
let rechercheManuelle = null;
let zoneIncomplete = false;
let jetonZone = 0;
let minuteurDeplacement = null;
const filtres = new Set();
const listesAffichees = new Map();

// ── Petits utilitaires ─────────────────────────────────────────────────────


// Sous les curseurs de batterie : ce que ça fait en km réels (consommation
// apprise en roulant, sinon fiche constructeur corrigée de la saison), et
// sur autoroute à 130 km/h (modèle physique).

function heure(ms) {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}



function ecranLarge() {
  return window.matchMedia("(min-width: 900px)").matches;
}

// ── Panneau coulissant ─────────────────────────────────────────────────────

function positionsFeuille() {
  const h = $("gps-feuille").offsetHeight;
  return { haut: 0, mi: Math.max(0, h - Math.round(window.innerHeight * 0.5)), bas: Math.max(0, h - HAUTEUR_REPLIEE) };
}

function appliquerPosition(y, anime) {
  const feuille = $("gps-feuille");
  const nav = document.querySelector(".gps-nav").offsetHeight;
  if (ecranLarge()) {
    feuille.style.transform = "";
    $("gps-feuille-corps").style.paddingBottom = "";
    document.documentElement.style.setProperty("--feuille-visible", "0px");
    definirDecalageBas(0);
    return;
  }
  feuille.style.transition = anime ? "" : "none";
  feuille.style.transform = `translateY(${y}px)`;
  $("gps-feuille-corps").style.paddingBottom = `${y + 24}px`;
  const visible = feuille.offsetHeight - y + nav;
  document.documentElement.style.setProperty("--feuille-visible", `${visible}px`);
  definirDecalageBas(visible);
}

function definirFeuille(etat) {
  etatFeuille = etat;
  document.body.dataset.feuille = etat;
  appliquerPosition(positionsFeuille()[etat], true);
}

function cablerFeuille() {
  const poignee = $("gps-poignee");
  const zones = [poignee, ...document.querySelectorAll(".gps-vue-entete")];
  let debutY = null;
  let debutPos = 0;
  let pos = 0;
  let t0 = 0;
  let deplace = false;
  let zoneActive = null;

  const debut = (e) => {
    if (ecranLarge()) return;
    debutY = e.clientY;
    debutPos = positionsFeuille()[etatFeuille];
    pos = debutPos;
    t0 = Date.now();
    deplace = false;
    zoneActive = e.currentTarget;
  };
  const bouger = (e) => {
    if (debutY === null) return;
    const dy = e.clientY - debutY;
    if (!deplace && Math.abs(dy) > 8) {
      deplace = true;
      try {
        zoneActive.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (!deplace) return;
    pos = Math.max(0, Math.min(positionsFeuille().bas, debutPos + dy));
    appliquerPosition(pos, false);
  };
  const fin = (e) => {
    if (debutY === null) return;
    const dy = e.clientY - debutY;
    const vitesse = dy / Math.max(1, Date.now() - t0);
    debutY = null;
    if (!deplace) {
      if (zoneActive === poignee) definirFeuille(etatFeuille === "bas" ? "mi" : etatFeuille === "mi" ? "haut" : "mi");
      return;
    }
    const p = positionsFeuille();
    let cible;
    if (vitesse < -0.5) cible = pos <= p.mi ? "haut" : "mi";
    else if (vitesse > 0.5) cible = pos >= p.mi ? "bas" : "mi";
    else cible = ["haut", "mi", "bas"].reduce((a, b) => (Math.abs(p[b] - pos) < Math.abs(p[a] - pos) ? b : a));
    definirFeuille(cible);
  };
  for (const z of zones) {
    z.addEventListener("pointerdown", debut);
    z.addEventListener("pointermove", bouger);
    z.addEventListener("pointerup", fin);
    z.addEventListener("pointercancel", fin);
  }
  window.addEventListener("resize", () => definirFeuille(etatFeuille));
}

// ── Navigation entre les vues ──────────────────────────────────────────────

// ── Menu : une rubrique à la fois ──────────────────────────────────────────
// Favoris, Outils et Profil s'ouvrent depuis le Menu, rubrique par rubrique :
// seul le bloc choisi reste affiché, avec un retour au Menu. Ouvertes sans
// rubrique, ces vues s'affichent en entier.
const VUES_A_RUBRIQUES = ["favoris", "outils", "profil"];
const titresVues = {};
let rubriqueOuverte = false;

function appliquerRubrique(vue, rubrique) {
  rubriqueOuverte = !!rubrique;
  if (!VUES_A_RUBRIQUES.includes(vue)) return;
  const racine = $(`vue-${vue}`);
  const entete = racine.querySelector(".gps-vue-entete");
  const titre = entete.querySelector("h2");
  titresVues[vue] ??= titre.textContent;
  let retour = entete.querySelector(".gps-retour-menu");
  if (!retour) {
    retour = document.createElement("button");
    retour.type = "button";
    retour.className = "gps-lien gps-retour-menu";
    retour.textContent = "‹ Menu";
    retour.addEventListener("click", () => (history.state?.rubrique ? history.back() : afficherVue("menu")));
    entete.prepend(retour);
  }
  retour.classList.toggle("hidden", !rubrique);
  titre.textContent = rubrique?.titre || titresVues[vue];
  const bloc = rubrique?.bloc ? $(rubrique.bloc) : null;
  let apresBloc = false;
  for (const el of racine.children) {
    let visible = !bloc || el === entete || el === bloc;
    // « Enregistrer » ne concerne que les réglages placés avant lui.
    // Présentation, mentions légales et version suivent l'aide.
    if (bloc?.id === "gps-bloc-aide" && apresBloc) visible = true;
    if (el === bloc) apresBloc = true;
    el.classList.toggle("gps-hors-rubrique", !visible);
  }
}

function ouvrirRubrique(vue, bloc, titre) {
  afficherVue(vue, { historique: false, rubrique: { bloc, titre } });
  if (vue === "favoris") renderFavoris();
  history.pushState({ vue, rubrique: true }, "");
}

// Rubrique désignée par son bloc (titre repris de la ligne du Menu).
function ouvrirBloc(bloc) {
  if (bloc === "gps-bloc-etat") rendreEtatAppli();
  const l = document.querySelector(`.gps-menu-ligne[data-bloc="${bloc}"]`);
  ouvrirRubrique(l.dataset.vue, bloc, `${l.querySelector(".gps-menu-icone").textContent} ${l.querySelector(".gps-menu-nom").textContent}`);
}

function afficherVue(vue, { etat, historique = true, rubrique = null } = {}) {
  if (vue === "fiche" && vueCourante !== "fiche") vueAvantBorne = vueCourante;
  appliquerRubrique(vue, rubrique);
  for (const v of VUES) $(`vue-${v}`).classList.toggle("hidden", v !== vue);
  vueCourante = vue;
  if (vue === "accueil") rendreRaccourcis();
  if (vue === "trajet") {
    majSuggestionTrajet();
  }
  // Appui long sur la carte pour imposer un point de passage : seulement
  // pendant la planification/le résultat (pas pendant la navigation, qui
  // installe son propre callback en entrant/sortant du guidage).
  if ((vue === "trajet" || vue === "resultat") && !navigationActive()) definirAppuiLong(surAppuiLongPlanif);
  else if (!navigationActive()) definirAppuiLong(null);
  if (vue === "outils") {
  }
  // Mesures et abonnements ont pu changer depuis (navigation, autre écran).
  if (vue === "profil") {
  }
  const onglet = ONGLET_PAR_VUE[vue];
  if (onglet) document.querySelectorAll(".gps-nav-btn").forEach((b) => b.classList.toggle("actif", b.dataset.vue === onglet));
  $("gps-feuille-corps").scrollTop = 0;
  definirFeuille(etat || ETAT_FEUILLE_PAR_VUE[vue]);
  const contexteTrajet = vue === "resultat" || (vue === "fiche" && vueAvantBorne === "resultat");
  montrerBornes(!contexteTrajet);

  // Le bouton "retour" d'Android revient en arrière dans l'appli au lieu de la quitter.
  if (historique && vue !== "accueil") {
    if (vue === "fiche" || !history.state?.vue) history.pushState({ vue }, "");
    else history.replaceState({ vue }, "");
  }
}

function revenirDeBorne() {
  selectionnerBorne(null);
  borneOuverte = null;
  afficherVue(vueAvantBorne === "fiche" ? "accueil" : vueAvantBorne, { historique: false });
}

function cablerNavigation() {
  document.querySelectorAll(".gps-nav-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const cible = btn.dataset.vue;
      if (cible === "trajet" && trajetAffiche && vueCourante !== "resultat") afficherVue("resultat");
      else if (cible === "accueil") afficherVue("accueil", { etat: vueCourante === "accueil" ? (etatFeuille === "bas" ? "mi" : "bas") : "bas", historique: false });
      else afficherVue(cible);
      if (cible === "favoris") renderFavoris();
    }),
  );
  window.addEventListener("popstate", () => {
    if (navigationActive() || retourNavigationEnCours()) return;
    if (vueCourante === "fiche") revenirDeBorne();
    // Retour depuis une rubrique : on revient au Menu.
    else if (rubriqueOuverte) afficherVue("menu", { historique: history.state?.vue !== "menu" });
    else if (vueCourante !== "accueil") afficherVue("accueil", { historique: false });
  });
  $("vue-menu").addEventListener("click", (e) => {
    const l = e.target.closest(".gps-menu-ligne");
    if (!l) return;
    if (l.dataset.bloc) ouvrirBloc(l.dataset.bloc);
    else ouvrirRubrique(l.dataset.vue, null, `${l.querySelector(".gps-menu-icone").textContent} ${l.querySelector(".gps-menu-nom").textContent}`);
  });
}

// ── Paiement : état "carte bancaire" toujours sourcé ───────────────────────

const OUI_NON = { oui: "✅ oui", partiel: "⚠️ sur une partie des points", non: "❌ non" };






// État déclaré par l'opérateur : hors service (avec la date du signalement)
// ou, si l'information a moins d'une heure, points libres.


// ── Liste de bornes ────────────────────────────────────────────────────────




// ── Bornes autour de la carte ──────────────────────────────────────────────






function surDeplacementCarte() {
  // Parkings : aussi sur l'écran du trajet (se garer à l'arrivée).
  planifierParkings();
  const contexteTrajet = vueCourante === "resultat" || (vueCourante === "fiche" && vueAvantBorne === "resultat");
  if (rechercheManuelle || contexteTrajet || navigationActive()) return;
  clearTimeout(minuteurDeplacement);
}

// ── Thème clair / sombre ───────────────────────────────────────────────────

function themeResolu(choix) {
  if (choix === "auto") return window.matchMedia("(prefers-color-scheme: light)").matches ? "clair" : "sombre";
  return choix === "clair" ? "clair" : "sombre";
}

function fondParDefaut() {
  return document.documentElement.dataset.theme === "clair" ? "plan" : "sombre";
}

function appliquerTheme() {
  const reglages = lireReglages();
  const choix = reglages.theme || "sombre";
  const theme = themeResolu(choix);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.contraste = reglages.contraste_fort ? "fort" : "normal";
  $("gps-reglage-contraste").checked = !!reglages.contraste_fort;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "clair" ? "#ffffff" : "#05080e");
  document.querySelectorAll("[data-theme-choix]").forEach((b) => b.classList.toggle("active", b.dataset.themeChoix === choix));
  // Tant que l'utilisateur n'a pas choisi de fond de carte, il suit le thème.
  if (!reglages.fond_carte) $("gps-fond-btn").innerHTML = iconeFond(choisirFond(fondParDefaut()));
}

function cablerTheme() {
  $("gps-reglage-contraste").addEventListener("change", (e) => {
    // Appliqué tout de suite : inutile de faire apparaître « Enregistrer ».
    e.stopPropagation();
    sauverReglages({ contraste_fort: e.target.checked });
    appliquerTheme();
  });
  document.querySelectorAll("[data-theme-choix]").forEach((b) =>
    b.addEventListener("click", () => {
      sauverReglages({ theme: b.dataset.themeChoix });
      appliquerTheme();
    }),
  );
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (lireReglages().theme === "auto") appliquerTheme();
  });
}

// Carte nuit au coucher du soleil, jour au lever (à l'endroit regardé).
// Seulement au moment du basculement : un choix manuel du fond reste
// respecté jusqu'au prochain lever ou coucher. Le satellite n'est pas touché,
// ni OpenStreetMap de jour (c'est un fond clair, comme le plan).
let etaitNuit = null;
function appliquerJourNuit(auDemarrage = false) {
  if (lireReglages().jour_nuit_auto === false) return;
  const c = centreVisible();
  const nuit = estNuit(c.lat, c.lon);
  if (!auDemarrage && nuit === etaitNuit) return;
  etaitNuit = nuit;
  const actuel = fondCourant();
  const voulu = nuit ? "sombre" : "plan";
  if (actuel === "satellite" || actuel === voulu || (actuel === "osm" && !nuit)) return;
  $("gps-fond-btn").innerHTML = iconeFond(choisirFond(voulu));
  if (!auDemarrage) toast(nuit ? "🌙 Coucher du soleil : carte de nuit" : "☀️ Lever du soleil : carte de jour");
}

function majBoutonCarte3D() {
  const actif = carte3DActive();
  $("gps-carte3d-btn").classList.toggle("actif", actif);
  $("gps-carte3d-btn").textContent = actif ? "2D" : "3D";
  $("gps-carte3d-btn").title = actif ? "Revenir à la carte à plat (2D)" : "Voir la carte en 3D (inclinée, bâtiments en relief)";
}

// parUtilisateur : choix mémorisé et message ; sinon (démarrage), silencieux.
async function basculerCarte3D(actif, parUtilisateur) {
  const bouton = $("gps-carte3d-btn");
  if (bouton.disabled) return;
  bouton.disabled = true;
  if (actif) bouton.textContent = "…";
  try {
    const ok = await activerCarte3D(actif);
    if (parUtilisateur) {
      if (ok) sauverReglages({ carte_explo_3d: actif });
      toast(ok ? (actif ? "🏙️ Carte en 3D : deux doigts pour tourner ou incliner" : "🗺️ Carte à plat") : `⚠️ 3D indisponible : ${derniereErreur3D() || "raison inconnue"}`);
    }
  } finally {
    bouton.disabled = false;
    majBoutonCarte3D();
  }
}

function cablerCarte() {
  const reglages = lireReglages();
  const fond = choisirFond(reglages.fond_carte || fondParDefaut());
  $("gps-fond-btn").innerHTML = iconeFond(fond);
  $("gps-fond-btn").addEventListener("click", () => {
    const nom = fondSuivant();
    $("gps-fond-btn").innerHTML = iconeFond(nom);
    sauverReglages({ fond_carte: nom });
    toast({ sombre: "🌙 Carte sombre", plan: "🗺️ Plan clair", osm: "🌍 OpenStreetMap (gratuit)", satellite: "🛰️ Vue satellite" }[nom]);
  });

  appliquerJourNuit(true);
  setInterval(appliquerJourNuit, 60000);

  $("gps-carte3d-btn").addEventListener("click", () => basculerCarte3D(!carte3DActive(), true));
  document.addEventListener("carte3d-panne", (e) => {
    majBoutonCarte3D();
    toast(`⚠️ Carte 3D interrompue (${e.detail}) : retour en 2D`);
  });
  if (reglages.carte_explo_3d) basculerCarte3D(true, false);

  for (const f of reglages.filtres_carte || []) filtres.add(f);
  cablerParkings();
  cablerTrafic();
  cablerSOS();
  cablerDiagnostic();
  // Liste d'essais sur la route : cases mémorisées sur ce téléphone.
  const essais = (() => {
    try {
      return JSON.parse(localStorage.getItem("tve_essais")) || {};
    } catch {
      return {};
    }
  })();
  for (const c of document.querySelectorAll("[data-essai]")) {
    c.checked = !!essais[c.dataset.essai];
    c.addEventListener("change", () => {
      essais[c.dataset.essai] = c.checked;
      localStorage.setItem("tve_essais", JSON.stringify(essais));
    });
  }
  $("gps-reglages-conseilles-btn").addEventListener("click", () => {
    if (!confirm("Revenir aux réglages de navigation conseillés ?")) return;
    const cles = ["taille_texte_nav", "taille_bandeau", "icone_voiture", "ecran_epure", "nuit_douce", "zoom_renforce", "vue_carrefour", "fenetre_voies", "voix_guidage", "reponses_voix", "voix_voies", "vibration", "notif_guidage", "voix_travaux", "zones_danger", "bip_vitesse", "meteo_route", "feux", "voix_bornes", "prechauffage", "aires_autoroute", "parking_arrivee", "pause_mi_parcours"];
    sauverReglages(Object.fromEntries(cles.map((c) => [c, undefined])));
    rendreReglagesProfil();
    toast("↺ Réglages conseillés rétablis");
  });
  for (const b of document.querySelectorAll("[data-icone]")) b.innerHTML = icone(b.dataset.icone);
  cablerDrive();
  // Raccourcis de destination (Chez moi, Travail, trajet habituel).
  document.querySelector(".gps-raccourcis-dest").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dest]");
    if (!b) return;
    $("gps-destination-input").value = b.dataset.dest;
    $("gps-destination-input").dispatchEvent(new Event("change"));
    lancerTrajet();
  });
  $("gps-reglage-taille-texte").addEventListener("input", (e) => ($("gps-reglage-taille-texte-val").textContent = e.target.value));
  $("gps-reglage-inclinaison").addEventListener("input", (e) => ($("gps-reglage-inclinaison-val").textContent = e.target.value));
  $("gps-reglage-inclinaison-plate").addEventListener("input", (e) => ($("gps-reglage-inclinaison-plate-val").textContent = e.target.value));
  $("gps-reglage-decalage-zoom").addEventListener("input", (e) => ($("gps-reglage-decalage-zoom-val").textContent = e.target.value));
  // Autorisation des notifications demandée au moment où l'on coche.
  $("gps-reglage-notif").addEventListener("change", (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  });
  cablerSuggestions(["gps-depart-input", "gps-via-input", "gps-destination-input"]);
  // 🎤 Dicter la destination : « Nantes », « aller à la gare de Rennes »…
  $("gps-destination-micro").addEventListener("click", async () => {
    if (!reconnaissanceDispo()) return toast("🎤 Dictée indisponible sur ce navigateur");
    toast("🎤 Dites votre destination…");
    const texte = await ecouter();
    if (!texte) return toast("🎤 Je n'ai pas compris");
    const c = interpreterCommande(texte);
    $("gps-destination-input").value = c.action === "aller" ? c.lieu : texte;
    lancerTrajet();
  });

  document.querySelectorAll(".gps-chip[data-filtre]").forEach((chip) => {
    chip.classList.toggle("actif", filtres.has(chip.dataset.filtre));
    chip.addEventListener("click", () => {
      const f = chip.dataset.filtre;
      if (filtres.has(f)) filtres.delete(f);
      else filtres.add(f);
      chip.classList.toggle("actif", filtres.has(f));
      sauverReglages({ filtres_carte: [...filtres] });
      if (vueCourante !== "accueil" && vueCourante !== "resultat") afficherVue("accueil", { etat: "mi", historique: false });
    });
  });

  $("gps-localiser-btn").addEventListener("click", localiser);
}

async function localiser() {
  toast("📍 Recherche de ta position…");
  const pos = await resoudreLieu("ma position");
  if (pos.erreur) {
    toast(pos.erreur);
    return false;
  }
  afficherPosition(pos.lat, pos.lon, pos.precision);
  centrer(pos.lat, pos.lon, Math.max(zoomActuel(), 13.5));
  toast(Number.isFinite(pos.precision) ? `📍 Position trouvée (précision ±${Math.round(pos.precision)} m).` : "📍 Position trouvée.");
  return true;
}

async function positionDeDepart() {
  const pos = await resoudreLieu("ma position");
  if (!pos.erreur) {
    afficherPosition(pos.lat, pos.lon, pos.precision);
    centrer(pos.lat, pos.lon, 13.5);
    return;
  }
  const domicile = lireReglages().adresse_domicile;
  if (domicile) {
    const lieu = await resoudreLieu("chez moi", domicile);
    if (!lieu.erreur) {
      centrer(lieu.lat, lieu.lon, 13);
      return;
    }
  }
}

// ── Fiche borne ────────────────────────────────────────────────────────────

// ── Partage ────────────────────────────────────────────────────────────────

async function partagerTexte(titre, texte) {
  if (navigator.share) {
    try {
      await navigator.share({ title: titre, text: texte });
    } catch (e) {
      if (e.name !== "AbortError") toast("Partage impossible sur cet appareil.");
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(texte);
    toast("📋 Copié dans le presse-papiers");
  } catch {
    location.href = `mailto:?subject=${encodeURIComponent(titre)}&body=${encodeURIComponent(texte)}`;
  }
}

// ── Formulaire de trajet ───────────────────────────────────────────────────

const CASES = {
  plus_court: "gps-plus-court-checkbox",
  eviter_autoroutes: "gps-eviter-autoroutes-checkbox",
  eviter_peages: "gps-eviter-peages-checkbox",
  eviter_ferries: "gps-eviter-ferries-checkbox",
  eviter_zones_faibles_emissions: "gps-eviter-zfe-checkbox",
  eviter_routes_non_revetues: "gps-eviter-non-revetues-checkbox",
};




function cablerFormulaire() {
  $("gps-depart-gps-btn").addEventListener("click", () => ($("gps-depart-input").value = "Ma position"));
  $("gps-depart-clear-btn").addEventListener("click", () => {
    $("gps-depart-input").value = "";
    $("gps-depart-input").focus();
  });
  $("gps-destination-clear-btn").addEventListener("click", () => {
    $("gps-destination-input").value = "";
    $("gps-destination-input").focus();
  });
  $("gps-inverser-btn").addEventListener("click", () => {
    const d = $("gps-depart-input").value;
    $("gps-depart-input").value = $("gps-destination-input").value;
    $("gps-destination-input").value = d;
    // Les étapes « via » se parcourent alors dans l'autre sens.
    if (pointsPassage.length > 1) {
      pointsPassage.reverse();
      rendrePointsPassage();
    }
  });
  $("gps-destination-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
      lancerTrajet();
    }
  });
  $("gps-trajet-run-btn").addEventListener("click", lancerTrajet);
  $("gps-aller-retour-btn").addEventListener("click", lancerAllerRetour);
  $("gps-voir-resultat-btn").addEventListener("click", () => {
    if (dernierTrajet) afficherResultat(dernierTrajet);
  });
  $("gps-favori-trajet-btn").addEventListener("click", () => {
    const destination = $("gps-destination-input").value.trim();
    if (!destination) {
      toast("Indique d'abord une destination.");
      return;
    }
    ajouterTrajetFavori($("gps-depart-input").value.trim() || "Ma position", destination, pointsPassage);
    toast("⭐ Trajet ajouté aux favoris");
  });
}

function chargerPrefs() {
  const p = lirePrefs();
  if (p) {
    if (p.depart) $("gps-depart-input").value = p.depart;
    if (p.destination) $("gps-destination-input").value = p.destination;
    for (const [cle, id] of Object.entries(CASES)) if (p[cle] !== undefined) $(id).checked = !!p[cle];
  }
}

// ── Points de passage imposés (appui long sur la carte en planification) ────

function surAppuiLongPlanif(lat, lon) {
  pointChoisiPlanif = { lat, lon };
  $("gps-plan-point").classList.remove("hidden");
}

function ajouterPointPassage() {
  const p = pointChoisiPlanif;
  $("gps-plan-point").classList.add("hidden");
  if (!p) return;
  pointsPassage.push(p);
  rendrePointsPassage();
  if (trajetAffiche) {
    toast("➕ Point ajouté : nouveau calcul…");
    lancerTrajet();
  }
}

function retirerPointPassage(i) {
  pointsPassage.splice(i, 1);
  rendrePointsPassage();
  if (trajetAffiche) lancerTrajet();
}

function rendrePointsPassage() {
  afficherPointsPassage(pointsPassage);
  const conteneur = $("gps-points-passage-liste");
  conteneur.classList.toggle("hidden", pointsPassage.length === 0);
  conteneur.innerHTML = pointsPassage
    .map(
      (p, i) =>
        `${i > 0 ? `<button type="button" class="gps-chip gps-chip-mini" data-monter-etape="${i}" title="Passer cette étape avant la précédente" aria-label="Passer cette étape avant la précédente">⬆</button>` : ""}` +
        `<button type="button" class="gps-chip" data-retirer-etape="${i}">📍 ${p.nom ? `Via ${escapeHtml(p.nom)}` : `Étape ${i + 1}`} ✕</button>`,
    )
    .join("");
}

// Étape écrite dans « Via » (« Bréhan via Auray ») : trouvée par son adresse
// puis ajoutée aux mêmes points de passage que l'appui long. Un seul ajout à
// la fois : quitter le champ, « ➕ » et « Calculer » peuvent le demander
// ensemble. relancer = false quand l'appelant lance lui-même le calcul.
let ajoutVia = null;
function ajouterVia(relancer = true) {
  ajoutVia ??= (async () => {
    const champ = $("gps-via-input");
    const texte = champ.value.trim();
    if (!texte) return;
    champ.value = "";
    // Referme la liste de suggestions encore en attente pour ce texte.
    champ.dispatchEvent(new Event("input", { bubbles: true }));
    const r = lireReglages();
    const lieu = await resoudreLieu(texte, r.adresse_domicile, r.adresse_travail);
    if (lieu.erreur) {
      champ.value = texte;
      toast(`⚠️ Étape introuvable : « ${texte} ». Vérifie l'orthographe ou choisis une suggestion.`);
      return;
    }
    pointsPassage.push({ lat: lieu.lat, lon: lieu.lon, nom: nomCourt(lieu.nom || texte).split(",")[0] });
    rendrePointsPassage();
    if (relancer && trajetAffiche) {
      toast("➕ Étape ajoutée : nouveau calcul…");
      lancerTrajet();
    }
  })().finally(() => (ajoutVia = null));
  return ajoutVia;
}

function cablerPointsPassage() {
  $("gps-plan-point").addEventListener("click", (e) => {
    const a = e.target.closest("[data-point]")?.dataset.point;
    if (a === "etape") ajouterPointPassage();
    else if (a === "fermer") $("gps-plan-point").classList.add("hidden");
  });
  $("gps-points-passage-liste").addEventListener("click", (e) => {
    const m = Number(e.target.closest("[data-monter-etape]")?.dataset.monterEtape);
    if (m > 0) {
      [pointsPassage[m - 1], pointsPassage[m]] = [pointsPassage[m], pointsPassage[m - 1]];
      rendrePointsPassage();
      if (trajetAffiche) lancerTrajet();
      return;
    }
    const i = e.target.closest("[data-retirer-etape]")?.dataset.retirerEtape;
    if (i !== undefined) retirerPointPassage(Number(i));
  });
  $("gps-via-ajouter-btn").addEventListener("click", () => ajouterVia());
  // « change » : suggestion choisie, ou champ quitté après la saisie.
  $("gps-via-input").addEventListener("change", () => ajouterVia());
  $("gps-via-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    ajouterVia();
  });
}

function construireOptions() {
  const options = {
    depart: $("gps-depart-input").value.trim() || "Ma position",
    destination: $("gps-destination-input").value.trim(),
    points_passage: pointsPassage.slice(),
  };
  for (const [cle, id] of Object.entries(CASES)) options[cle] = $(id).checked;
  dernieresOptions = options;
  return options;
}


function sauverPrefsDepuis(options) {
  sauverPrefs({ ...options });
}


// ── Calculs ────────────────────────────────────────────────────────────────

async function avecVerrou(boutonId, texteAttente, action) {
  if (calculEnCours) return;
  calculEnCours = true;
  const bouton = $(boutonId);
  const texteOrigine = bouton.textContent;
  bouton.textContent = texteAttente;
  BOUTONS_CALCUL.forEach((id) => ($(id).disabled = true));
  $("gps-trajet-erreur").classList.add("hidden");
  try {
    await action();
  } catch (e) {
    console.error(e);
    montrerErreurTrajet(`Erreur inattendue : ${e?.message || e}`);
  } finally {
    calculEnCours = false;
    bouton.textContent = texteOrigine;
    BOUTONS_CALCUL.forEach((id) => ($(id).disabled = false));
  }
}

function montrerErreurTrajet(message) {
  const zone = $("gps-trajet-erreur");
  zone.textContent = `⚠️ ${message}`;
  zone.classList.remove("hidden");
  if (vueCourante !== "trajet") afficherVue("trajet");
  zone.scrollIntoView({ behavior: "smooth", block: "center" });
}

function exigerDestination(options) {
  if (options.destination) return true;
  toast("Indique une destination.");
  $("gps-destination-input").focus();
  return false;
}

async function lancerTrajet() {
  await ajouterVia(false);
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou("gps-trajet-run-btn", "⏳ Calcul en cours…", async () => {
    sauverPrefsDepuis(options);
    oublierItineraires();
    const resultat = await planifierTrajet(options.depart, options.destination, { ...options, avec_alternatives: true });
    // Départ prévu plus tard : conseil de recharge la veille au soir.
    if (resultat.ok && options.depart_prevu) noterTrajetPrevu({ ts: new Date(options.depart_prevu).getTime(), destination: resultat.to_name, distance_km: resultat.distance_km, nb_arrets: resultat.nb_arrets });
    const bruts = resultat.itineraires_alternatifs || [];
    delete resultat.itineraires_alternatifs;
    if (!resultat.ok) return montrerErreurTrajet(resultat.erreur || "Calcul impossible.");
    itineraires.plans = [resultat, ...bruts.map(() => null)];
    itineraires.routes = [resultat, ...bruts];
    afficherResultat(resultat);
    annoncer(resultat);
    // Sans attendre : le résultat principal reste utilisable pendant ce temps.
    planifierItinerairesAlternatifs(bruts, options, itineraires.jeton);
  });
}

function oublierItineraires() {
  itineraires = { jeton: itineraires.jeton + 1, plans: [], routes: [] };
}

async function planifierItinerairesAlternatifs(bruts, options, jeton) {
  for (let i = 0; i < bruts.length; i++) {
    let plan;
    try {
      // En arrière-plan, on peut attendre que le quota Open-Meteo se libère
      // pour que chaque route ait relief et météo, comme la principale.
      plan = await planifierAlternative(bruts[i], { ...options, patience_open_meteo_ms: 70000 });
    } catch (e) {
      console.error(e);
      plan = { ok: false, erreur: `Erreur inattendue : ${e?.message || e}` };
    }
    if (jeton !== itineraires.jeton) return;
    itineraires.plans[i + 1] = plan;
    if (trajetAffiche && !navigationActive() && itineraires.plans.includes(dernierTrajet)) afficherItineraires(dernierTrajet);
  }
}

async function lancerAllerRetour() {
  await ajouterVia(false);
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou("gps-aller-retour-btn", "⏳ Aller + retour…", async () => {
    oublierItineraires();
    sauverPrefsDepuis(options);
    const { aller, retour } = await planifierAllerRetour(options.depart, options.destination, options);
    if (!aller.ok) return montrerErreurTrajet(aller.erreur || "Calcul impossible.");
    afficherResultat({ ...aller, retour });
    annoncer(aller);
  });
}


function annoncer(r) {
  if (!lireReglages().annonce_vocale || !("speechSynthesis" in window)) return;
  const phrase = `Trajet de ${nomCourt(r.from_name)} à ${nomCourt(r.to_name)} : ${Math.round(r.distance_km)} kilomètres, environ ${r.duree_text} de route.`;
  const voix = new SpeechSynthesisUtterance(phrase);
  voix.lang = "fr-FR";
  speechSynthesis.cancel();
  speechSynthesis.speak(voix);
}

// ── Résultat ───────────────────────────────────────────────────────────────

function etapesHtml(p) {
  const departMs = p.depart_ms || Date.now();
  const duree = p.duree_totale_min || p.duree_min || 0;
  return `
    <div class="gps-etape depart">
      <div class="gps-etape-rail"><div class="gps-etape-icone">🚗</div></div>
      <div class="gps-etape-corps"><div class="gps-etape-titre">Départ</div><div class="gps-etape-sous">${heure(departMs)}</div></div>
    </div>
    <div class="gps-etape-route">↓ ${nombre(Math.round(p.distance_km || 0))} km · ${formaterMinutes(duree)} de route</div>
    <div class="gps-etape arrivee">
      <div class="gps-etape-rail"><div class="gps-etape-icone">🏁</div></div>
      <div class="gps-etape-corps"><div class="gps-etape-titre">Arrivée</div><div class="gps-etape-sous">${heure(departMs + duree * 60000)}</div></div>
    </div>`;
}

function afficherResultat(p) {
  dernierTrajet = p;
  trajetAffiche = true;
  $("gps-voir-resultat-btn").classList.remove("hidden");

  $("gps-resultat-titre").textContent = `${nomCourt(p.from_name).split(",")[0]} → ${nomCourt(p.to_name).split(",")[0]}`;
  const tuiles = [
    tuile("cyan", `${nombre(p.distance_km)} km`, "Distance"),
    tuile("violet", p.duree_text, "Route"),
  ].join("");
  const peage = p.km_peage
    ? `<div class="gps-meteo-info">🛣️ Péages : environ <strong>${euros(coutPeage(p.km_peage))}</strong> (estimation sur ${nombre(p.km_peage)} km)</div>`
    : "";
  $("gps-trajet-summary").innerHTML = `<div class="gps-tuiles">${tuiles}</div>${peage}`;

  $("gps-etapes").innerHTML = etapesHtml(p) + echangeursHtml(p) + boutonQuandPartir() + boutonPartage();

  $("gps-maps-link").href = lienGoogleMaps(p.to_lat, p.to_lon);
  $("gps-qrcode-box").classList.add("hidden");
  $("gps-qrcode-box").innerHTML = "";

  chargerMeteoTrajet(p);
  afficherVue("resultat");
  afficherTrajet(p);
  afficherItineraires(p);
}

// ── Itinéraires alternatifs ────────────────────────────────────────────────

// Indice du meilleur plan selon `cle`, ou null si tous se valent (un badge
// « le moins cher » n'a pas de sens quand tout coûte 0 €).
function meilleurPlan(plans, cle) {
  const valides = plans.map((p, i) => ({ v: p?.ok ? p[cle] : null, i })).filter((x) => Number.isFinite(x.v));
  if (valides.length < 2) return null;
  const min = Math.min(...valides.map((x) => x.v));
  const max = Math.max(...valides.map((x) => x.v));
  return min < max ? valides.find((x) => x.v === min).i : null;
}

function badgesItineraires(plans) {
  const badges = plans.map(() => []);
  const ajouter = (i, texte) => i !== null && badges[i].push(texte);
  ajouter(meilleurPlan(plans, "duree_totale_min"), "⚡ Le plus rapide");
  ajouter(meilleurPlan(plans, "cout_total_eur"), "💶 Le moins cher");
  ajouter(meilleurPlan(plans, "distance_km"), "📏 Le plus court");
  if (plans.some((p) => p?.ok && p.km_peage > 0)) plans.forEach((p, i) => p?.ok && p.km_peage === 0 && badges[i].push("🚫 Sans péage"));
  return badges;
}

// Prix des péages : moyenne des autoroutes françaises pour une voiture
// (les tarifs réels vont d'environ 7 à 13 centimes du km selon le tronçon).
const TARIF_PEAGE_EUR_KM = 0.1;
function coutPeage(km) {
  return km * TARIF_PEAGE_EUR_KM;
}

function ecartMinutes(min) {
  if (Math.abs(min) < 1) return "même durée";
  return `${min > 0 ? "+" : "−"}${formaterMinutes(Math.abs(min))}`;
}

function carteItineraire(i, plan, route, badges, affiche) {
  const choisi = plan === affiche;
  const titre = `<div class="gps-itin-tete"><strong>Itinéraire ${i + 1}</strong>${choisi ? `<span class="gps-itin-coche">✓ affiché</span>` : ""}</div>`;
  const pastilles = badges.length ? `<div class="gps-itin-badges">${badges.map((b) => `<span class="gps-cb-pill ok">${b}</span>`).join("")}</div>` : "";
  const routeTxt = `${nombre(route.distance_km)} km · ${route.duree_text} de route`;
  if (!plan) {
    return `<div class="gps-itineraire attente">${titre}<div class="gps-itin-ligne">${routeTxt}</div><div class="gps-itin-sous">⏳ Calcul des recharges…</div></div>`;
  }
  if (!plan.ok) {
    return `<div class="gps-itineraire attente">${titre}<div class="gps-itin-ligne">${routeTxt}</div><div class="gps-itin-sous">⚠️ ${escapeHtml(plan.erreur || "Plan de recharge impossible.")}</div></div>`;
  }
  const arrets = plan.nb_arrets ? `${plan.nb_arrets} arrêt${plan.nb_arrets > 1 ? "s" : ""}` : "sans arrêt";
  const ligne = `🏁 <strong>${formaterMinutes(plan.duree_totale_min ?? plan.duree_min)}</strong> au total · ${routeTxt} · ${arrets} · ${plan.cout_total_eur ? euros(plan.cout_total_eur) : "0 €"} · 🔋 ${nombre(plan.pct_batterie_arrivee)} %`;
  const details = [];
  if (plan.km_autoroute) details.push(`🛣️ ${nombre(plan.km_autoroute)} km d'autoroute`);
  details.push(plan.km_peage ? `péage sur ${nombre(plan.km_peage)} km (≈ ${euros(coutPeage(plan.km_peage))})` : "sans péage");
  if (plan.retard_trafic_min >= 5) details.push(`🚦 ${formaterMinutes(plan.retard_trafic_min)} de bouchons`);
  if (!choisi && affiche?.ok) details.push(`${ecartMinutes((plan.duree_totale_min ?? 0) - (affiche.duree_totale_min ?? 0))} par rapport à l'affiché`);
  return `<button type="button" class="gps-itineraire${choisi ? " choisi" : ""}" data-itin="${i}">${titre}${pastilles}<div class="gps-itin-ligne">${ligne}</div><div class="gps-itin-sous">${details.join(" · ")}</div></button>`;
}

// Feuille de route des voies rapides : « km 45 · Sortie 4 · D31 ➜ Laval ».
const LIBELLES_ECHANGEUR = { entree: "↗️ Entrée", sortie: "↘️ Sortie", echangeur: "🔀 Échangeur" };

function echangeursHtml(p) {
  const liste = p.echangeurs || [];
  if (!liste.length) return "";
  const lignes = liste
    .map((e) => {
      const badges = [
        e.sortie ? `<span class="gps-num gps-num-sortie">${escapeHtml(e.sortie)}</span>` : "",
        ...e.numeros.map((n) => `<span class="gps-num gps-num-${classeNumero(n)}">${escapeHtml(n)}</span>`),
      ].join("");
      return `<div class="gps-echangeur"><span class="gps-echangeur-km">km ${nombre(e.km, e.km < 10 ? 1 : 0)}</span><span>${LIBELLES_ECHANGEUR[e.type]}</span>${badges}${e.direction ? `<span class="gps-echangeur-dir">➜ ${escapeHtml(e.direction)}</span>` : ""}</div>`;
    })
    .join("");
  return `<details class="gps-accordeon gps-echangeurs"><summary>🛣️ Sorties et échangeurs (${liste.length})</summary><div class="gps-echangeurs-liste">${lignes}</div></details>`;
}

// Aire préférée qui rallonge nettement le trajet : on le dit, avec la sortie.
const DETOUR_AIRE_ALERTE_KM = 8;

function choisirItineraire(i) {
  const plan = itineraires.plans[i];
  if (!plan) return toast("Plan de recharge de cet itinéraire encore en calcul…");
  if (!plan.ok) return toast(plan.erreur || "Plan de recharge impossible pour cet itinéraire.");
  if (plan !== dernierTrajet) afficherResultat(plan);
}

function afficherItineraires(p) {
  const zone = $("gps-itineraires");
  const index = itineraires.plans.indexOf(p);
  if (index < 0 || itineraires.routes.length < 2) {
    zone.classList.add("hidden");
    zone.innerHTML = "";
    afficherAlternatives([]);
    return;
  }
  const badges = badgesItineraires(itineraires.plans);
  const cartes = itineraires.routes.map((route, i) => carteItineraire(i, itineraires.plans[i], route, badges[i], p)).join("");
  zone.innerHTML = `<h3>🛣️ ${itineraires.routes.length} itinéraires proposés</h3>
    <div class="gps-itin-aide">Touche une route, ici ou sur la carte (en gris), pour voir son plan de recharge.</div>${cartes}`;
  zone.classList.remove("hidden");
  zone.querySelectorAll("[data-itin]").forEach((el) => el.addEventListener("click", () => choisirItineraire(Number(el.dataset.itin))));

  afficherAlternatives(
    itineraires.routes
      .map((route, i) => ({ route, i }))
      .filter(({ i }) => i !== index)
      .map(({ route, i }) => {
        const plan = itineraires.plans[i];
        const duree = plan?.ok ? `${formaterMinutes(plan.duree_totale_min ?? plan.duree_min)} au total` : `${route.duree_text} de route`;
        return { coords: route.coords, libelle: `Itinéraire ${i + 1} · ${duree}`, onClic: () => choisirItineraire(i) };
      }),
  );
}

function quitterTrajet() {
  effacerTrajet();
  trajetAffiche = false;
  afficherVue("accueil", { etat: "bas", historique: false });
}

// Navigation coupée (appli fermée, téléphone redémarré…) : on propose de la
// reprendre là où elle en était, avec la dernière batterie estimée.
function proposerRepriseNavigation() {
  const s = navigationInterrompue();
  if (!s || navigationActive()) return;
  const AUTO_S = 8;
  const bandeau = document.createElement("div");
  bandeau.className = "gps-maj gps-reprise";
  bandeau.innerHTML = `<span>🧭 Navigation coupée ${ageTexte(s.age_ms)} vers <strong>${escapeHtml(nomCourt(s.destination || "ta destination").split(",")[0])}</strong>${s.automatique ? `<br><small>Reprise automatique dans <b data-compte>${AUTO_S}</b> s</small>` : ""}</span><span class="gps-maj-boutons"><button type="button" class="gps-btn" data-reprise="oui">Reprendre</button><button type="button" class="gps-lien" data-reprise="non">${s.automatique ? "Annuler" : "✕"}</button></span>`;
  document.body.appendChild(bandeau);
  let minuteur = null;
  const reprendre = () => {
    clearInterval(minuteur);
    bandeau.remove();
    dernierTrajet = s.plan;
    dernierChargeDepartPct = s.batterie_pct;
    dernieresOptions = s.options;
    lancerNavigation(false);
  };
  bandeau.querySelector('[data-reprise="oui"]').addEventListener("click", reprendre);
  bandeau.querySelector('[data-reprise="non"]').addEventListener("click", () => {
    clearInterval(minuteur);
    bandeau.remove();
    oublierNavigationInterrompue();
  });
  // Coupure toute récente (appli fermée par le système en roulant) : la
  // navigation repart seule, les mains restent sur le volant.
  if (s.automatique) {
    let reste = AUTO_S;
    minuteur = setInterval(() => {
      reste--;
      const c = bandeau.querySelector("[data-compte]");
      if (c) c.textContent = String(Math.max(0, reste));
      if (reste <= 0) reprendre();
    }, 1000);
  }
}

function lancerNavigation(demo) {
  if (!dernierTrajet || navigationActive()) return;
  const options = dernieresOptions || construireOptions();
  demarrerNavigation(dernierTrajet, {
    options,
    demo,
    chargeDepartPct: dernierChargeDepartPct,
    // Recalcul des recharges en route, depuis la position actuelle de la voiture.
    onReplanifier: async (departCoordonnees, chargePct, restants = []) => {
      const o = { ...options, charge_pct: chargePct, depart_prevu: null };
      // Aire préférée déjà passée : ne pas y renvoyer.
      const imp = o.arret_impose;
      if (imp && !restants.some((a) => Math.abs(a.lat - imp.lat) < 0.01 && Math.abs(a.lon - imp.lon) < 0.01)) o.arret_impose = null;
      // Itinéraire choisi parmi les alternatives : on reste dessus.
      if (dernierTrajet.suivre_trace) {
        const [lat, lon] = departCoordonnees.split(",").map(Number);
        o.trace_imposee = [[lon, lat], ...traceRestante(dernierTrajet.coords, lat, lon).coords];
      }
      const plan = await planifierTrajet(departCoordonnees, o.destination, o, false);
      if (plan.ok) {
        dernierTrajet = plan;
        dernierChargeDepartPct = chargePct;
      }
      return plan;
    },
    onFin: () => {
      if (dernierTrajet) afficherResultat(dernierTrajet);
    },
  });
}

// Télécharge la carte du trajet et son guidage pour rouler sans réseau.
async function preparerTrajetHorsLigne() {
  if (!dernierTrajet?.coords?.length) return;
  const bouton = $("gps-hors-ligne-btn");
  const { tuiles, mo } = estimerPreparation(dernierTrajet);
  if (!confirm(`Préparer ce trajet pour rouler sans réseau ?\n\nCarte le long du tracé : environ ${tuiles} morceaux (~${mo} Mo), plus le guidage.\nMieux vaut être en wifi.`)) return;
  bouton.disabled = true;
  try {
    const r = await preparerHorsLigne(dernierTrajet, (fait, total) => {
      if (fait % 25 === 0 || fait === total) toast(`📥 Préparation hors ligne : ${Math.round((fait / total) * 100)} %`);
    });
    const bilan = bilanPreparation(r);
    toast(bilan.titre);
    alert(`${bilan.titre}\n\n${bilan.lignes.join("\n")}`);
  } catch (e) {
    toast(`⚠️ Préparation impossible : ${e.message}`);
  } finally {
    bouton.disabled = false;
  }
}

function cablerResultat() {
  $("gps-nav-demarrer-btn").addEventListener("click", () => lancerNavigation(false));
  $("gps-nav-demo-btn").addEventListener("click", () => lancerNavigation(true));
  $("gps-modifier-btn").addEventListener("click", () => afficherVue("trajet"));
  $("gps-quitter-trajet-btn").addEventListener("click", quitterTrajet);
  $("gps-export-btn").addEventListener("click", () => {
    if (dernierTrajet) telechargerTexte(`trajet_ve_${Date.now()}.txt`, exporterTrajetTexte(dernierTrajet));
  });
  $("gps-partager-btn").addEventListener("click", () => {
    if (dernierTrajet) partagerTexte(`Trajet électrique : ${nomCourt(dernierTrajet.from_name)} → ${nomCourt(dernierTrajet.to_name)}`, exporterTrajetTexte(dernierTrajet));
  });
  $("gps-hors-ligne-btn").addEventListener("click", preparerTrajetHorsLigne);
  $("gps-qrcode-btn").addEventListener("click", () => {
    if (!dernierTrajet) return;
    const box = $("gps-qrcode-box");
    const texte = `Trajet : ${nomCourt(dernierTrajet.from_name)} -> ${nomCourt(dernierTrajet.to_name)} (${dernierTrajet.distance_km} km). Destination : ${lienGoogleMaps(dernierTrajet.to_lat, dernierTrajet.to_lon)}`;
    box.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(texte)}" alt="QR code du trajet" width="220" height="220">`;
    box.classList.toggle("hidden");
  });
  document.querySelectorAll(".gps-courbe-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      vueCourbe = btn.dataset.vue;
    }),
  );
}

// ── Scénarios ──────────────────────────────────────────────────────────────


// ── Profil du trajet (courbes) ─────────────────────────────────────────────

let vueCourbe = "batterie";


let chargementChart = null;



// ── Frise "où serai-je ?" ──────────────────────────────────────────────────








let minuteurFrise = null;
let jetonFrise = 0;




// ── Favoris ────────────────────────────────────────────────────────────────

let ongletFavoris = "trajets";

function chargerEtLancerTrajet(depart, destination, reglages, etapes) {
  $("gps-depart-input").value = depart;
  $("gps-destination-input").value = destination;
  // Les étapes « via » de ce trajet-là, pas celles restées à l'écran.
  $("gps-via-input").value = "";
  pointsPassage = (etapes || reglages?.points_passage || []).map(({ lat, lon, nom }) => ({ lat, lon, nom }));
  rendrePointsPassage();
  if (reglages) {
    if (reglages.eviter_peages !== undefined) $("gps-eviter-peages-checkbox").checked = !!reglages.eviter_peages;
  }
  afficherVue("trajet");
  lancerTrajet();
}

function ligneSimple(titre, sous, idx, idSuppr) {
  return `<div class="gps-borne-ligne" data-idx="${idx}">
    <div class="gps-borne-infos"><div class="gps-borne-nom">${titre}</div>${sous ? `<div class="gps-borne-sous">${sous}</div>` : ""}</div>
    <button type="button" class="gps-mini-btn" data-suppr="${escapeHtml(idSuppr)}" title="Supprimer">🗑️</button>
  </div>`;
}

// « via Auray, Vannes » pour les listes de favoris et d'historique.
function texteVia(etapes) {
  return etapes?.length ? `via ${etapes.map((e, i) => e.nom || `étape ${i + 1}`).join(", ")}` : "";
}

function renderFavoris() {
  document.querySelectorAll(".gps-fav-onglet").forEach((b) => b.classList.toggle("active", b.dataset.onglet === ongletFavoris));
  $("gps-favoris-list").classList.toggle("hidden", ongletFavoris !== "trajets");
  $("gps-historique-bloc").classList.toggle("hidden", ongletFavoris !== "historique");

  const favoris = listerTrajetsFavoris();
  listesAffichees.set("gps-favoris-list", favoris);
  $("gps-favoris-list").innerHTML =
    favoris.map((f, i) => ligneSimple(`⭐ ${escapeHtml(f.depart)} → ${escapeHtml(f.destination)}`, escapeHtml(texteVia(f.etapes)), i, f.id)).join("") ||
    hint("Aucun trajet favori. Utilise « ☆ Trajet favori » dans l'onglet Trajet.");

  const historique = listerHistoriqueTrajets();
  listesAffichees.set("gps-historique-list", historique);
  $("gps-historique-list").innerHTML =
    historique
      .map((h, i) =>
        ligneSimple(
          `${escapeHtml(nomCourt(h.from_name) || h.depart)} → ${escapeHtml(nomCourt(h.to_name) || h.destination)}`,
          escapeHtml(
            [texteVia(h.reglages?.points_passage), `${h.distance_km} km`, h.duree_text, `${h.nb_arrets} arrêt(s)`, LABELS_MODE[h.reglages?.mode] || "", new Date(h.ts * 1000).toLocaleDateString("fr-FR")]
              .filter(Boolean)
              .join(" · "),
          ),
          i,
          h.id,
        ),
      )
      .join("") || hint("Aucun trajet calculé pour le moment.");

  const bornes = listerBornesFavorites();
    bornes.map((b, i) => ligneSimple(`🔌 ${escapeHtml(b.nom)}`, escapeHtml(b.adresse || ""), i, b.id)).join("") ||
    hint("Aucune borne favorite. Ouvre la fiche d'une borne et touche ☆ Favori.");
}

function cablerFavoris() {
  document.querySelectorAll(".gps-fav-onglet").forEach((b) =>
    b.addEventListener("click", () => {
      ongletFavoris = b.dataset.onglet;
      renderFavoris();
    }),
  );
  const gerer = (id, ouvrir, supprimer) =>
    $(id).addEventListener("click", (e) => {
      const suppr = e.target.closest("[data-suppr]");
      if (suppr) {
        e.stopPropagation();
        supprimer(suppr.dataset.suppr);
        renderFavoris();
        return;
      }
      const ligne = e.target.closest("[data-idx]");
      const element = ligne && listesAffichees.get(id)?.[Number(ligne.dataset.idx)];
      if (element) ouvrir(element);
    });
  gerer("gps-favoris-list", (f) => chargerEtLancerTrajet(f.depart, f.destination, null, f.etapes), retirerTrajetFavori);
  gerer("gps-historique-list", (h) => chargerEtLancerTrajet(h.depart, h.destination, h.reglages), supprimerTrajetHistorique);
  $("gps-historique-clear-btn").addEventListener("click", () => {
    // Efface aussi une éventuelle reprise en attente (trajet de test coupé
    // sans passer par "Arrêter") : sans ça, la bannière "Reprendre ?"
    // continuerait à proposer un trajet dont l'historique vient d'être
    // effacé -- demande explicite de l'utilisateur le 2026-09-27, après une
    // session d'essais où elle réapparaissait à chaque ouverture.
    if (confirm("Effacer tout l'historique des trajets, et oublier un trajet en attente de reprise ?")) {
      effacerHistoriqueTrajets();
      oublierNavigationInterrompue();
      renderFavoris();
    }
  });
}

// ── Outils : recherche de bornes et calculateur ────────────────────────────


let dernierCalculRecharge = { minutes: 0, cible: 80 };

// Calculateur de recharge : trois curseurs liés (batterie actuelle, niveau
// visé, énergie à ajouter) et résultat recalculé à chaque mouvement.
// source : le curseur qui vient de bouger ; les deux autres suivent.

// ── Mode urgence ───────────────────────────────────────────────────────────


// ── Profil ─────────────────────────────────────────────────────────────────


function rendreProfil() {
  const profil = obtenirProfilVehicule();
  rendreReglagesProfil();
}

// Consommation mesurée en roulant (corrections de batterie en navigation).

function rendreReglagesProfil() {
  const profil = obtenirProfilVehicule();
  const reglages = lireReglages();
  $("gps-reglage-domicile").value = reglages.adresse_domicile || "";
  $("gps-reglage-travail").value = reglages.adresse_travail || "";
  $("gps-reglage-annonce").checked = !!reglages.annonce_vocale;
  $("gps-reglage-carte3d").value = reglages.carte_3d || "libre";
  // Trop gourmand en 3D sur téléphone (tracé qui clignote, écran noir par
  // intermittence, confirmé par l'utilisateur le 2026-09-27) : la préférence
  // reste enregistrable, mais n'est jamais appliquée sur écran tactile
  // (voir carte3d.js) -- désactivé ici pour ne pas laisser croire qu'il
  // sert à quelque chose sur ce type d'appareil.
  if (matchMedia("(pointer: coarse)").matches) {
  }
  $("gps-reglage-jour-nuit").checked = reglages.jour_nuit_auto !== false;
  $("gps-reglage-taille-bandeau").value = reglages.taille_bandeau === "grand" ? "grand" : "compact";
  $("gps-reglage-zoom-renforce").checked = reglages.zoom_renforce !== false;
  $("gps-reglage-voix").checked = reglages.voix_guidage !== false;
  $("gps-reglage-voix-voies").checked = reglages.voix_voies !== false;
  $("gps-reglage-voix-travaux").checked = reglages.voix_travaux !== false;
  $("gps-reglage-bip").checked = reglages.bip_vitesse !== false;
  $("gps-reglage-marge-vitesse").value = String(reglages.marge_vitesse ?? 5);
  $("gps-reglage-fenetre-voies").checked = reglages.fenetre_voies !== false;
  $("gps-reglage-vue-carrefour").checked = reglages.vue_carrefour !== false;
  $("gps-reglage-icone").value = reglages.icone_voiture || "fleche_bleue";
  $("gps-reglage-meteo-route").checked = reglages.meteo_route !== false;
  $("gps-reglage-epure").checked = reglages.ecran_epure !== false;
  $("gps-reglage-reponses-voix").checked = reglages.reponses_voix !== false;
  $("gps-reglage-inclinaison").value = String(reglages.inclinaison_3d ?? 70);
  $("gps-reglage-inclinaison-val").textContent = String(reglages.inclinaison_3d ?? 70);
  $("gps-reglage-inclinaison-plate").value = String(reglages.inclinaison_ronds_points ?? 40);
  $("gps-reglage-inclinaison-plate-val").textContent = String(reglages.inclinaison_ronds_points ?? 40);
  $("gps-reglage-decalage-zoom").value = String(reglages.decalage_zoom_nav ?? 0);
  $("gps-reglage-decalage-zoom-val").textContent = String(reglages.decalage_zoom_nav ?? 0);
  $("gps-reglage-taille-texte").value = String(reglages.taille_texte_nav || 100);
  $("gps-reglage-taille-texte-val").textContent = String(reglages.taille_texte_nav || 100);
  $("gps-reglage-vibration").checked = reglages.vibration === true;
  $("gps-reglage-nuit-douce").checked = reglages.nuit_douce !== false;
  $("gps-reglage-notif").checked = reglages.notif_guidage !== false;
  $("gps-reglage-feux").checked = reglages.feux !== false;
  $("gps-reglage-zones-danger").checked = reglages.zones_danger !== false;
  $("gps-reglage-pause-mi-parcours").checked = reglages.pause_mi_parcours !== false;
  $("gps-reglage-alerte-virages").checked = reglages.alerte_virages !== false;
  $("gps-reglage-distance-virage").value = String(reglages.distance_virage || 300);
  $("gps-reglage-alerte-passages").checked = reglages.alerte_passages_niveau !== false;
  $("gps-reglage-alerte-stops").checked = reglages.alerte_stops !== false;

  const { tomtom, openChargeMap } = getApiKeys();
  $("gps-cle-tomtom").value = tomtom || "";

}

// Explique un refus TomTom en clair (les codes seuls ne parlent à personne).
function expliquerRefusTomTom(r) {
  if (r.ok) return "fonctionne";
  const m = (r.message || "").toLowerCase();
  if (r.statut === 401) return "clé inconnue : vérifie qu'elle est bien recopiée";
  if (/qps|rate|limit|quota|over/.test(m)) return `quota TomTom dépassé (« ${r.message} ») : réessaie plus tard`;
  if (r.statut === 403) return `refusé par TomTom (« ${r.message || "accès interdit"} ») : sur developer.tomtom.com, vérifie que ce service est coché pour ta clé`;
  if (r.statut === 0) return r.message;
  return `erreur HTTP ${r.statut}${r.message ? ` (« ${r.message} »)` : ""}`;
}

// Bouton manuel "🔍 Tester ma clé TomTom" ET vérification automatique après
// enregistrement d'une clé modifiée (voir gps-profil-save-btn) : la clé
// « VE » de l'utilisateur (routage seulement, sans carte) est passée
// inaperçue toute une journée le 2026-09-27 faute d'avoir pensé à tester
// après l'avoir changée -- ce test tourne désormais tout seul à ce moment-là.
async function testerCleTomTom(cle) {
  const zone = $("gps-tester-tomtom-resultat");
  zone.classList.remove("hidden");
  if (!cle) {
    zone.textContent = "Saisis d'abord ta clé TomTom.";
    return;
  }
  const bouton = $("gps-tester-tomtom-btn");
  bouton.disabled = true;
  zone.textContent = "⏳ Test en cours…";
  try {
    const resultats = await diagnostiquerCleTomTom(cle);
    zone.innerHTML = resultats.map((r) => `<div>${r.ok ? "✅" : "❌"} <strong>${escapeHtml(r.service)}</strong> : ${escapeHtml(expliquerRefusTomTom(r))}</div>`).join("");
  } finally {
    bouton.disabled = false;
  }
}

// ── Carte de la région hors ligne (Profil) ──────────────────────────────────

let regionEnCours = false;

async function centreRegion() {
  const domicile = lireReglages().adresse_domicile;
  const lieu = await resoudreLieu(domicile ? "chez moi" : "ma position", domicile);
  return lieu.erreur ? null : lieu;
}


async function telechargerRegion() {
  if (regionEnCours) return;
  const rayon = Number($("gps-region-rayon").value);
  const centre = await centreRegion();
  if (!centre) return toast("⚠️ Adresse du domicile introuvable : renseignez-la dans le Profil, ou autorisez la localisation.");
  const { tuiles, mo } = estimerRegion(centre.lat, centre.lon, rayon);
  if (!confirm(`Télécharger la carte de la région (${rayon} km autour de ${nomCourt(centre.nom).split(",")[0]}) ?\n\nEnviron ${tuiles} morceaux, ~${mo} Mo. À faire en Wi-Fi.`)) return;
  regionEnCours = true;
  const bouton = $("gps-region-btn");
  bouton.disabled = true;
  try {
    const r = await preparerRegion(centre.lat, centre.lon, rayon, (fait, total) => {
      if (fait % 50 === 0 || fait === total) bouton.textContent = `📥 ${Math.round((fait / total) * 100)} %`;
    });
    toast(r.tuiles >= r.total * 0.95 ? `✅ Région prête hors ligne (${r.tuiles}/${r.total} morceaux)` : `⚠️ Téléchargement incomplet (${r.tuiles}/${r.total}) : réessayez avec un meilleur réseau`);
  } catch (e) {
    toast(`⚠️ Téléchargement impossible : ${e.message}`);
  } finally {
    regionEnCours = false;
    bouton.disabled = false;
    bouton.textContent = "📥 Télécharger ma région";
    majInfoRegion();
  }
}

async function remettreAZero() {
  if (navigationActive()) return toast("⚠️ Pas pendant une navigation.");
  if (!confirm("Remettre l'appli à zéro ?\n\nEffacé : réglages, favoris, historique, journal des recharges, abonnements, trajets et données apprises.\nConservé : votre voiture (Kona 65 kWh), vos clés et la carte de la région.")) return;
  const n = await remiseAZero();
  toast(`🧹 Remise à zéro faite (${n} éléments) : redémarrage…`);
  setTimeout(() => location.reload(), 1200);
}

function cablerProfil() {
  $("gps-remise-zero-btn").addEventListener("click", remettreAZero);
  $("gps-region-rayon").innerHTML = RAYONS_REGION_KM.map((k) => `<option value="${k}"${k === 50 ? " selected" : ""}>${k} km</option>`).join("");
  $("gps-region-btn").addEventListener("click", telechargerRegion);
  majInfoRegion();
  cablerZonesEvitees(afficherVue);
  $("gps-export-donnees-btn").addEventListener("click", exporterSauvegarde);
  $("gps-lien-sauvegarde-btn").addEventListener("click", envoyerLienRestauration);
  $("gps-installer-btn").addEventListener("click", installerAppli);
  majInfoLien();
  majBoutonInstallation();
  $("gps-import-donnees-btn").addEventListener("click", () => $("gps-import-donnees-fichier").click());
  $("gps-import-donnees-fichier").addEventListener("change", (e) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (fichier && confirm("Remplacer toutes les données de ce téléphone par celles de la sauvegarde ?")) importerSauvegarde(fichier);
  });
  $("gps-tester-tomtom-btn").addEventListener("click", () => testerCleTomTom($("gps-cle-tomtom").value.trim() || getApiKeys().tomtom));
  for (const id of ["gps-cle-tomtom"]) {
    $(`${id}-voir`).addEventListener("click", () => {
      // Masquage par le style, pas par un champ « mot de passe » : sinon le
      // téléphone prend la destination pour un identifiant et propose
      // d'enregistrer un mot de passe Google à chaque calcul de trajet.
      const masquee = $(id).classList.toggle("gps-cle-masquee");
      $(`${id}-voir`).textContent = masquee ? "👁️" : "🙈";
    });
  }
}

// ── Démarrage ──────────────────────────────────────────────────────────────

// Raccourcis de l'icône de l'appli (appui long) : ?action=maison, bornes, voiture.
// La veille (ou le jour même) d'un trajet prévu, le soir : « branchez ce soir ».
// « 💡 Travail ? » : destination souvent prise à cette heure-ci.
// Suggestions masquées par l'utilisateur (✕) : mémorisées sur l'appareil.
const CLE_SUGGESTIONS_MASQUEES = "gps_suggestions_masquees";
function suggestionsMasquees() {
  try {
    return JSON.parse(localStorage.getItem(CLE_SUGGESTIONS_MASQUEES) || "[]");
  } catch {
    return [];
  }
}

function majSuggestionTrajet() {
  let d = destinationHabituelle();
  if (d && suggestionsMasquees().includes(d)) d = null;
  // « Chez moi » et « Travail » ont déjà leur bouton : pas de doublon avec l'adresse.
  if (/^(Chez moi|Travail) \(/.test(d || "")) d = null;
  const b = $("gps-suggestion-trajet");
  b.classList.toggle("hidden", !d);
  if (d) {
    b.dataset.dest = d;
    b.innerHTML = `💡 ${escapeHtml(nomCourt(d).split(",")[0])} ? <span class="gps-sugg-x" data-x="1" aria-label="Ne plus proposer">✕</span>`;
  }
}


export function executerAction(action) {
  if (action === "maison") {
    if (!lireReglages().adresse_domicile) {
      afficherVue("profil");
      return toast("🏠 Indique d'abord l'adresse du domicile dans le Profil.");
    }
    afficherVue("trajet");
    $("gps-depart-input").value = "Ma position";
    $("gps-destination-input").value = "Chez moi";
    lancerTrajet();
  } else if (action === "accueil") {
    afficherVue("accueil");
    localiser();
  } else if (action === "voiture") {
    afficherVue("accueil");
  }
}

// Départ et destination toujours vides à l'ouverture -- demande explicite de
// l'utilisateur les 2026-09-27 et 2026-10-01 (champ vide = ma position pour
// le départ, cf. placeholder). Exportée pour être rappelée aussi quand
// l'appli revient au premier plan sans recharger la page (voir main.js) :
// sur téléphone, Android/Chrome "rouvre" souvent l'onglet tel qu'il était
// laissé plutôt que de relancer initialiserUI, et le champ garderait sinon
// le texte tapé lors du dernier essai.
export function viderChampsTrajet() {
  $("gps-depart-input").value = "";
  $("gps-destination-input").value = "";
  // Les étapes « via » suivent : restées là, elles s'appliqueraient au
  // trajet suivant sans qu'on y pense.
  $("gps-via-input").value = "";
  if (pointsPassage.length) {
    pointsPassage = [];
    rendrePointsPassage();
  }
}

// ── Compléments : moyens de paiement, minuteur, autonomie, vitesse ─────────

// Menu › Payer aux bornes : ce que l'utilisateur possède pour payer.


// Minuteur de recharge hors guidage (depuis le calculateur). Gardé dans le
// téléphone : il reprend si l'appli est rouverte entre-temps.
const CLE_MINUTEUR_RECHARGE = "tve_minuteur_recharge";
let minuteurRechargeId = null;




// Cercle d'autonomie : jusqu'où aller avec la batterie réglée dans Trajet, en
// gardant la réserve. Une route n'est jamais droite : le rayon à vol d'oiseau
// est pris à 75 % de la distance par la route.
const PART_VOL_OISEAU = 0.75;
let autonomieAffichee = false;


// « Et si je roulais à 110 ? » : le même trajet, vitesse plafonnée.
const VITESSE_CONSEIL_KMH = 110;


// Menu › État de l'appli (voir etat-appli.js). gpsTest : résultat du dernier
// essai lancé par l'utilisateur ; la position elle-même n'est pas gardée.
let dernierTestGps = null;

async function rendreEtatAppli() {
  let gpsPermission = null;
  try {
    gpsPermission = (await navigator.permissions?.query({ name: "geolocation" }))?.state ?? null;
  } catch {
    // Navigateur sans cette interrogation : état inconnu.
  }
  const cles = getApiKeys();
  const prepare = guidagePrepare();
  const diag = navigationActive() ? etatDiagnostic() : null;
  const lignes = lignesEtat({
    enLigne: navigator.onLine,
    gpsPermission,
    gpsTest: dernierTestGps,
    cles: { tomtom: !!cles.tomtom, openChargeMap: !!cles.openChargeMap },
    quota: { utilise: appelsTomTomDuJour(), max: QUOTA_TOMTOM_JOUR },
    guidagePrepare: prepare ? { ageMin: (Date.now() - prepare.ts) / 60000, nbArrets: prepare.nbArrets } : null,
    regionPreparee: !!regionPreparee(),
    guidage: diag ? { signal: diag.gps_signal, niveau: diag.gps_niveau, age_s: Number(diag.gps_age_s), ecartees: diag.gps_mesures_ecartees, estimations: diag.gps_passages_a_l_estime } : null,
  });
  const symboles = { ok: "✅", attention: "⚠️", info: "ℹ️" };
  $("gps-etat-liste").innerHTML = lignes.map((l) => `<div class="gps-etat-ligne gps-etat-${l.niveau}"><span aria-hidden="true">${symboles[l.niveau]}</span><div><strong>${escapeHtml(l.titre)}</strong><div>${escapeHtml(l.texte)}</div></div></div>`).join("");
}

function testerGps() {
  const bouton = $("gps-etat-gps-btn");
  bouton.disabled = true;
  bouton.textContent = "📍 Recherche…";
  const fin = (resultat) => {
    dernierTestGps = resultat;
    bouton.disabled = false;
    bouton.textContent = "📍 Tester le GPS";
    rendreEtatAppli();
  };
  if (!("geolocation" in navigator)) return fin({ erreur: "La localisation n'existe pas sur cet appareil." });
  navigator.geolocation.getCurrentPosition(
    (p) => fin({ precision: p.coords.accuracy, niveau: niveauPrecision(p.coords.accuracy) }),
    (e) => fin({ erreur: e.code === e.PERMISSION_DENIED ? "Localisation refusée pour cette appli : autorise-la dans les réglages du téléphone." : "Aucune position reçue en 20 secondes : essaie dehors, à ciel dégagé." }),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
}

function cablerComplements() {
  $("gps-etat-gps-btn").addEventListener("click", testerGps);
  $("gps-etat-actualiser-btn").addEventListener("click", rendreEtatAppli);
  window.addEventListener("online", () => vueCourante === "profil" && rendreEtatAppli());
  window.addEventListener("offline", () => vueCourante === "profil" && rendreEtatAppli());
  // Les minuteries s'endorment en arrière-plan : on recale au retour.
}

export function initialiserUI() {
  viderChampsTrajet();
  initCarte("gps-carte", { fondInitial: lireReglages().fond_carte || fondParDefaut(), onDeplacement: surDeplacementCarte });
  cablerTheme();
  cablerFeuille();
  cablerNavigation();
  cablerPointsPassage();
  cablerCarte();
  cablerFormulaire();
  cablerResultat();
  cablerFavoris();
  cablerProfil();
  cablerComplements();

  cablerRechercheBas();
  demarrerRadarsCarte(carteLeaflet());
  chargerPrefs();
  rendreProfil();
  appliquerTheme();
  afficherVue("accueil", { etat: "bas", historique: false });
  positionDeDepart();
  proposerRepriseNavigation();
  // Nouveaux utilisateurs seulement (aucune clé encore saisie).
}

function majInfoRegion() {
  const r = regionPreparee();
  $("gps-region-info").textContent = r
    ? `✅ Région prête : ${r.rayon_km} km autour de ${new Date(r.date).toLocaleDateString("fr-FR")} (${Math.round((r.tuiles * 25) / 1024)} Mo environ).`
    : "Pas encore de région téléchargée.";
}

// Barre « Où allez-vous ? » en bas de l'écran d'accueil : ouvre la planification, destination prête à saisir.
// Interrupteurs du menu « Outils » : même réglage que dans Profil › Navigation,
// appliqué tout de suite. Le contraste est activé par défaut à « non ».
const ACTIF_PAR_DEFAUT = { contraste_fort: false };

function estActifReglage(cle) {
  const r = lireReglages();
  return cle in ACTIF_PAR_DEFAUT ? r[cle] === true : r[cle] !== false;
}

function majBasculesMenu() {
  document.querySelectorAll("[data-basculer]").forEach((b) => {
    b.querySelector(".gps-menu-detail").textContent = estActifReglage(b.dataset.basculer) ? "Activé" : "Désactivé";
  });
}

function cablerBasculesMenu() {
  $("vue-menu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-basculer]");
    if (!b) return;
    const cle = b.dataset.basculer;
    const on = !estActifReglage(cle);
    sauverReglages({ [cle]: on });
    const reglage = $(b.dataset.id);
    if (reglage) {
      reglage.checked = on;
      reglage.dispatchEvent(new Event("change"));
    }
    majBasculesMenu();
    toast(`${b.querySelector(".gps-menu-nom").textContent} : ${on ? "activé" : "désactivé"}`);
  });
  majBasculesMenu();
}

function cablerRechercheBas() {
  // ✕ de la suggestion : ne la propose plus (capture : empêche le lancement du trajet).
  $("gps-suggestion-trajet").addEventListener("click", (e) => {
    if (!e.target.closest("[data-x]")) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const d = $("gps-suggestion-trajet").dataset.dest;
    if (d) localStorage.setItem(CLE_SUGGESTIONS_MASQUEES, JSON.stringify([...suggestionsMasquees(), d]));
    majSuggestionTrajet();
  }, true);
  $("gps-raccourcis").addEventListener("click", (e) => {
    const x = e.target.closest("[data-oublier]");
    if (!x) return;
    const dest = x.dataset.oublier;
    for (const h of listerHistoriqueTrajets().filter((h) => h.destination === dest)) supprimerTrajetHistorique(h.id);
    rendreRaccourcis();
    toast(`${nomCourt(dest).split(",")[0]} retiré des raccourcis.`);
  });
  $("gps-reglage-marge-vitesse").addEventListener("change", (e) => sauverReglages({ marge_vitesse: Number(e.target.value) }));
  // Bouton « Enregistrer » du panneau Réglages : tous les champs restants, d'un coup.
  $("gps-profil-save-btn").addEventListener("click", () => {
    sauverReglages({
      adresse_domicile: $("gps-reglage-domicile").value.trim(),
      adresse_travail: $("gps-reglage-travail").value.trim(),
      annonce_vocale: $("gps-reglage-annonce").checked,
      carte_3d: $("gps-reglage-carte3d").value,
      jour_nuit_auto: $("gps-reglage-jour-nuit").checked,
      taille_bandeau: $("gps-reglage-taille-bandeau").value,
      zoom_renforce: $("gps-reglage-zoom-renforce").checked,
      voix_guidage: $("gps-reglage-voix").checked,
      voix_voies: $("gps-reglage-voix-voies").checked,
      voix_travaux: $("gps-reglage-voix-travaux").checked,
      bip_vitesse: $("gps-reglage-bip").checked,
      marge_vitesse: Number($("gps-reglage-marge-vitesse").value),
      fenetre_voies: $("gps-reglage-fenetre-voies").checked,
      vue_carrefour: $("gps-reglage-vue-carrefour").checked,
      icone_voiture: $("gps-reglage-icone").value,
      meteo_route: $("gps-reglage-meteo-route").checked,
      ecran_epure: $("gps-reglage-epure").checked,
      reponses_voix: $("gps-reglage-reponses-voix").checked,
      taille_texte_nav: Number($("gps-reglage-taille-texte").value),
      inclinaison_3d: Number($("gps-reglage-inclinaison").value),
      inclinaison_ronds_points: Number($("gps-reglage-inclinaison-plate").value),
      decalage_zoom_nav: Number($("gps-reglage-decalage-zoom").value),
      vibration: $("gps-reglage-vibration").checked,
      nuit_douce: $("gps-reglage-nuit-douce").checked,
      notif_guidage: $("gps-reglage-notif").checked,
      feux: $("gps-reglage-feux").checked,
      zones_danger: $("gps-reglage-zones-danger").checked,
      pause_mi_parcours: $("gps-reglage-pause-mi-parcours").checked,
      alerte_virages: $("gps-reglage-alerte-virages").checked,
      distance_virage: Number($("gps-reglage-distance-virage").value),
      alerte_passages_niveau: $("gps-reglage-alerte-passages").checked,
      alerte_stops: $("gps-reglage-alerte-stops").checked,
    });
    toast("✅ Réglages enregistrés");
  });
  $("gps-recherche-bas").addEventListener("click", () => {
    afficherVue("trajet");
    $("gps-destination-input").focus();
  });
  $("gps-raccourcis").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dest]");
    if (!b) return;
    $("gps-destination-input").value = b.dataset.dest;
    $("gps-destination-input").dispatchEvent(new Event("change"));
    afficherVue("trajet");
    lancerTrajet();
  });
  rendreRaccourcis();
  cablerPresDeMoi();
  cablerBasculesMenu();
}

// Raccourcis sous la recherche : Maison, Travail, puis les dernières destinations.
function rendreRaccourcis() {
  const r = lireReglages();
  const items = [];
  if (r.adresse_domicile) items.push({ icone: "🏠", texte: "Maison", dest: "Chez moi" });
  if (r.adresse_travail) items.push({ icone: "💼", texte: "Travail", dest: "Travail" });
  const recents = [...new Set(listerHistoriqueTrajets().map((h) => h.destination).filter(Boolean))].slice(0, 3);
  for (const d of recents) items.push({ icone: "🕐", texte: nomCourt(d).split(",")[0], dest: d, recent: true });
  const personnels = items.length
    ? items.map((i) => i.recent
        ? `<span class="gps-raccourci-duo"><button type="button" class="gps-raccourci" data-dest="${escapeHtml(i.dest)}"><span aria-hidden="true">${i.icone}</span><span>${escapeHtml(i.texte)}</span></button><button type="button" class="gps-raccourci-x" data-oublier="${escapeHtml(i.dest)}" aria-label="Retirer ${escapeHtml(i.texte)}">✕</button></span>`
        : `<button type="button" class="gps-raccourci" data-dest="${escapeHtml(i.dest)}"><span aria-hidden="true">${i.icone}</span><span>${escapeHtml(i.texte)}</span></button>`).join("")
    : '<span class="gps-raccourcis-aide">Maison, Travail et vos derniers trajets apparaîtront ici.</span>';
  const actions = [["essence", "⛽", "Station"], ["repos", "🌳", "Aire"], ["parking", "🅿️", "Parking"], ["restaurant", "🍴", "Restau"]];
  const ligneActions = actions.map(([k, ic, t]) => `<button type="button" class="gps-raccourci gps-raccourci-action" data-pres="${k}"><span aria-hidden="true">${ic}</span><span>${t}</span></button>`).join("");
  $("gps-raccourcis").innerHTML = ligneActions + personnels;
}

// Météo sur l'itinéraire, avant le départ : départ, milieu et arrivée à l'heure de passage.
async function chargerMeteoTrajet(p) {
  const bloc = $("gps-trajet-summary");
  if (!bloc || !Number.isFinite(p.from_lat) || !Number.isFinite(p.to_lat)) return;
  const debutS = (p.depart_ms || Date.now()) / 1000;
  const dureeS = (p.duree_totale_min || p.duree_min || 0) * 60;
  const points = [
    { nom: "Départ", lat: p.from_lat, lon: p.from_lon, quandS: debutS },
    { nom: "Milieu", lat: (p.from_lat + p.to_lat) / 2, lon: (p.from_lon + p.to_lon) / 2, quandS: debutS + dureeS / 2 },
    { nom: "Arrivée", lat: p.to_lat, lon: p.to_lon, quandS: debutS + dureeS },
  ];
  bloc.insertAdjacentHTML("beforeend", '<div class="gps-meteo-trajet" id="gps-meteo-trajet">🌡️ Météo sur le trajet : chargement…</div>');
  const mesures = await meteoDesPoints(points);
  const sortie = $("gps-meteo-trajet");
  if (!sortie) return;
  if (!mesures) { sortie.textContent = "🌡️ Météo indisponible."; return; }
  const alertes = [];
  const morceaux = points.map((pt, i) => {
    const m = mesures[i];
    if (!m) return `${pt.nom} : –`;
    const al = alerteMeteo(m);
    if (al) alertes.push(al.texte);
    return `${pt.nom} ${Math.round(m.temp)} °C`;
  });
  sortie.innerHTML = `🌡️ ${morceaux.join(" · ")}${alertes.length ? `<br>${escapeHtml([...new Set(alertes)].join(" · "))}` : ""}`;
}
