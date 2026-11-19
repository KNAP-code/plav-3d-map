export type Lang = "bs" | "en";

export const T = {
  bs: {
    subtitle: "Interaktivna minijatura · prototip",
    loading: "Učitavanje minijature…",
    zoomIn: "Približi", zoomOut: "Udalji", home: "Početni pogled", rotate: "Rotiraj", north: "Sjever gore",
    quality: "Kvalitet", masl: "m n.v.", about: "O mapi",
    centre: "Centar", lake: "Plavsko jezero",
    aboutText:
      "Stilizovana 3D minijatura centra Plava napravljena od otvorenih geografskih podataka. Položaji i tlocrti zgrada su stvarni (OpenStreetMap i Microsoft ML footprints). Visine zgrada i oblici krovova su procjene, jer ti podaci za Plav još ne postoje u OpenStreetMap-u. Drveće je postavljeno prema ESA WorldCover pikselima šume (10 m), a vrsta i veličina su stilizovane.",
    data: "Izvori podataka", stats: "Statistika", buildings: "zgrada", trees: "stabala", estimated: "procijenjene visine",
    close: "Zatvori",
  },
  en: {
    subtitle: "Interactive miniature · prototype",
    loading: "Loading the miniature…",
    zoomIn: "Zoom in", zoomOut: "Zoom out", home: "Home view", rotate: "Rotate", north: "North up",
    quality: "Quality", masl: "m a.s.l.", about: "About",
    centre: "Centre", lake: "Lake Plav",
    aboutText:
      "A stylised 3D miniature of central Plav built from open geographic data. Building positions and footprints are real (OpenStreetMap and Microsoft ML footprints). Building heights and roof shapes are estimates, because that information does not yet exist in OpenStreetMap for Plav. Trees are placed from ESA WorldCover 10 m tree-cover pixels; species and size are stylised.",
    data: "Data sources", stats: "Statistics", buildings: "buildings", trees: "trees", estimated: "estimated heights",
    close: "Close",
  },
} as const;
