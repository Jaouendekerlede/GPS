// Icône de la voiture sur la carte (réglage Profil > Navigation), pointe
// vers le haut : la carte la fait tourner selon le cap.

const COULEURS = { fleche_bleue: "#3d8bff", fleche_verte: "#1fbf6a", fleche_orange: "#ff8a1f", fleche_rouge: "#ef4444" };

export function svgVoiture(style = "fleche_bleue") {
  if (style === "voiture") {
    return `<svg width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="26" fill="rgba(61,139,255,0.18)"/><rect x="18" y="7" width="20" height="42" rx="8" fill="#3d8bff" stroke="#fff" stroke-width="2.5"/><rect x="21" y="15" width="14" height="9" rx="2.5" fill="#d6e7ff"/><rect x="21.5" y="36" width="13" height="7" rx="2" fill="#a9c9f5"/><rect x="15.5" y="15" width="3" height="6" rx="1.5" fill="#1b3f7a"/><rect x="37.5" y="15" width="3" height="6" rx="1.5" fill="#1b3f7a"/></svg>`;
  }
  if (style === "point") {
    return `<svg width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="24" fill="rgba(61,139,255,0.2)"/><path d="M28 5 L35 17 L21 17 Z" fill="#3d8bff"/><circle cx="28" cy="28" r="11" fill="#3d8bff" stroke="#fff" stroke-width="4"/></svg>`;
  }
  const c = COULEURS[style] || COULEURS.fleche_bleue;
  return `<svg width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="26" fill="${c}38"/><path d="M28 8 L42 44 L28 36 L14 44 Z" fill="${c}" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/></svg>`;
}
