const APP_VERSION = '1.7.0';
const ROUTERS = {
  driving: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  cycling: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving',
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
};
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const REQUEST_TIMEOUT = 20000;
const MAX_VIA_POINTS = 5;
const MAPLIBRE_SCRIPT = './vendor/maplibre/maplibre-gl.js';
const MAPLIBRE_CSS = './vendor/maplibre/maplibre-gl.css';
const PROFILE_LABELS = { driving: 'Voiture', cycling: 'Vélo', foot: 'À pied' };
const SETTINGS_KEY = 'trajetwaze_settings';
const DEFAULT_SETTINGS = {
  units: 'km',
  mapStyle: 'standard',
  adaptiveZoom: true,
  followHeading: true,
  voiceGuidance: false,
  wakeLock: true,
  default3d: false,
};
let settings;
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
} catch (error) {
  console.error('Paramètres GPS enregistrés illisibles :', error);
  settings = { ...DEFAULT_SETTINGS };
}
const map = L.map('map', { zoomControl: false, scrollWheelZoom: true, attributionControl: true })
  .setView([48.8566, 2.3522], 12);
const lightTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  subdomains: 'abc',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const lightFallbackTiles = L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://tile.openstreetmap.de">OpenStreetMap Germany</a>',
});
let lightTilesFallbackActive = false;
let mapTilesFallbackErrorShown = false;
lightTiles.on('tileerror', () => {
  if (lightTilesFallbackActive || !map.hasLayer(lightTiles)) return;
  lightTilesFallbackActive = true;
  map.removeLayer(lightTiles);
  lightFallbackTiles.addTo(map);
  showToast('Fond OpenStreetMap indisponible ; affichage du fond de secours.');
});
lightFallbackTiles.on('tileerror', () => {
  if (!lightTilesFallbackActive || !map.hasLayer(lightFallbackTiles) || mapTilesFallbackErrorShown) return;
  mapTilesFallbackErrorShown = true;
  showToast('La carte ne peut pas être chargée. Vérifiez la connexion Internet.');
});
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

const elements = {
  from: document.getElementById('fromInput'),
  to: document.getElementById('toInput'),
  viaFields: document.getElementById('viaFields'),
  addVia: document.getElementById('addViaBtn'),
  profile: document.getElementById('profileSelect'),
  status: document.getElementById('routeStatus'),
  options: document.getElementById('routeOptions'),
  choiceList: document.getElementById('routeChoiceList'),
  routeCount: document.getElementById('routeCount'),
  duration: document.getElementById('routeDuration'),
  distance: document.getElementById('routeDistance'),
  arrival: document.getElementById('arrivalTime'),
  routeName: document.getElementById('routeName'),
  routeNote: document.getElementById('routeNote'),
  steps: document.getElementById('stepsList'),
  startDrive: document.getElementById('startDriveBtn'),
  sign: document.getElementById('directionSign'),
  signPanel: document.getElementById('signPanel'),
  signKicker: document.getElementById('signKicker'),
  signRoad: document.getElementById('signRoad'),
  signDestination: document.getElementById('signDestination'),
  signExit: document.getElementById('signExit'),
  lanes: document.getElementById('laneGuidance'),
  laneTrack: document.getElementById('laneTrack'),
  laneRoad: document.getElementById('laneRoad'),
  laneCaption: document.getElementById('laneCaption'),
  routeCard: document.getElementById('routeCard'),
  nearby: document.getElementById('nearbyServices'),
  nearbyFuel: document.getElementById('nearbyFuel'),
  nearbyRest: document.getElementById('nearbyRest'),
  toast: document.getElementById('toast'),
  settingsDialog: document.getElementById('settingsDialog'),
};

