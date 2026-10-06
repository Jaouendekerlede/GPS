// Graphique « batterie prévue / réelle » le long du trajet (navigation).
// Une seule échelle (% de batterie), lignes fines, légende et valeurs au
// toucher (voir navigation.js). Module sans écran : testé à part.

const L = 340;
const H = 176;
const X0 = 36;
const X1 = 328;
const Y0 = 14;
const Y1 = 146;

export function echelle(maxKm) {
  const km = Math.max(1, maxKm);
  return { x: (v) => X0 + (Math.max(0, v) / km) * (X1 - X0), y: (p) => Y1 - (Math.max(0, Math.min(100, p)) / 100) * (Y1 - Y0), km, X0, X1 };
}

// Batterie prévue au km donné (interpolée entre les points du plan).
export function pctPrevuA(prevus, km) {
  if (!prevus.length) return null;
  if (km <= prevus[0].km) return prevus[0].pct;
  for (let i = 1; i < prevus.length; i++) {
    const [a, b] = [prevus[i - 1], prevus[i]];
    if (km <= b.km) return b.km > a.km ? a.pct + ((b.pct - a.pct) * (km - a.km)) / (b.km - a.km) : b.pct;
  }
  return prevus[prevus.length - 1].pct;
}

// prevus / reels : [{ km, pct }] ; bornes : [{ km, nom }] ; kmActuel.
export function svgBatterie(prevus, reels, bornes, kmActuel) {
  const maxKm = Math.max(...prevus.map((p) => p.km), ...reels.map((p) => p.km), kmActuel, 1);
  const e = echelle(maxKm);
  const ligne = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${e.x(p.km).toFixed(1)} ${e.y(p.pct).toFixed(1)}`).join(" ");
  const grille = [0, 50, 100].map((p) => `<line x1="${X0}" x2="${X1}" y1="${e.y(p)}" y2="${e.y(p)}" class="grille"/><text x="${X0 - 6}" y="${e.y(p) + 4}" text-anchor="end" class="axe">${p}${p ? " %" : ""}</text>`).join("");
  const axeX = [0, maxKm / 2, maxKm].map((k, i) => `<text x="${e.x(k)}" y="${H - 8}" text-anchor="${["start", "middle", "end"][i]}" class="axe">${Math.round(k)}${i === 2 ? " km" : ""}</text>`).join("");
  const reperes = bornes.map((b) => `<line x1="${e.x(b.km)}" x2="${e.x(b.km)}" y1="${Y0}" y2="${Y1}" class="borne"/><text x="${e.x(b.km)}" y="${Y0 - 2}" text-anchor="middle" font-size="11">🔋</text>`).join("");
  const maintenant = `<line x1="${e.x(kmActuel)}" x2="${e.x(kmActuel)}" y1="${Y0}" y2="${Y1}" class="maintenant"/>`;
  const points = reels.map((p) => `<circle cx="${e.x(p.km).toFixed(1)}" cy="${e.y(p.pct).toFixed(1)}" r="4.5" class="point-reel"/>`).join("");
  return `<svg viewBox="0 0 ${L} ${H}" role="img" aria-label="Batterie prévue et réelle le long du trajet" data-max-km="${maxKm}">
    ${grille}${axeX}${reperes}${maintenant}
    <path d="${ligne(prevus)}" class="prevue"/>
    ${reels.length > 1 ? `<path d="${ligne(reels)}" class="reelle"/>` : ""}${points}
    <line class="curseur" x1="0" x2="0" y1="${Y0}" y2="${Y1}" visibility="hidden"/>
    <rect x="${X0}" y="0" width="${X1 - X0}" height="${H}" fill="transparent" class="zone-toucher"/>
  </svg>`;
}

// Tableau des valeurs (lecture sans le graphique).
export function tableauBatterie(prevus, reels) {
  const lignes = [
    ...prevus.map((p) => ({ km: p.km, prevue: p.pct, reelle: null })),
    ...reels.map((p) => ({ km: p.km, prevue: pctPrevuA(prevus, p.km), reelle: p.pct })),
  ].sort((a, b) => a.km - b.km);
  const cel = (v) => (v == null ? "—" : `${Math.round(v)} %`);
  return `<table class="ev-batt-table"><thead><tr><th>km</th><th>Prévue</th><th>Réelle</th></tr></thead><tbody>${lignes.map((l) => `<tr><td>${Math.round(l.km)}</td><td>${cel(l.prevue)}</td><td>${cel(l.reelle)}</td></tr>`).join("")}</tbody></table>`;
}
