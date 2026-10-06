// Radars et feux tricolores affichés sur la carte de planification (OpenStreetMap, zone visible).
// Discret : petits points colorés, seulement à partir d'un zoom suffisant.

const ZOOM_MINI = 12;
const DELAI_MS = 900;
const MAX_POINTS = 400;
const ENDPOINT = "https://overpass-api.de/api/interpreter";

let couche = null;
let minuteur = null;
let dernierCadre = "";

function pointCarte(lat, lon, couleur, titre) {
  return L.circleMarker([lat, lon], {
    radius: 5,
    color: "#ffffff",
    weight: 1.5,
    fillColor: couleur,
    fillOpacity: 1,
    interactive: true,
  }).bindTooltip(titre);
}

async function chargerPoints(carte) {
  if (carte.getZoom() < ZOOM_MINI) {
    couche?.clearLayers();
    return;
  }
  const b = carte.getBounds();
  const cadre = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(3)).join(",");
  if (cadre === dernierCadre) return;
  dernierCadre = cadre;
  const requete = `[out:json][timeout:20];(node["highway"="speed_camera"](${cadre});node["enforcement"="maxspeed"](${cadre});node["highway"="traffic_signals"](${cadre}););out ${MAX_POINTS};`;
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ data: requete }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    couche.clearLayers();
    for (const e of data.elements || []) {
      const t = e.tags || {};
      if (t.highway === "traffic_signals") couche.addLayer(pointCarte(e.lat, e.lon, "#f59e0b", "Feu tricolore"));
      else couche.addLayer(pointCarte(e.lat, e.lon, "#ef4444", "Radar"));
    }
  } catch {
    // Pas de réseau : la carte reste utilisable sans ces points.
  }
}

// À appeler une fois la carte créée.
export function demarrerRadarsCarte(carte) {
  couche = L.layerGroup().addTo(carte);
  const relancer = () => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => chargerPoints(carte), DELAI_MS);
  };
  carte.on("moveend", relancer);
  relancer();
}