const state = {
  routes: [],
  selectedRoute: 0,
  routeLayers: [],
  startMarker: null,
  endMarker: null,
  userMarker: null,
  poiLayers: new Map(),
  poiEnabled: new Set(),
  userReports: L.layerGroup().addTo(map),
  gpsWatch: null,
  currentPosition: null,
  geocodeCache: new Map(),
  lastGeocodeAt: 0,
  geocodeQueue: Promise.resolve(),
  viaPoints: [],
  viaMarkers: [],
  navigationActive: false,
  lastGpsFix: null,
  smoothedSpeedKmh: 0,
  lastVoiceStep: -1,
  wakeLock: null,
  map3d: null,
  map3dLoading: null,
  map3dEnabled: false,
  cameraAnimationFrame: null,
  installPrompt: null,
  toastTimer: null,
};

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 4200);
}

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', kind === 'error');
  elements.status.classList.toggle('loading', kind === 'loading');
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Le service cartographique répond ${response.status}.`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Le service cartographique met trop de temps à répondre.');
    if (error instanceof TypeError) throw new Error('Connexion impossible au service cartographique. Vérifiez Internet puis réessayez.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function geocode(address) {
  if (!address.trim()) throw new Error('Renseignez un départ et une destination.');
  const key = address.trim().toLocaleLowerCase('fr-FR');
  if (state.geocodeCache.has(key)) return state.geocodeCache.get(key);
  const task = state.geocodeQueue.then(async () => {
    if (state.geocodeCache.has(key)) return state.geocodeCache.get(key);
    const wait = Math.max(0, 1100 - (Date.now() - state.lastGeocodeAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const url = new URL(GEOCODER);
    url.search = new URLSearchParams({ q: address.trim(), format: 'jsonv2', limit: '1', addressdetails: '1' });
    state.lastGeocodeAt = Date.now();
    const results = await requestJson(url);
    if (!Array.isArray(results) || results.length === 0) throw new Error(`Adresse introuvable : ${address.trim()}`);
    const point = {
      lat: Number(results[0].lat),
      lon: Number(results[0].lon),
      label: results[0].display_name,
    };
    state.geocodeCache.set(key, point);
    return point;
  });
  state.geocodeQueue = task.catch(() => {});
  return task;
}

function getViaInputs() {
  return [...elements.viaFields.querySelectorAll('[data-via-input]')];
}

function refreshViaControls() {
  const inputs = getViaInputs();
  inputs.forEach((input, index) => {
    input.setAttribute('aria-label', `Étape via ${index + 1}`);
    input.placeholder = `Étape via ${index + 1} (ville ou adresse)`;
    const removeButton = input.closest('.via-row')?.querySelector('[data-remove-via]');
    if (removeButton) removeButton.setAttribute('aria-label', `Supprimer l’étape via ${index + 1}`);
  });
  elements.addVia.disabled = inputs.length >= MAX_VIA_POINTS;
  elements.addVia.textContent = inputs.length >= MAX_VIA_POINTS
    ? `Maximum ${MAX_VIA_POINTS} étapes via`
    : '＋ Ajouter une étape via';
}

function addViaField(value = '') {
  const viaInputs = getViaInputs();
  if (viaInputs.length >= MAX_VIA_POINTS) {
    showToast(`Vous pouvez ajouter jusqu’à ${MAX_VIA_POINTS} étapes via.`);
    return;
  }
  const connector = document.createElement('div');
  connector.className = 'field-connector via-connector';
  connector.setAttribute('aria-hidden', 'true');

  const row = document.createElement('div');
  row.className = 'place-row via-row';
  const marker = document.createElement('span');
  marker.className = 'via-marker';
  marker.textContent = String(viaInputs.length + 1);
  marker.setAttribute('aria-hidden', 'true');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.autocomplete = 'off';
  input.dataset.viaInput = '';
  const remove = document.createElement('button');
  remove.className = 'input-action remove-via';
  remove.type = 'button';
  remove.dataset.removeVia = '';
  remove.title = 'Supprimer cette étape';
  remove.setAttribute('aria-label', `Supprimer l’étape via ${viaInputs.length + 1}`);
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    connector.remove();
    row.remove();
    refreshViaControls();
  });
  row.append(marker, input, remove);
  elements.viaFields.append(connector, row);
  refreshViaControls();
  input.focus();
}

function replaceViaFields(values = []) {
  elements.viaFields.replaceChildren();
  values.slice(0, MAX_VIA_POINTS).forEach((value) => addViaField(value));
  refreshViaControls();
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;
}

function formatDistance(meters) {
  if (settings.units === 'mi') {
    const miles = meters / 1609.344;
    return `${miles >= 10 ? miles.toFixed(0) : miles.toFixed(1)} mi`;
  }
  return meters >= 10000 ? `${(meters / 1000).toFixed(0)} km` : `${(meters / 1000).toFixed(1)} km`;
}

function formatArrival(seconds) {
  const date = new Date(Date.now() + seconds * 1000);
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function routeRoadName(route) {
  const steps = route.legs.flatMap((leg) => leg.steps);
  const namedStep = steps.find((step) => step.name || step.ref);
  return namedStep ? (namedStep.ref ? `${namedStep.ref}${namedStep.name ? ` · ${namedStep.name}` : ''}` : namedStep.name) : 'Itinéraire routier';
}

function routeDescription(route) {
  const steps = route.legs.flatMap((leg) => leg.steps);
  return steps.find((step) => step.name || step.ref || step.destinations);
}

function clearRoutes() {
  state.routeLayers.forEach((layer) => map.removeLayer(layer));
  state.routeLayers = [];
  if (state.startMarker) map.removeLayer(state.startMarker);
  if (state.endMarker) map.removeLayer(state.endMarker);
  state.viaMarkers.forEach((marker) => map.removeLayer(marker));
  state.viaMarkers = [];
  state.startMarker = null;
  state.endMarker = null;
}

function makeEndpointMarker(point, kind) {
  const marker = L.circleMarker([point.lat, point.lon], {
    radius: 8,
    color: '#fff',
    weight: 3,
    fillColor: kind === 'start' ? '#22b573' : '#ec4955',
    fillOpacity: 1,
  });
  marker.bindTooltip(kind === 'start' ? 'Départ' : 'Destination', { direction: 'top', offset: [0, -8] });
  return marker.addTo(map);
}

function chooseRoute(index) {
  if (!state.routes[index]) return;
  state.selectedRoute = index;
  state.routeLayers.forEach((layer, routeIndex) => {
    layer.setStyle({
      color: routeIndex === index ? '#f3cb3e' : '#78a6c9',
      weight: routeIndex === index ? 8 : 5,
      opacity: routeIndex === index ? 1 : 0.62,
    });
    if (routeIndex === index) layer.bringToFront();
  });
  const route = state.routes[index];
  elements.duration.textContent = formatDuration(route.duration);
  elements.distance.textContent = `${formatDistance(route.distance)} · itinéraire ${index + 1} sur ${state.routes.length}`;
  elements.arrival.textContent = formatArrival(route.duration);
  elements.routeName.textContent = routeRoadName(route);
  elements.routeNote.textContent = 'Estimation hors trafic en temps réel';
  elements.startDrive.disabled = false;
  renderRouteSteps(route);
  renderRouteChoices();
  updateNavigationOverlay(route, 0);
  sync3dRoute();
  refineDirectionSign();
}

function renderRouteChoices() {
  elements.options.hidden = state.routes.length === 0;
  elements.routeCount.textContent = `${state.routes.length} ${state.routes.length > 1 ? 'propositions' : 'proposition'} trouvée${state.routes.length > 1 ? 's' : ''}`;
  elements.choiceList.replaceChildren();
  state.routes.forEach((route, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `route-choice${index === state.selectedRoute ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(index === state.selectedRoute));
    const routeName = document.createElement('strong');
    routeName.textContent = `Trajet ${index + 1}`;
    const road = document.createElement('span');
    road.textContent = routeRoadName(route);
    const time = document.createElement('b');
    time.textContent = formatDuration(route.duration);
    const distance = document.createElement('small');
    distance.textContent = formatDistance(route.distance);
    button.append(routeName, road, time, distance);
    button.addEventListener('click', () => chooseRoute(index));
    elements.choiceList.append(button);
  });
}

function routeSteps(route) {
  return route.legs.flatMap((leg) => leg.steps).filter((step) => step.distance > 1);
}

function maneuverInstruction(step) {
  const modifiers = {
    left: 'Tournez à gauche',
    slight_left: 'Restez légèrement à gauche',
    sharp_left: 'Tournez franchement à gauche',
    straight: 'Continuez tout droit',
    slight_right: 'Restez légèrement à droite',
    right: 'Tournez à droite',
    sharp_right: 'Tournez franchement à droite',
    uturn: 'Faites demi-tour',
  };
  const types = {
    depart: 'Démarrez',
    arrive: 'Vous êtes arrivé',
    roundabout: 'Au rond-point',
    rotary: 'Au rond-point',
    merge: 'Rejoignez',
    fork: 'À l’embranchement',
    on_ramp: 'Prenez la bretelle',
    off_ramp: 'Prenez la sortie',
    continue: 'Continuez',
    end_of_road: 'Au bout de la route',
  };
  const action = step.maneuver?.modifier
    ? (modifiers[step.maneuver.modifier] || 'Continuez')
    : (types[step.maneuver?.type] || 'Continuez');
  if (step.maneuver?.type === 'arrive') return action;
  const destination = step.destinations
    ? `vers ${step.destinations}`
    : (step.ref || step.name ? `sur ${step.ref || step.name}` : '');
  return [action, destination].filter(Boolean).join(' ');
}

function renderRouteSteps(route) {
  const steps = routeSteps(route);
  elements.steps.replaceChildren();
  if (steps.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'Le service n’a pas fourni de détail de manœuvre pour cet itinéraire.';
    elements.steps.append(empty);
    return;
  }
  steps.slice(0, 5).forEach((step) => {
    const item = document.createElement('li');
    item.textContent = `${maneuverInstruction(step)} · ${formatDistance(step.distance)}`;
    elements.steps.append(item);
  });
}

