// Garde une copie de l'appli (HTML/CSS/JS/icônes) et la sert en premier :
// l'appli démarre tout de suite, avec ou sans réseau. Une mise à jour
// publiée arrive par un nouveau numéro de CACHE_NOM (voir tests/version.test.mjs).
// Garde aussi, pour rouler sans réseau, la carte OpenFreeMap (tuiles
// vectorielles, polices, icônes) et les bibliothèques de carte déjà vues ou
// préparées. Les autres services (TomTom, bornes, météo) ne passent pas ici :
// TomTom interdit de stocker ses cartes, et les autres doivent être frais.

const CACHE_NOM = "gps-v7";
// Empreinte des fichiers ci-dessous, vérifiée par les tests : les téléphones
// ne reçoivent une modification que si ce fichier change. À chaque
// publication : augmenter CACHE_NOM et recopier l'empreinte donnée par le test.
const EMPREINTE_COQUILLE = "fd5ab8c622526c96";
const FICHIERS_COQUILLE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/main.js",
  "./js/ui.js",
  "./js/ui-commun.js",
  "./js/ui-journal.js",
  "./js/ui-abonnements.js",
  "./js/ui-sauvegarde.js",
  "./js/ui-parkings.js",
  "./js/ui-accueil.js",
  "./js/ui-installation.js",
  "./js/restauration.js",
  "./js/trajet.js",
  "./js/planner.js",
  "./js/energie.js",
  "./js/courbe.js",
  "./js/carte.js",
  "./js/carte3d.js",
  "./js/parkings.js",
  "./js/hors-ligne.js",
  "./js/navigation.js",
  "./js/zoom-nav.js",
  "./js/alertes-route.js",
  "./js/osm-route.js",
  "./js/ui-zones.js",
  "./js/panneau-nav.js",
  "./js/icones-voiture.js",
  "./js/recherche-route.js",
  "./js/ui-suggestions.js",
  "./js/ui-voiture.js",
  "./js/commandes-vocales.js",
  "./js/graphique-batterie.js",
  "./js/meteo-route.js",
  "./js/statistiques.js",
  "./js/ui-stats.js",
  "./js/ui-quand-partir.js",
  "./js/ui-arret-impose.js",
  "./js/ui-partage.js",
  "./js/drive.js",
  "./js/ui-drive.js",
  "./js/icones.js",
  "./js/sos.js",
  "./js/ui-sos.js",
  "./js/nav-outils.js",
  "./js/presentation.js",
  "./js/reprise.js",
  "./js/recalage.js",
  "./js/etat-appli.js",
  "./js/partage-position.js",
  "./js/journal-erreurs.js",
  "./js/ui-diagnostic.js",
  "./js/irve.js",
  "./js/ocm.js",
  "./js/paiement.js",
  "./js/tomtom.js",
  "./js/geo.js",
  "./js/storage.js",
  "./js/config.js",
  "./js/util.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NOM)
      .then((cache) => cache.addAll(FICHIERS_COQUILLE.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Seulement les anciennes copies de l'appli (pas les données gardées
      // par l'appli elle-même, comme l'état des bornes).
      .then((noms) => Promise.all(noms.filter((n) => n.startsWith("trajetve-v") && n !== CACHE_NOM).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// ── Carte et bibliothèques pour le hors ligne ───────────────────────────────

const CACHE_CARTES = "trajetve-cartes";
const HOTES_CARTES = ["tiles.openfreemap.org", "cdn.jsdelivr.net", "unpkg.com"];
// Une région préparée (rayon 80 km) tient en ~3 500 tuiles, plus les trajets.
const MAX_ELEMENTS_CARTES = 12000;
let ajoutsDepuisMenage = 0;

// Adresses versionnées (tuiles, polices, icônes, bibliothèques) : elles ne
// changent jamais, la copie gardée suffit. Le style (non versionné) passe
// d'abord par le réseau pour rester à jour.
function immuable(url) {
  return url.pathname.endsWith(".pbf") || url.pathname.includes("/sprites/") || url.pathname.includes("/natural_earth/") || url.hostname !== "tiles.openfreemap.org";
}

async function menageCartes(cache) {
  const cles = await cache.keys();
  const surplus = cles.length - MAX_ELEMENTS_CARTES;
  // Les plus anciennes d'abord (ordre d'ajout).
  for (let i = 0; i < surplus + 500 && surplus > 0; i++) await cache.delete(cles[i]);
}

async function carteOuReseau(requete) {
  const url = new URL(requete.url);
  const cache = await caches.open(CACHE_CARTES);
  if (immuable(url)) {
    const garde = await cache.match(requete);
    if (garde) return garde;
  }
  try {
    const reponse = await fetch(requete);
    // « opaque » : bibliothèques chargées par <script> (Leaflet…), sans quoi
    // l'appli ne démarrerait pas hors connexion.
    if (reponse.ok || reponse.type === "opaque") {
      await cache.put(requete, reponse.clone());
      if (++ajoutsDepuisMenage >= 200) {
        ajoutsDepuisMenage = 0;
        menageCartes(cache);
      }
    }
    return reponse;
  } catch (e) {
    const garde = await cache.match(requete);
    if (garde) return garde;
    throw e;
  }
}

// Notification de guidage (écran verrouillé) : un toucher rouvre l'appli.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
      const f = fenetres[0];
      return f ? f.focus() : self.clients.openWindow("./index.html");
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (HOTES_CARTES.includes(url.hostname)) {
    event.respondWith(carteOuReseau(event.request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(coquilleOuReseau(event.request));
});

// Fichiers de l'appli : la copie gardée d'abord, sans attendre le réseau
// (démarrage immédiat, même avec un signal faible). Une version publiée
// arrive par le changement de CACHE_NOM : le nouveau service worker
// télécharge toute la coquille d'un coup, puis l'appli se recharge.
async function coquilleOuReseau(requete) {
  const cache = await caches.open(CACHE_NOM);
  // ignoreSearch : raccourcis de l'icône (index.html?action=…).
  const garde = await cache.match(requete, { ignoreSearch: true });
  if (garde) return garde;
  try {
    // "no-cache" : GitHub Pages autorise 10 min de cache navigateur.
    return await fetch(requete.url, { cache: "no-cache" });
  } catch (e) {
    const accueil = requete.mode === "navigate" ? await cache.match("./index.html") : null;
    if (accueil) return accueil;
    throw e;
  }
}
