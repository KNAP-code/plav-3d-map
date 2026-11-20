export type Lang = "bs" | "en";

export const T = {
  bs: {
    subtitle: "Interaktivna minijatura · prototip",
    loading: "Učitavanje minijature…",
    zoomIn: "Približi", zoomOut: "Udalji", home: "Početni pogled", rotate: "Rotiraj", north: "Sjever gore",
    quality: "Kvalitet", masl: "m n.v.", about: "O mapi",
    centre: "Centar", lake: "Plavsko jezero",
    aboutText:
      "Stilizovana 3D minijatura grada Plava napravljena od otvorenih geografskih podataka. Položaji i tlocrti zgrada su stvarni (OpenStreetMap i Microsoft ML footprints). Visine zgrada i oblici krovova su procjene, jer ti podaci za Plav još ne postoje u OpenStreetMap-u. Drveće je postavljeno prema ESA WorldCover pikselima šume (10 m), a vrsta i veličina su stilizovane.",
    data: "Izvori podataka", stats: "Statistika", buildings: "zgrada", trees: "stabala", estimated: "procijenjene visine",
    close: "Zatvori", day: "Dan", night: "Noć", traffic: "Saobraćaj (ukrasni)",
    estOn: "Procijenjeni detalji: uključeni (dodirni za samo provjerene podatke)", estOff: "Samo provjereni podaci (dodirni za procijenjene detalje)",
    estTitle: "Podaci i procjene",
    estText: "Iz podataka: tlocrti zgrada, ulice i njihove osi, mostovi, dalekovodi, mol, igralište, groblja, jezero i rijeke, teren. Procjene (dugme ≈ ih skriva): širine ulica, trotoari, visine i krovovi zgrada, fasade, balkoni, bašte i ograde, nadgrobni spomenici, vrste drveća.",
  },
  en: {
    subtitle: "Interactive miniature · prototype",
    loading: "Loading the miniature…",
    zoomIn: "Zoom in", zoomOut: "Zoom out", home: "Home view", rotate: "Rotate", north: "North up",
    quality: "Quality", masl: "m a.s.l.", about: "About",
    centre: "Centre", lake: "Lake Plav",
    aboutText:
      "A stylised 3D miniature of the town of Plav built from open geographic data. Building positions and footprints are real (OpenStreetMap and Microsoft ML footprints). Building heights and roof shapes are estimates, because that information does not yet exist in OpenStreetMap for Plav. Trees are placed from ESA WorldCover 10 m tree-cover pixels; species and size are stylised.",
    data: "Data sources", stats: "Statistics", buildings: "buildings", trees: "trees", estimated: "estimated heights",
    close: "Close", day: "Day", night: "Night", traffic: "Traffic (decorative)",
    estOn: "Estimated details: on (tap for verified data only)", estOff: "Verified data only (tap to show estimated details)",
    estTitle: "Data and estimates",
    estText: "From data: building footprints, street centrelines, bridges, power lines, pier, pitch, cemeteries, lake and rivers, terrain. Estimates (the ≈ button hides them): street widths, sidewalks, building heights and roofs, facades, balconies, gardens and fences, headstones, tree species.",
  },
} as const;