function buildRouteLayers(routes, start, end, vias = []) {
  clearRoutes();
  state.routes = routes;
  state.routeLayers = routes.map((route, index) => {
    const coordinates = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    return L.polyline(coordinates, {
      color: index === 0 ? '#f3cb3e' : '#78a6c9',
      weight: index === 0 ? 8 : 5,
      opacity: index === 0 ? 1 : 0.62,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
  });
  state.startMarker = makeEndpointMarker(start, 'start');
  state.endMarker = makeEndpointMarker(end, 'end');
  state.viaMarkers = vias.map((point, index) => {
    const marker = L.circleMarker([point.lat, point.lon], {
      radius: 7,
      color: '#fff',
      weight: 3,
      fillColor: '#2980bd',
      fillOpacity: 1,
    }).addTo(map);
    marker.bindTooltip(`Via ${index + 1} · ${point.label}`, { direction: 'top', offset: [0, -8] });
    return marker;
  });
  const bounds = L.featureGroup(state.routeLayers).getBounds();
  map.fitBounds(bounds, {
    paddingTopLeft: window.innerWidth > 800 ? [420, 170] : [24, 300],
    paddingBottomRight: window.innerWidth > 800 ? [80, 140] : [24, 300],
    maxZoom: 15,
  });
  chooseRoute(0);
  sync3dRoute();
}

async function calculateRoute() {
  const fromText = elements.from.value.trim();
  const toText = elements.to.value.trim();
  const profile = elements.profile.value;
  if (!fromText || !toText) {
    setStatus('Saisissez un départ et une destination.', 'error');
    return;
  }
  const button = document.getElementById('routeBtn');
  button.disabled = true;
  button.classList.add('busy');
  setStatus('Recherche des adresses et calcul des itinéraires…', 'loading');
  try {
    let start;
    if (fromText.toLocaleLowerCase('fr-FR') === 'ma position') {
      if (!state.currentPosition) await locateUser(false);
      if (!state.currentPosition) throw new Error('Position GPS indisponible. Autorisez la localisation ou saisissez une adresse.');
      start = { lat: state.currentPosition.lat, lon: state.currentPosition.lon, label: 'Ma position' };
    } else {
      start = await geocode(fromText);
    }
    const vias = [];
    for (const input of getViaInputs()) {
      const value = input.value.trim();
      if (!value) throw new Error('Complétez ou supprimez chaque étape via avant de calculer le trajet.');
      vias.push(await geocode(value));
    }
    const end = await geocode(toText);
    const points = [start, ...vias, end];
    const coordinates = points.map((point) => `${point.lon},${point.lat}`).join(';');
    const url = new URL(`${ROUTERS[profile]}/${coordinates}`);
    url.search = new URLSearchParams({
      alternatives: '3',
      steps: 'true',
      overview: 'full',
      geometries: 'geojson',
    });
    const result = await requestJson(url);
    if (result.code !== 'Ok' || !result.routes?.length) {
      throw new Error(result.message || 'Aucun itinéraire disponible entre ces deux adresses.');
    }
    stopNavigation();
    buildRouteLayers(result.routes, start, end, vias);
    document.querySelector('.app').classList.add('has-routes');
    const viaNotice = vias.length ? ` via ${vias.map((point) => point.label.split(',')[0]).join(' → ')}` : '';
    setStatus(`${result.routes.length} itinéraire${result.routes.length > 1 ? 's' : ''} calculé${result.routes.length > 1 ? 's' : ''}${viaNotice}. Durées sans trafic en direct.`);
    elements.routeCard.dataset.expanded = 'false';
    elements.sign.hidden = false;
    elements.lanes.hidden = false;
  } catch (error) {
    setStatus(error.message, 'error');
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
}

function nextManeuver(route, stepIndex) {
  const steps = routeSteps(route);
  return steps[Math.min(stepIndex, Math.max(0, steps.length - 1))];
}

function roadSignClass(step) {
  const ref = step?.ref?.trim() || '';
  if (/^A\s?\d/i.test(ref)) return 'sign-motorway';
  if (/^(RN?|N)\s?\d/i.test(ref) || /\b(voie rapide|voie express|rocade)\b/i.test(step?.name || '')) return 'sign-express';
  return 'sign-local';
}

function renderLaneGuidance(step) {
  const intersection = step?.intersections?.find((entry) => Array.isArray(entry.lanes) && entry.lanes.length);
  if (!intersection) {
    elements.laneTrack.innerHTML = '<span class="lane-unknown">Informations de voies non disponibles pour ce carrefour</span>';
    elements.laneCaption.textContent = 'La carte ne fournit pas de marquage de voies pour cette manœuvre.';
    elements.laneRoad.textContent = step?.ref || step?.name || 'Voies';
    return;
  }
  const maneuver = step.maneuver?.modifier || 'straight';
  const arrows = {
    left: '←', slight_left: '↖', sharp_left: '⇖', right: '→', slight_right: '↗',
    sharp_right: '⇗', straight: '↑', uturn: '↶',
  };
  elements.laneTrack.replaceChildren();
  intersection.lanes.forEach((lane) => {
    const laneEl = document.createElement('span');
    const indications = Array.isArray(lane.indications) ? lane.indications : [];
    const isValid = lane.valid === true || indications.includes(maneuver);
    laneEl.className = `lane-arrow${isValid ? ' lane-valid' : ''}`;
    laneEl.textContent = indications.map((item) => arrows[item] || '↑').join(' ') || '↑';
    elements.laneTrack.append(laneEl);
  });
  elements.laneCaption.textContent = `${intersection.lanes.filter((lane) => lane.valid).length} voie(s) conseillée(s) selon les données cartographiques.`;
  elements.laneRoad.textContent = step.ref || step.name || 'Voies';
}

function updateNavigationOverlay(route, stepIndex) {
  const step = nextManeuver(route, stepIndex);
  if (!step) return;
  const action = maneuverInstruction(step);
  elements.signKicker.textContent = roadSignClass(step) === 'sign-motorway' ? 'AUTOROUTE' :
    roadSignClass(step) === 'sign-express' ? 'VOIE RAPIDE' : 'PROCHAINE DIRECTION';
  elements.signPanel.classList.remove('sign-motorway', 'sign-express', 'sign-local');
  elements.signPanel.classList.add(roadSignClass(step));
  elements.signRoad.textContent = step.ref || step.name || action;
  elements.signDestination.textContent = step.destinations || action;
  if (step.maneuver?.exit) {
    elements.signExit.hidden = false;
    elements.signExit.textContent = `SORTIE ${step.maneuver.exit}`;
  } else {
    elements.signExit.hidden = true;
  }
  renderLaneGuidance(step);
  if (settings.voiceGuidance && state.navigationActive && stepIndex !== state.lastVoiceStep) {
    state.lastVoiceStep = stepIndex;
    speakInstruction(action, step);
  }
}

function speakInstruction(action, step) {
  if (!('speechSynthesis' in window)) {
    showToast('La synthèse vocale n’est pas disponible dans ce navigateur.');
    return;
  }
  const distance = Number(step.distance);
  const distanceText = distance >= 1000 ? `dans ${Math.round(distance / 100) / 10} kilomètres` : `dans ${Math.max(20, Math.round(distance / 10) * 10)} mètres`;
  const utterance = new SpeechSynthesisUtterance(`${distanceText}, ${action}.`);
  utterance.lang = 'fr-FR';
  utterance.rate = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function findRoadClass(step) {
  if (!step?.maneuver?.location) return;
  const [lon, lat] = step.maneuver.location;
  const ref = step.ref || '';
  const query = `[out:json][timeout:8];way(around:100,${lat},${lon})["highway"~"^(motorway|motorway_link|trunk|trunk_link)$"];out tags center 12;`;
  try {
    const response = await requestJson(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
    });
    const candidates = response.elements || [];
    const matching = candidates.find((way) => ref && way.tags?.ref?.replace(/\s/g, '').toUpperCase() === ref.replace(/\s/g, '').toUpperCase());
    const highway = matching?.tags?.highway;
    if (highway === 'motorway' || highway === 'motorway_link') return 'sign-motorway';
    if (highway === 'trunk' || highway === 'trunk_link') return 'sign-express';
  } catch {
    // The road sign still uses the route reference if optional road metadata is unavailable.
  }
  return roadSignClass(step);
}

async function refineDirectionSign() {
  const route = state.routes[state.selectedRoute];
  const step = nextManeuver(route, state.navigationActive ? state.currentStepIndex || 0 : 0);
  if (!step) return;
  const roadClass = await findRoadClass(step);
  if (!state.routes[state.selectedRoute] || nextManeuver(state.routes[state.selectedRoute], state.navigationActive ? state.currentStepIndex || 0 : 0) !== step) return;
  elements.signPanel.classList.remove('sign-motorway', 'sign-express', 'sign-local');
  elements.signPanel.classList.add(roadClass);
  elements.signKicker.textContent = roadClass === 'sign-motorway' ? 'AUTOROUTE' :
    roadClass === 'sign-express' ? 'VOIE RAPIDE' : 'PROCHAINE DIRECTION';
}

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (state.map3dLoading) return state.map3dLoading;
  state.map3dLoading = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = MAPLIBRE_CSS;
    document.head.append(link);
    const script = document.createElement('script');
    script.src = MAPLIBRE_SCRIPT;
    script.onload = () => window.maplibregl
      ? resolve(window.maplibregl)
      : reject(new Error('La bibliothèque de carte 3D ne s’est pas chargée.'));
    script.onerror = () => reject(new Error('Impossible de charger la carte 3D. Vérifiez votre connexion Internet.'));
    document.head.append(script);
  }).catch((error) => {
    state.map3dLoading = null;
    throw error;
  });
  return state.map3dLoading;
}

