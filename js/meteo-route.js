// Météo devant soi pendant la navigation (Open-Meteo, gratuit, sans clé) :
// orage, neige, verglas, forte pluie, vent fort, brouillard, à l'heure où
// l'on passera à chaque point.

// Mesures d'une heure → alerte { type, texte, voix } ou null (la plus grave).
export function alerteMeteo({ precip = 0, code = 0, rafales = 0, temp = 10 } = {}) {
  if (code >= 95) return { type: "orage", texte: "⛈️ Orage", voix: "Orage annoncé" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { type: "neige", texte: "❄️ Neige", voix: "Neige annoncée" };
  if ([56, 57, 66, 67].includes(code) || (temp <= 1 && precip > 0)) return { type: "verglas", texte: "🧊 Risque de verglas", voix: "Risque de verglas" };
  if (precip >= 4) return { type: "pluie", texte: "🌧️ Forte pluie", voix: "Forte pluie annoncée" };
  if (rafales >= 70) return { type: "vent", texte: `💨 Vent fort (rafales ${Math.round(rafales)} km/h)`, voix: "Vent fort annoncé" };
  if (code === 45 || code === 48) return { type: "brouillard", texte: "🌫️ Brouillard", voix: "Brouillard annoncé" };
  return null;
}

// Heure la plus proche de `cibleS` (secondes Unix) dans la réponse horaire.
export function mesuresA(hourly, cibleS) {
  const t = hourly?.time || [];
  if (!t.length) return null;
  let i = 0;
  for (let k = 1; k < t.length; k++) if (Math.abs(t[k] - cibleS) < Math.abs(t[i] - cibleS)) i = k;
  return { precip: hourly.precipitation?.[i] ?? 0, code: hourly.weather_code?.[i] ?? 0, rafales: hourly.wind_gusts_10m?.[i] ?? 0, temp: hourly.temperature_2m?.[i] ?? 10 };
}

// points : [{ lat, lon, quandS }] → mesures à l'heure de passage (ou null).
export async function meteoDesPoints(points) {
  if (!points.length) return null;
  const p = new URLSearchParams({
    latitude: points.map((x) => x.lat.toFixed(3)).join(","),
    longitude: points.map((x) => x.lon.toFixed(3)).join(","),
    hourly: "temperature_2m,precipitation,weather_code,wind_gusts_10m",
    forecast_days: "2",
    timeformat: "unixtime",
    timezone: "GMT",
  });
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
    if (!r.ok) return null;
    const j = await r.json();
    const liste = Array.isArray(j) ? j : [j];
    return points.map((x, i) => mesuresA(liste[i]?.hourly, x.quandS));
  } catch {
    return null;
  }
}
