// Courbes au kilomètre du trajet (Chart.js) : batterie + relief, vitesse +
// consommation, météo (température, vent de face, pluie).

let graphique = null;

// Couleurs lues dans le thème courant (sombre ou clair) au moment du dessin.
const couleurTheme = (nom, defaut) => getComputedStyle(document.documentElement).getPropertyValue(nom).trim() || defaut;
const texte = () => couleurTheme("--texte-att", "rgba(220, 232, 246, 0.75)");
const grille = () => couleurTheme("--separateur", "rgba(255, 255, 255, 0.06)");

function lisser(valeurs, rayon = 1) {
  return valeurs.map((_, i) => {
    let somme = 0;
    let n = 0;
    for (let k = Math.max(0, i - rayon); k <= Math.min(valeurs.length - 1, i + rayon); k++) {
      somme += valeurs[k];
      n++;
    }
    return somme / n;
  });
}

function axe(titre, position, options = {}) {
  return {
    position,
    title: { display: true, text: titre, color: texte(), font: { size: 11 } },
    ticks: { color: texte(), font: { size: 10 }, maxTicksLimit: 6 },
    grid: { color: position === "left" ? grille() : "transparent" },
    ...options,
  };
}

function ligne(label, data, couleur, yAxisID, extra = {}) {
  return { type: "line", label, data, borderColor: couleur, backgroundColor: couleur, yAxisID, pointRadius: 0, borderWidth: 2, tension: 0.25, ...extra };
}

export function detruireCourbe() {
  if (graphique) {
    graphique.destroy();
    graphique = null;
  }
}

export function afficherCourbe(canvas, profilTrajet, arrets, vue, onClicKm) {
  detruireCourbe();
  if (!window.Chart || !profilTrajet) return false;

  const seg = profilTrajet.segments;
  const milieu = (s) => Math.round(((s.km_debut + s.km_fin) / 2) * 10) / 10;
  const kmMax = seg.length ? seg[seg.length - 1].km_fin : 0;
  let datasets;
  let scales;

  if (vue === "batterie") {
    datasets = [
      ligne("Batterie (%)", (profilTrajet.batterie || []).map((p) => ({ x: p.km, y: p.pct })), "#22e5a0", "y", {
        fill: true,
        backgroundColor: "rgba(34, 229, 160, 0.12)",
        tension: 0,
      }),
      {
        type: "scatter",
        label: "Arrêt de recharge",
        data: (arrets || []).map((a) => ({ x: a.km_depuis_depart, y: a.pct_arrivee_borne })),
        backgroundColor: "#00e5ff",
        borderColor: "#fff",
        pointRadius: 6,
        pointStyle: "rectRounded",
        yAxisID: "y",
      },
    ];
    scales = { y: axe("Batterie %", "left", { min: 0, max: 100 }) };
    if (profilTrajet.relief_ok) {
      datasets.push(
        ligne("Altitude (m)", seg.map((s) => ({ x: s.km_debut, y: Math.round(s.altitude) })), "rgba(170, 180, 200, 0.7)", "y2", {
          fill: "origin",
          backgroundColor: "rgba(170, 180, 200, 0.12)",
          borderWidth: 1,
        }),
      );
      scales.y2 = axe("Altitude m", "right");
    }
  } else if (vue === "vitesse") {
    const conso = profilTrajet.conso_constante
      ? seg.map(() => profilTrajet.conso_constante)
      : lisser(seg.map((s) => s.conso_kwh100), 2);
    datasets = [
      ligne("Vitesse (km/h)", seg.map((s) => ({ x: milieu(s), y: Math.round(s.vitesse) })), "#4fe0ff", "y"),
      ligne("Consommation (kWh/100 km)", seg.map((s, i) => ({ x: milieu(s), y: Math.round(conso[i] * 10) / 10 })), "#ffcf70", "y2"),
    ];
    scales = { y: axe("Vitesse km/h", "left", { min: 0 }), y2: axe("kWh/100 km", "right") };
  } else {
    datasets = [
      ligne("Température (°C)", seg.map((s) => ({ x: milieu(s), y: s.temperature })), "#ff7a90", "y"),
      ligne("Vent de face (km/h, négatif = dans le dos)", seg.map((s) => ({ x: milieu(s), y: Math.round(s.vent_face) })), "#d199ff", "y", { borderDash: [5, 4] }),
      {
        type: "bar",
        label: "Pluie (mm/h)",
        data: seg.map((s) => ({ x: milieu(s), y: s.pluie })),
        backgroundColor: "rgba(79, 160, 255, 0.55)",
        yAxisID: "y2",
        barPercentage: 1,
        categoryPercentage: 1,
      },
    ];
    scales = { y: axe("°C / km/h", "left"), y2: axe("Pluie mm/h", "right", { min: 0, suggestedMax: 2 }) };
  }

  graphique = new window.Chart(canvas, {
    data: { datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: kmMax,
          title: { display: true, text: "km", color: texte(), font: { size: 11 } },
          ticks: { color: texte(), font: { size: 10 }, maxTicksLimit: 8 },
          grid: { color: grille() },
        },
        ...scales,
      },
      plugins: {
        legend: { labels: { color: texte(), boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? `km ${Math.round(items[0].parsed.x)}` : ""),
          },
        },
      },
      onClick: (evenement, _elements, chart) => {
        const km = chart.scales.x.getValueForPixel(evenement.x);
        if (Number.isFinite(km)) onClicKm(Math.max(0, Math.min(kmMax, km)));
      },
    },
  });
  return true;
}