function routeFeatureCollection() {
  return {
    type: 'FeatureCollection',
    features: state.routes.map((route, index) => ({
      type: 'Feature',
      properties: { selected: index === state.selectedRoute },
      geometry: route.geometry,
    })),
  };
}

function sync3dRoute() {
  const renderer = state.map3d;
  if (!renderer?.isStyleLoaded()) return;
  const source = renderer.getSource('trajet-route');
  if (source) source.setData(routeFeatureCollection());
  else add3dRouteLayers(renderer);

  const points = [
    ...state.routes.slice(0, 1).flatMap((route) => [
      { kind: 'start', coordinates: route.geometry.coordinates[0] },
      ...getViaCoordinates(route),
      { kind: 'end', coordinates: route.geometry.coordinates.at(-1) },
    ]),
  ];
  const data = {
    type: 'FeatureCollection',
    features: points.filter((point) => point.coordinates).map((point) => ({
      type: 'Feature',
      properties: { kind: point.kind },
      geometry: { type: 'Point', coordinates: point.coordinates },
    })),
  };
  if (state.currentPosition) {
    data.features.push({
      type: 'Feature',
      properties: { kind: 'user' },
      geometry: { type: 'Point', coordinates: [state.currentPosition.lon, state.currentPosition.lat] },
    });
  }
  const endpointSource = renderer.getSource('trajet-points');
  if (endpointSource) endpointSource.setData(data);
  else {
    renderer.addSource('trajet-points', { type: 'geojson', data });
    renderer.addLayer({
      id: 'trajet-points-layer',
      type: 'circle',
      source: 'trajet-points',
      paint: {
        'circle-radius': 7,
        'circle-color': ['match', ['get', 'kind'], 'start', '#22b573', 'end', '#ec4955', 'via', '#2980bd', 'user', '#3289ef', '#fff'],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
  }
}

function getViaCoordinates(route) {
  if (!state.viaMarkers.length || !route.legs) return [];
  return state.viaMarkers.map((marker) => {
    const point = marker.getLatLng();
    return { kind: 'via', coordinates: [point.lng, point.lat] };
  });
}

function add3dRouteLayers(renderer) {
  renderer.addSource('trajet-route', { type: 'geojson', data: routeFeatureCollection() });
  renderer.addLayer({
    id: 'trajet-route-alternatives',
    type: 'line',
    source: 'trajet-route',
    filter: ['!=', ['get', 'selected'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#4384ae', 'line-width': 5, 'line-opacity': 0.78 },
  });
  renderer.addLayer({
    id: 'trajet-route-selected',
    type: 'line',
    source: 'trajet-route',
    filter: ['==', ['get', 'selected'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f3cb3e', 'line-width': 7, 'line-opacity': 1 },
  });
}

async function setMap3d(enabled, { silent = false } = {}) {
  const button = document.getElementById('mapModeBtn');
  if (!enabled) {
    state.map3dEnabled = false;
    document.querySelector('.app').classList.remove('map-is-3d');
    button.setAttribute('aria-pressed', 'false');
    button.textContent = '3D';
    button.title = 'Activer la vue 3D';
    if (state.map3d) {
      const center = state.map3d.getCenter();
      map.setView([center.lat, center.lng], Math.min(state.map3d.getZoom(), 19), { animate: false });
    }
    map.invalidateSize();
    if (!silent) showToast('Carte 2D activée.');
    return;
  }

  button.disabled = true;
  try {
    const maplibregl = await loadMapLibre();
    if (!state.map3d) {
      const center = map.getCenter();
      state.map3d = new maplibregl.Map({
        container: 'map3d',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [center.lng, center.lat],
        zoom: Math.min(map.getZoom(), 16),
        pitch: 58,
        bearing: 0,
        maxPitch: 70,
        attributionControl: false,
        cooperativeGestures: true,
        canvasContextAttributes: { antialias: true },
      });
      state.map3d.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      await new Promise((resolve, reject) => {
        state.map3d.once('load', resolve);
        state.map3d.once('error', (event) => reject(event.error || new Error('La carte 3D ne peut pas être affichée.')));
      });
      add3dRouteLayers(state.map3d);
      state.map3d.on('moveend', () => {
        if (!state.map3dEnabled) return;
        const center3d = state.map3d.getCenter();
        map.setView([center3d.lat, center3d.lng], Math.min(state.map3d.getZoom(), 19), { animate: false });
      });
    } else {
      const center = map.getCenter();
      state.map3d.jumpTo({ center: [center.lng, center.lat], zoom: Math.min(map.getZoom(), 16), pitch: 58 });
    }
    state.map3d.resize();
    sync3dRoute();
    state.map3dEnabled = true;
    document.querySelector('.app').classList.add('map-is-3d');
    button.setAttribute('aria-pressed', 'true');
    button.textContent = '2D';
    button.title = 'Revenir à la carte 2D';
    if (!silent) showToast('Vue 3D cartographique activée.');
  } catch (error) {
    state.map3dEnabled = false;
    if (state.map3d) {
      state.map3d.remove();
      state.map3d = null;
    }
    document.querySelector('.app').classList.remove('map-is-3d');
    button.setAttribute('aria-pressed', 'false');
    button.textContent = '3D';
    button.disabled = false;
    if (!silent) showToast(error.message);
    return;
  } finally {
    button.disabled = false;
    map.invalidateSize();
  }
}

function setCurrentPosition(position) {
  const latlng = [position.coords.latitude, position.coords.longitude];
  const now = position.timestamp || Date.now();
  let speedKmh = Number.isFinite(position.coords.speed) ? Math.max(0, position.coords.speed * 3.6) : null;
  const previousFix = state.lastGpsFix;
  if (speedKmh === null && previousFix && now > previousFix.timestamp) {
    speedKmh = map.distance(previousFix.latlng, latlng) / ((now - previousFix.timestamp) / 1000) * 3.6;
  }
  if (speedKmh !== null && Number.isFinite(speedKmh) && speedKmh < 250) {
    state.smoothedSpeedKmh = state.lastGpsFix
      ? state.smoothedSpeedKmh * 0.65 + speedKmh * 0.35
      : speedKmh;
  }
  state.lastGpsFix = { latlng, timestamp: now };
  state.currentPosition = { lat: latlng[0], lon: latlng[1], lng: latlng[1] };
  if (!state.userMarker) {
    state.userMarker = L.circleMarker(latlng, {
      radius: 9, color: '#fff', weight: 3, fillColor: '#3289ef', fillOpacity: 1,
    }).addTo(map).bindTooltip('Votre position');
  } else {
    state.userMarker.setLatLng(latlng);
  }
  sync3dRoute();
  if (state.navigationActive) {
    advanceGuidance(latlng);
    adaptNavigationCamera(position, latlng);
    updateNearbyServices(latlng);
  }
}

function upcomingManeuverDistance(latlng, route) {
  const steps = routeSteps(route);
  const currentIndex = state.currentStepIndex || 0;
  const nextIndex = Math.min(currentIndex + 1, steps.length - 1);
  const next = steps[nextIndex];
  if (!next?.maneuver?.location) return Infinity;
  const [lon, lat] = next.maneuver.location;
  return map.distance(latlng, [lat, lon]);
}

function adaptNavigationCamera(position, latlng) {
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  const speed = state.smoothedSpeedKmh;
  const maneuverDistance = upcomingManeuverDistance(latlng, route);
  const upcomingStep = routeSteps(route)[Math.min((state.currentStepIndex || 0) + 1, routeSteps(route).length - 1)];
  const isRoundabout = upcomingStep?.maneuver?.type === 'roundabout' ||
    upcomingStep?.maneuver?.type === 'rotary';
  const zoom = isRoundabout && maneuverDistance < 800 ? 17.5 :
    speed < 12 ? 18 :
      speed < 35 ? 17 :
        speed < 70 ? 16 : 15;

  if (state.map3dEnabled && state.map3d) {
    const camera = { center: [latlng[1], latlng[0]] };
    if (settings.adaptiveZoom) camera.zoom = Math.min(zoom, isRoundabout && maneuverDistance < 800 ? 17.5 : 17);
    if (settings.followHeading && Number.isFinite(position.coords.heading) && speed > 8) {
      camera.bearing = position.coords.heading;
    }
    camera.pitch = 58;
    camera.duration = 850;
    state.map3d.easeTo(camera);
    return;
  }
  if (settings.adaptiveZoom && Math.abs(map.getZoom() - zoom) >= 0.5) {
    map.setView(latlng, zoom, { animate: true, duration: 0.7 });
  } else if (map.getCenter().distanceTo(L.latLng(latlng)) > 80) {
    map.panTo(latlng, { animate: true, duration: 0.65 });
  }
}

function locateUser(center = true) {
  if (!('geolocation' in navigator)) {
    const error = new Error('La géolocalisation n’est pas disponible dans ce navigateur.');
    showToast(error.message);
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((position) => {
      setCurrentPosition(position);
      if (center) map.setView([position.coords.latitude, position.coords.longitude], 16);
      resolve(state.currentPosition);
    }, (error) => {
      const message = error.code === error.PERMISSION_DENIED
        ? 'Autorisez la localisation dans les réglages du navigateur.'
        : 'Position indisponible. Vérifiez le GPS et réessayez.';
      showToast(message);
      reject(new Error(message));
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
  });
}

function nearestStepIndex(route, latlng) {
  const steps = routeSteps(route);
  let closestIndex = 0;
  let closestDistance = Infinity;
  steps.forEach((step, index) => {
    const location = step.maneuver?.location;
    if (!location) return;
    const distance = map.distance(latlng, [location[1], location[0]]);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function advanceGuidance(latlng) {
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  const stepIndex = nearestStepIndex(route, latlng);
  state.currentStepIndex = stepIndex;
  updateNavigationOverlay(route, stepIndex);
  if (stepIndex === routeSteps(route).length - 1) {
    showToast('Vous approchez de votre destination.');
  }
}

function stopNavigation() {
  if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
  state.navigationActive = false;
  state.lastGpsFix = null;
  state.lastVoiceStep = -1;
  document.querySelector('.app').classList.remove('is-navigating');
  elements.nearby.hidden = true;
  state.currentStepIndex = 0;
  elements.startDrive.querySelector('span').textContent = 'Partir';
  elements.startDrive.classList.remove('active');
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  releaseWakeLock();
}

function toggleNavigation() {
  if (!state.routes.length) return;
  if (state.navigationActive) {
    stopNavigation();
    showToast('Guidage arrêté.');
    return;
  }
  if (!navigator.geolocation) {
    showToast('La géolocalisation n’est pas disponible dans ce navigateur.');
    return;
  }
  state.navigationActive = true;
  document.querySelector('.app').classList.add('is-navigating');
  elements.nearby.hidden = false;
  elements.startDrive.querySelector('span').textContent = 'Arrêter';
  elements.startDrive.classList.add('active');
  state.gpsWatch = navigator.geolocation.watchPosition(setCurrentPosition, (error) => {
    stopNavigation();
    showToast(error.code === error.PERMISSION_DENIED
      ? 'Autorisez la localisation pour démarrer le guidage.'
      : 'Position GPS indisponible : guidage arrêté.');
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  acquireWakeLock();
  elements.routeCard.dataset.expanded = 'false';
  showToast('Guidage GPS activé. Gardez les yeux sur la route.');
}

const SERVICES_RADIUS_M = 20000;
const SERVICES_REFRESH_M = 3000;
const SERVICES_REFRESH_MS = 5 * 60 * 1000;
const nearbyServices = { fuel: [], rest: [], origin: null, fetchedAt: 0, loading: false };

function nearestService(points, latlng) {
  let best = null;
  points.forEach((point) => {
    const distance = map.distance(latlng, point);
    if (!best || distance < best.distance) best = { point, distance };
  });
  return best;
}

function renderNearbyServices(latlng) {
  const fuel = nearestService(nearbyServices.fuel, latlng);
  const rest = nearestService(nearbyServices.rest, latlng);
  elements.nearbyFuel.textContent = fuel ? formatDistance(fuel.distance) : `Aucune dans ${SERVICES_RADIUS_M / 1000} km`;
  elements.nearbyRest.textContent = rest ? formatDistance(rest.distance) : `Aucune dans ${SERVICES_RADIUS_M / 1000} km`;
}

async function fetchNearbyServices(latlng) {
  const [lat, lon] = latlng;
  const around = `(around:${SERVICES_RADIUS_M},${lat},${lon})`;
  const restSelector = '["highway"~"^(rest_area|services)$"]';
  const query = `[out:json][timeout:20];(node["amenity"="fuel"]${around};way["amenity"="fuel"]${around};node${restSelector}${around};way${restSelector}${around};);out center 300;`;
  nearbyServices.loading = true;
  try {
    const data = await requestJson(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
    });
    nearbyServices.fuel = [];
    nearbyServices.rest = [];
    (data.elements || []).forEach((element) => {
      const pointLat = element.lat ?? element.center?.lat;
      const pointLon = element.lon ?? element.center?.lon;
      if (!Number.isFinite(pointLat) || !Number.isFinite(pointLon)) return;
      const target = element.tags?.amenity === 'fuel' ? nearbyServices.fuel : nearbyServices.rest;
      target.push([pointLat, pointLon]);
    });
  } catch (error) {
    console.error('Services à proximité indisponibles :', error);
  } finally {
    nearbyServices.origin = latlng;
    nearbyServices.fetchedAt = Date.now();
    nearbyServices.loading = false;
  }
}

async function updateNearbyServices(latlng) {
  const { origin, fetchedAt, loading } = nearbyServices;
  const stale = !origin || map.distance(origin, latlng) > SERVICES_REFRESH_M || Date.now() - fetchedAt > SERVICES_REFRESH_MS;
  if (stale && !loading) await fetchNearbyServices(latlng);
  renderNearbyServices(latlng);
}

const poiDefinitions = {
  fuel: { label: 'Station-service', selector: '["amenity"="fuel"]', icon: '⛽', className: 'poi-fuel' },
  signals: { label: 'Feu de circulation', selector: '["highway"="traffic_signals"]', icon: '🚦', className: 'poi-signal' },
  cameras: { label: 'Radar cartographié', selector: '["highway"="speed_camera"]', extraSelector: '["enforcement"="maxspeed"]', icon: '◉', className: 'poi-camera' },
};

function poiMarker(point, definition) {
  const html = `<span class="poi-marker ${definition.className}">${definition.icon}</span>`;
  const marker = L.marker(point, {
    icon: L.divIcon({ className: 'poi-icon', html, iconSize: [34, 34], iconAnchor: [17, 17] }),
    keyboard: true,
    title: definition.label,
  });
  const name = point.tags?.name || definition.label;
  marker.bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(definition.label)}`);
  return marker;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function loadVisiblePois() {
  if (state.poiEnabled.size === 0) return;
  const bounds = map.getBounds();
  const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
  const selectors = [...state.poiEnabled].map((key) => {
    const definition = poiDefinitions[key];
    const selectorsForType = [definition.selector, definition.extraSelector].filter(Boolean);
    return selectorsForType.map((selector) => `node${selector}(${bbox});way${selector}(${bbox});`).join('');
  }).join('');
  const query = `[out:json][timeout:15];(${selectors});out center 200;`;
  const enabled = new Set(state.poiEnabled);
  try {
    const data = await requestJson(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
    });
    enabled.forEach((key) => {
      const layer = state.poiLayers.get(key);
      if (layer) layer.clearLayers();
    });
    (data.elements || []).forEach((element) => {
      const tags = element.tags || {};
      let key;
      if (tags.amenity === 'fuel') key = 'fuel';
      else if (tags.highway === 'traffic_signals') key = 'signals';
      else if (tags.highway === 'speed_camera' || tags.enforcement === 'maxspeed') key = 'cameras';
      if (!key || !enabled.has(key)) return;
      const lat = element.lat ?? element.center?.lat;
      const lon = element.lon ?? element.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      state.poiLayers.get(key).addLayer(poiMarker([lat, lon], { ...poiDefinitions[key], tags }));
    });
    showToast(`${data.elements?.length || 0} point(s) cartographié(s) dans la zone affichée.`);
  } catch (error) {
    showToast(`Points d’intérêt indisponibles : ${error.message}`);
  }
}

function togglePoi(key, button) {
  const layer = state.poiLayers.get(key);
  if (!layer) return;
  if (state.poiEnabled.has(key)) {
    state.poiEnabled.delete(key);
    map.removeLayer(layer);
    button.setAttribute('aria-pressed', 'false');
  } else {
    state.poiEnabled.add(key);
    layer.addTo(map);
    button.setAttribute('aria-pressed', 'true');
    loadVisiblePois();
  }
}

function saveCurrentRoute() {
  const route = state.routes[state.selectedRoute];
  if (!route) return showToast('Calculez d’abord un itinéraire.');
  const saved = JSON.parse(localStorage.getItem('trajetwaze_saved') || '[]');
  const trip = {
    from: elements.from.value.trim(),
    to: elements.to.value.trim(),
    vias: getViaInputs().map((input) => input.value.trim()),
    profile: elements.profile.value,
  };
  if (!saved.some((item) => item.from === trip.from && item.to === trip.to &&
    JSON.stringify(item.vias || []) === JSON.stringify(trip.vias) && item.profile === trip.profile)) {
    saved.unshift(trip);
    localStorage.setItem('trajetwaze_saved', JSON.stringify(saved.slice(0, 20)));
  }
  document.getElementById('saveRouteBtn').textContent = '★';
  showToast('Trajet enregistré dans vos favoris.');
}

function showSavedRoutes() {
  const list = document.getElementById('savedRoutesList');
  list.replaceChildren();
  const saved = JSON.parse(localStorage.getItem('trajetwaze_saved') || '[]');
  if (saved.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Aucun favori pour le moment. Enregistrez un trajet calculé.';
    list.append(empty);
  }
  saved.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-route';
    button.textContent = [item.from, ...(item.vias || []).map((via) => `via ${via}`), item.to].join(' → ');
    button.addEventListener('click', () => {
      elements.from.value = item.from;
      elements.to.value = item.to;
      elements.profile.value = item.profile || 'driving';
      replaceViaFields(item.vias || []);
      document.getElementById('savedDialog').close();
      calculateRoute();
    });
    list.append(button);
  });
  document.getElementById('savedDialog').showModal();
}

async function shareRoute() {
  const route = state.routes[state.selectedRoute];
  const shareData = {
    title: 'Mon trajet GPS',
    text: [elements.from.value, ...getViaInputs().map((input) => `via ${input.value.trim()}`).filter((via) => via !== 'via'), elements.to.value].join(' → ') +
      (route ? ` · ${formatDistance(route.distance)} · ${formatDuration(route.duration)}` : ''),
    url: location.href,
  };
  try {
    if (navigator.share) await navigator.share(shareData);
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${shareData.text} — ${shareData.url}`);
      showToast('Lien du trajet copié.');
    } else {
      showToast('Le partage n’est pas pris en charge par ce navigateur.');
    }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Impossible de partager ce trajet.');
  }
}

async function confirmReport(event) {
  if (event.submitter?.value !== 'confirm') return;
  event.preventDefault();
  const type = document.getElementById('reportType').value;
  const description = document.getElementById('reportDescription').value.trim();
  const labels = { hazard: 'Danger signalé', work: 'Travaux signalés', incident: 'Incident signalé' };
  const center = map.getCenter();
  const marker = L.circleMarker(center, {
    radius: 9, color: '#fff', weight: 2,
    fillColor: type === 'work' ? '#e6ae25' : type === 'incident' ? '#df4951' : '#ce7851',
    fillOpacity: 1,
  }).addTo(state.userReports);
  const report = `${labels[type]}${description ? ` : ${description}` : ''}`;
  marker.bindPopup(`<strong>${escapeHtml(report)}</strong><br>Signalement local à cet appareil.`);
  document.getElementById('reportDialog').close();
  document.getElementById('reportDescription').value = '';
  showToast('Signalement ajouté à votre carte uniquement.');
}

function toggleSheet() {
  const expanded = elements.routeCard.dataset.expanded === 'true';
  elements.routeCard.dataset.expanded = String(!expanded);
  document.getElementById('sheetToggle').setAttribute('aria-label', expanded ? 'Afficher le résumé' : 'Afficher le détail du trajet');
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    showToast(`Impossible d’enregistrer les paramètres : ${error.message}`);
  }
}

function applySettingsToControls() {
  document.getElementById('unitsSetting').value = settings.units;
  document.getElementById('mapStyleSetting').value = settings.mapStyle;
  document.getElementById('tomtomKeySetting').value = getTomTomKey();
  document.getElementById('autoZoomSetting').checked = settings.adaptiveZoom;
  document.getElementById('headingSetting').checked = settings.followHeading;
  document.getElementById('voiceSetting').checked = settings.voiceGuidance;
  document.getElementById('wakeLockSetting').checked = settings.wakeLock;
  document.getElementById('default3dSetting').checked = settings.default3d;
}

const TOMTOM_STYLES = { tomtom: 'main', 'tomtom-night': 'night' };
const TOMTOM_KEY_STORAGE = 'gps_tomtom_key';
let tomtomLayer = null;
let tomtomErrors = 0;

function getTomTomKey() {
  try {
    return localStorage.getItem(TOMTOM_KEY_STORAGE) || '';
  } catch (error) {
    return '';
  }
}

function setTomTomKey(key) {
  try {
    if (key.trim()) localStorage.setItem(TOMTOM_KEY_STORAGE, key.trim());
    else localStorage.removeItem(TOMTOM_KEY_STORAGE);
  } catch (error) {
    showToast(`Impossible d’enregistrer la clé TomTom : ${error.message}`);
  }
}

function makeTomTomLayer(style, key) {
  const layer = L.tileLayer(`https://api.tomtom.com/map/1/tile/basic/${style}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}&tileSize=512&language=fr-FR`, {
    maxZoom: 19,
    maxNativeZoom: 20,
    attribution: '© <a href="https://www.tomtom.com/">TomTom</a>',
  });
  layer.on('tileload', () => { tomtomErrors = 0; });
  layer.on('tileerror', () => {
    // Clé refusée ou quota épuisé : les tuiles échouent toutes. Une tuile isolée ne suffit pas.
    if (++tomtomErrors < 6 || tomtomLayer !== layer) return;
    tomtomLayer = null;
    map.removeLayer(layer);
    setMapStyle('standard', { keepChoice: true });
    showToast('Fond TomTom refusé (clé ou quota). Retour sur OpenStreetMap.');
  });
  return layer;
}

function setMapStyle(style, { keepChoice = false } = {}) {
  const wantsTomTom = Object.hasOwn(TOMTOM_STYLES, style);
  const key = wantsTomTom ? getTomTomKey() : '';
  if (wantsTomTom && !key) showToast('Ajoutez votre clé TomTom dans les paramètres pour afficher ce fond.');
  if (!keepChoice) settings.mapStyle = style === 'dark' || (wantsTomTom && key) ? style : 'standard';
  if (tomtomLayer) {
    map.removeLayer(tomtomLayer);
    tomtomLayer = null;
  }
  if (wantsTomTom && key) {
    tomtomErrors = 0;
    tomtomLayer = makeTomTomLayer(TOMTOM_STYLES[style], key);
    [lightTiles, lightFallbackTiles].forEach((layer) => { if (map.hasLayer(layer)) map.removeLayer(layer); });
    tomtomLayer.addTo(map);
  } else {
    const lightLayer = lightTilesFallbackActive ? lightFallbackTiles : lightTiles;
    const inactive = lightLayer === lightTiles ? lightFallbackTiles : lightTiles;
    if (map.hasLayer(inactive)) map.removeLayer(inactive);
    if (!map.hasLayer(lightLayer)) lightLayer.addTo(map);
  }
  document.querySelector('.app').classList.toggle('map-theme-dark', settings.mapStyle === 'dark');
  document.getElementById('mapStyleSetting').value = settings.mapStyle;
  saveSettings();
}

function openSettings() {
  applySettingsToControls();
  elements.settingsDialog.showModal();
}

function handleSettingChange(event) {
  if (event.target.id === 'tomtomKeySetting') {
    setTomTomKey(event.target.value);
    if (settings.mapStyle.startsWith('tomtom')) setMapStyle(settings.mapStyle);
    return;
  }
  const settingById = {
    unitsSetting: ['units', event.target.value],
    mapStyleSetting: ['mapStyle', event.target.value],
    autoZoomSetting: ['adaptiveZoom', event.target.checked],
    headingSetting: ['followHeading', event.target.checked],
    voiceSetting: ['voiceGuidance', event.target.checked],
    wakeLockSetting: ['wakeLock', event.target.checked],
    default3dSetting: ['default3d', event.target.checked],
  };
  const setting = settingById[event.target.id];
  if (!setting) return;
  [settings[setting[0]]] = [setting[1]];
  if (event.target.id === 'mapStyleSetting') setMapStyle(event.target.value);
  else saveSettings();
  if (event.target.id === 'default3dSetting' && settings.default3d) {
    setMap3d(true);
  } else if (event.target.id === 'default3dSetting' && !settings.default3d && state.map3dEnabled) {
    setMap3d(false);
  }
  if (event.target.id === 'wakeLockSetting' && state.navigationActive) {
    if (settings.wakeLock) acquireWakeLock();
    else releaseWakeLock();
  }
  if (event.target.id === 'unitsSetting' && state.routes.length) chooseRoute(state.selectedRoute);
}

async function acquireWakeLock() {
  if (!settings.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    }, { once: true });
  } catch (error) {
    state.wakeLock = null;
    showToast(`L’écran ne peut pas rester allumé : ${error.message}`);
  }
}

async function releaseWakeLock() {
  if (!state.wakeLock) return;
  const lock = state.wakeLock;
  state.wakeLock = null;
  await lock.release();
}

function showUpdateBanner() {
  if (document.querySelector('.update-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `<span>Nouvelle version disponible (${APP_VERSION}).</span><button type="button">Mettre à jour</button>`;
  banner.querySelector('button').addEventListener('click', () => location.reload());
  document.querySelector('.app').appendChild(banner);
}

function installServiceWorker() {
  document.getElementById('appVersion').textContent = `Version ${APP_VERSION}`;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./service-worker.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
    }).catch((error) => {
      console.error('Enregistrement hors ligne impossible :', error);
    });
  }
}

document.getElementById('routeBtn').addEventListener('click', calculateRoute);
elements.addVia.addEventListener('click', () => addViaField());
document.getElementById('swapBtn').addEventListener('click', () => {
  const previous = elements.from.value;
  elements.from.value = elements.to.value;
  elements.to.value = previous;
  const viaValues = getViaInputs().map((input) => input.value).reverse();
  replaceViaFields(viaValues);
});
document.getElementById('locateBtn').addEventListener('click', () => {
  elements.from.value = 'Ma position';
  locateUser(false).catch((error) => console.error('Localisation impossible :', error));
});
document.getElementById('recenterBtn').addEventListener('click', () => {
  locateUser(true).catch((error) => console.error('Recentrage GPS impossible :', error));
});
document.getElementById('startDriveBtn').addEventListener('click', toggleNavigation);
document.getElementById('sheetToggle').addEventListener('click', toggleSheet);
document.getElementById('saveRouteBtn').addEventListener('click', saveCurrentRoute);
document.getElementById('savedRoutesBtn').addEventListener('click', showSavedRoutes);
document.getElementById('shareBtn').addEventListener('click', shareRoute);
document.getElementById('reportBtn').addEventListener('click', () => document.getElementById('reportDialog').showModal());
document.getElementById('reportForm').addEventListener('submit', confirmReport);
document.querySelectorAll('.poi-tool').forEach((button) => {
  const layer = L.layerGroup();
  state.poiLayers.set(button.dataset.layer, layer);
  button.addEventListener('click', () => togglePoi(button.dataset.layer, button));
});
document.getElementById('layersBtn').addEventListener('click', (event) => {
  const open = !document.getElementById('poiTools').classList.contains('is-open');
  document.getElementById('poiTools').classList.toggle('is-open', open);
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
const menuDialog = document.getElementById('menuDialog');
document.getElementById('menuBtn').addEventListener('click', () => {
  document.getElementById('menuAideTexte').hidden = true;
  menuDialog.showModal();
});
document.getElementById('menuFavoris').addEventListener('click', () => {
  menuDialog.close();
  showSavedRoutes();
});
document.getElementById('menuReglages').addEventListener('click', () => {
  menuDialog.close();
  openSettings();
});
document.getElementById('menuCles').addEventListener('click', () => {
  menuDialog.close();
  openSettings();
  document.getElementById('tomtomKeySetting').focus();
});
document.getElementById('menuAide').addEventListener('click', () => {
  const help = document.getElementById('menuAideTexte');
  help.hidden = !help.hidden;
});
document.getElementById('mapModeBtn').addEventListener('click', () => setMap3d(!state.map3dEnabled));
elements.settingsDialog.querySelectorAll('#unitsSetting, #mapStyleSetting, #tomtomKeySetting, #autoZoomSetting, #headingSetting, #voiceSetting, #wakeLockSetting, #default3dSetting')
  .forEach((input) => input.addEventListener('change', handleSettingChange));
document.querySelector('.nav-item[data-action="map"]').addEventListener('click', () => map.setView(map.getCenter(), map.getZoom()));
document.getElementById('profileSelect').addEventListener('change', () => {
  const label = PROFILE_LABELS[elements.profile.value];
  setStatus(`Mode ${label} sélectionné. Calculez le trajet pour actualiser les propositions.`);
});
map.on('moveend', () => {
  if (state.poiEnabled.size) loadVisiblePois();
});
map.on('click', (event) => {
  if (!state.navigationActive) return;
  const destination = elements.to.value.trim();
  showToast(`Carte centrée près de ${event.latlng.lat.toFixed(4)}, ${event.latlng.lng.toFixed(4)} · Destination : ${destination}`);
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  const button = document.getElementById('installBtn');
  button.hidden = false;
  button.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt();
    state.installPrompt = null;
    button.hidden = true;
  }, { once: true });
});
window.addEventListener('appinstalled', () => showToast('GPS est installé.'));
window.addEventListener('resize', () => map.invalidateSize());
installServiceWorker();
applySettingsToControls();
setMapStyle(settings.mapStyle);
if (settings.default3d) setMap3d(true, { silent: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.navigationActive && settings.wakeLock) acquireWakeLock();
});
