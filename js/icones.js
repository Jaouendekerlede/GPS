// Pictogrammes dessinés au trait (identiques sur tous les téléphones, à la
// différence des émojis). Couleur : celle du texte (currentColor).

const TRAITS = {
  son: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  muet: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  micro: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4"/>',
  barriere: '<rect x="2" y="7" width="20" height="6" rx="1"/><path d="M6 7 2 13M12 7l-4 6M18 7l-4 6M22 7l-4 6"/><path d="M5 13v7M19 13v7"/>',
  menu: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  localiser: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  lune: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  plan: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  monde: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20"/>',
  satellite: '<path d="M13 7 9 3 5 7l4 4"/><path d="m17 11 4 4-4 4-4-4"/><path d="m8 12 4 4 6-6-4-4Z"/><path d="m16 8 3-3"/><path d="M9 21a6 6 0 0 0-6-6"/>',
  // Radar routier (caméra sur pied) : symbole propre à la place d'une
  // épingle générique -- demande explicite de l'utilisateur.
  radar: '<rect x="5" y="3" width="14" height="10" rx="2"/><circle cx="12" cy="8" r="3"/><path d="M12 13v8"/><path d="M8 21h8"/>',
};

export function icone(nom, taille = 24) {
  return `<svg class="gps-icone" viewBox="0 0 24 24" width="${taille}" height="${taille}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRAITS[nom] || ""}</svg>`;
}

// Fond de carte → pictogramme du bouton.
export function iconeFond(fond) {
  return icone(fond === "satellite" ? "satellite" : fond === "osm" ? "monde" : fond === "plan" ? "plan" : "lune");
}
