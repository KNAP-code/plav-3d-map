# Authentic architecture: first 5 buildings (benchmark batch)

Status 2026-11-20. Five landmark buildings in central Plav are modelled individually on their OSM footprints.
Footprints, positions and orientation are unchanged; each model replaces only its own procedural building.
Camera shortcuts (chips): Redžepagića kula, Stara džamija, Sultanija, Redžepagića džamija, Šabovića džamija. The four mosque
chips look at the entrance side. The full verified/estimated lists are in `src/geo/landmarks.ts` (one list per model).

## Photo research pass (2026-11-20)

| source | what it has | could it be used here? | usage rights |
|---|---|---|---|
| Owner's own photos (kula, Stara džamija) | front and side views | yes | owner's |
| [plavto.me](https://www.plavto.me/en/tourist-offer/) (Tourist Organisation Plav) | galleries for Sultanija (12+), Redžepagića džamija (14+), Šabovića (11), Imperial/Stara (19+), kula (11) | text read; images blocked from this environment | no licence stated; treat as all rights reserved |
| [volimprokletije.art.blog](https://volimprokletije.art.blog/2020/12/21/dzamija-sultanija-u-plavu/) | 9 Sultanija photos by ef. Sead Jasavić | text read; images not viewable | no licence stated |
| [adrialine.me](https://www.adrialine.me/_en/sultanija_mosque.html) | Sultanija photos incl. the dome, location map | text read; images not viewable | Copyright Adria Line DMC |
| [upoznajcrnugoru.com](https://upoznajcrnugoru.com/redzepagica-dzamija-plav/) | one photo each of Redžepagića and Sultanija | text read; images blocked | all rights reserved |
| [avlija.me](https://avlija.me/islamsko-kulturno-nasljedje-plav/) | overview photo; says no old photo of Sultanija was found | text read | all rights reserved |
| [bosnjaci.net](https://bosnjaci.net/prilog.php?pid=56490) | historical photos of Stara, Redžepagića, Šabovića (opening 1900/01) | text read; images blocked | no licence stated |
| Dreamstime stock ([1](https://www.dreamstime.com/view-old-mosque-redzepagica-plav-montenegro-image104678238), [2](https://www.dreamstime.com/stock-photo-mosque-plav-view-old-redzepagica-center-montenegro-image38891440)) | photos titled "old mosque Redzepagica" | not viewed (paid licence; titles may mix up the mosques) | paid royalty-free licence |
| Wikimedia Commons | a Category:Plav exists per search, but its pages could not be opened from this environment | no | per file (CC) |
| İbrahimgil & Kudumovic (2023), [GU J Sci Part B 11(2)](https://dergipark.org.tr/en/pub/gujsb/article/1117022) | measured table and typology of Montenegrin wooden-minaret mosques, incl. three in Plav | text read (figures not viewable) | no licence stated; facts cited |
| balkanarchitecture.org, plavgusinje.me, ResearchGate | Plav pages | refused (robots / blocked) | n/a |

No image could be opened from this environment (the network proxy and the fetch tool both refuse image hosts), so no
building attribute below is taken from a photo except for the kula and the Stara džamija.

### Name check: Carska, Stara, Sultanija
- plavto.me: the Imperial (Carska) mosque is the Old mosque (Stara), 1471, on the hill in the old town.
- avlija.me: lists "Stara Carska džamija" and "Carska džamija Sultanija" as two different mosques; both are called Carska.
- İbrahimgil & Kudumovic: "Hünkâr / Careva" mosque, Plav, 1471, founder Sultan = the Stara džamija by date.
- Sultanija: 1907, in the centre of the bazaar, OSM building "Sultanija" with its own OSM minaret node.
- In the map each model is tied to its OSM footprint, so the names cannot swap. Chips use "Stara džamija" and "Sultanija".
- İbrahimgil & Kudumovic list the 1774 mosque as "Fatıma Hanım": Redžepagića džamija was a waqf of Fatima, daughter of Redžep-aga (plavto.me, avlija.me), so it is the same building.
- "Haso Ferović / Sabovica" (1880) is the Šabovića džamija (built by Haso (Jakup Ferov) Šabović per plavto.me).

### Locations (footprint centres; links open OpenStreetMap)
- Sultanija: [42.597418, 19.944137](https://www.openstreetmap.org/?mlat=42.597418&mlon=19.944137#map=19/42.597418/19.944137)
- Stara džamija: [42.596489, 19.944333](https://www.openstreetmap.org/?mlat=42.596489&mlon=19.944333#map=19/42.596489/19.944333)
- Redžepagića džamija: [42.596179, 19.946242](https://www.openstreetmap.org/?mlat=42.596179&mlon=19.946242#map=19/42.596179/19.946242)
- Šabovića džamija: [42.594907, 19.944056](https://www.openstreetmap.org/?mlat=42.594907&mlon=19.944056#map=19/42.594907/19.944056)
- Redžepagića kula: [42.595724, 19.945963](https://www.openstreetmap.org/?mlat=42.595724&mlon=19.945963#map=19/42.595724/19.945963) (confirmed point)

### Photos still needed (owner)
- Sultanija: the entrance (NW) side with the whole minaret; the SE (qibla) side; a view showing the dome and any smaller domes.
- Redžepagića džamija: the porch end (NW) straight on; one long side from the corner, showing the roof and where the minaret leaves it.
- Šabovića džamija: the three-domed porch; one long side; the minaret close up.

Reference photographs: the only photographs available to this work are the project owner's own photos of the kula and the
Stara džamija. The Tourist Organisation Plav pages (plavto.me) have photo galleries, but no licence is stated and the images
could not be opened from the build environment, so they were not used. The written text of those pages was used. Wikimedia
Commons has no Plav category. No Google imagery or extracted 3D geometry was used.

| # | building | location (footprint centre) | references |
|---|---|---|---|
| 1 | Redžepagića kula | 42.595724, 19.945963; OSM way 221505346 (owner-confirmed) | owner's photos; [plavto.me](https://www.plavto.me/en/tourist-offer/redzepagic-tower/); montenegrina.net |
| 2 | Stara (Carska) džamija | OSM building "Stara džamija", 17.5 × 10.1 m | owner's photos; [plavto.me](https://www.plavto.me/en/tourist-offer/imperial-mosque/); avlija.me |
| 3 | Sultanija džamija | OSM building "Sultanija", 17.7 × 15.1 m, plus OSM minaret node | [plavto.me](https://www.plavto.me/en/tourist-offer/sultanija-mosque/) |
| 4 | Redžepagića džamija | OSM building "Redžepagića džamija", 17.9 × 8.0 m | [plavto.me](https://www.plavto.me/en/tourist-offer/redzepagic-mosque/); [upoznajcrnugoru.com](https://upoznajcrnugoru.com/redzepagica-dzamija-plav/) |
| 5 | Šabovića džamija | OSM building "Sabovica", 16.1 × 9.3 m | [plavto.me](https://www.plavto.me/en/tourist-offer/sabovic-mosque/) |

Correction: plavto.me identifies the Carska (Imperial) mosque as the Stara džamija (1471). The project's landmark list had
labelled Sultanija as "Carska"; it is now "Sultanija džamija".

## 1. Redžepagića kula
Unchanged in this batch; it already follows the owner's photos (see LANDMARKS.md).
plavto.me adds: built 1671 by Hasan-beg Redžepagić (another tradition says 15th century); originally two stone storeys with
walls over 1 m thick and a roof of stone slabs; third, wooden storey added later by Bećir-beg; covered wooden balconies over the
loopholes; entrance moved from the north to the south side. These agree with the model. Heights remain estimated.

## 2. Stara (Carska) džamija
Unchanged geometry; plavto.me confirms: 1471, present form from the 18th century, ashlar and wood, wooden sofa, ground floor and
first floor, 10 m wooden minaret rising from the roof, thermoplastic imitation shingles since 1986. Estimated: eave height,
roof pitch, minaret height above the ridge, window counts, rear wall.

## 3. Sultanija džamija (1907)
| attribute | value | confidence |
|---|---|---|
| footprint, position | OSM, L-shaped | verified |
| walls | carved stone (builders from Debar, stone tied with grooves and lead) | verified (text) |
| dome | stone dome | verified that it exists (text); size and drum estimated |
| minaret | 41.5 m, concrete (adrialine.me), rebuilt after the original stone minaret was demolished in 1927; position = OSM minaret node in the notch of the L | height and position verified (text + OSM); material conflicts between sources; one balcony and the cap form estimated |
| domes | "large domed building", "extended with domes" (plural) | main dome modelled; other domes not modelled (count and placement unknown) |
| floors | one tall prayer hall | estimated |
| layout | SE part = domed hall, NW wing = lower entrance wing with flat roof | estimated |
| colours | light ashlar, lead-grey dome and cap | estimated |
| windows, door | two rows of arched windows, arched door in the NW wing | estimated |

## 4. Redžepagića džamija (1774, rebuilt 1871)
| attribute | value | confidence |
|---|---|---|
| footprint, position | OSM | verified |
| walls | stone in lime mortar, plinth on the outer wall | verified (text) |
| prayer hall | 6.53 × 7.90 m, height 4.80 m; an L-shaped concrete mahfil was added in a recent restoration | verified (İbrahimgil & Kudumovic 2023); how the rest of the 17.9 m footprint is divided is unknown |
| roof | clay tiles | covering verified (text); hipped shape, 38° pitch estimated |
| minaret | pine, 14 m, rising out of the roof | verified (text); octagonal fishbone-clad shaft follows the regional type (paper); position near the entrance and the 14 m reading (above the eaves) estimated |
| porch | wooden entrance porch | verified that it exists (text); 3.2 m deep under the main roof, 4 posts estimated |
| door | carved wooden door | verified (text) |
| wall finish | whitewashed render | estimated (could be bare stone) |
| windows | 3 per long side, 2 at the rear, rectangular | estimated |
| harem, šadrvan, gasulhana | exist (text) | not modelled: positions unknown |

## 5. Šabovića džamija (c. 1900)
| attribute | value | confidence |
|---|---|---|
| footprint, position | OSM "Sabovica" | verified |
| walls | hewn stone | verified (text) |
| roof | thermoplastic imitation shingles | covering verified (text); hipped shape, 40° pitch estimated |
| minaret | pine, 7.5 m, rising from the roof | verified (text); octagonal fishbone-clad shaft follows the regional type (paper); position estimated |
| entrance annex | three-domed reinforced-concrete porch, narrower than the main facade | verified (plavto.me + paper); placed on the narrower NW part of the footprint (inference) |
| prayer hall | 8.26 × 10.91 m, height 4.40 m; concrete structure built around the original stone walls | verified (paper); visible finish may be render, not stone |
| windows, door | 3 arched per long side, door on the annex | estimated |

## Mosque orientation
The qibla from Plav is 136° (SE). The long axes of the Sultanija (157°), Redžepagića (144°) and Šabovića (139°) footprints all
point close to it, so their entrances are modelled on the NW end. This is an inference from the footprint and the qibla, not a
written fact.

## What is not done yet
- Phase 3 (Plav-specific house families) has not started. The ordinary houses still use the earlier procedural system.
- The remaining 15 buildings wait for the owner's approval of this batch.
- The Opština Plav building and other public buildings: no written description or usable photo was found.

## Municipality building and other central landmarks (research 2026-11-20)
- Opština Plav: OSM building "Opština Plav" with building:levels = 3 (used). No written description, plan or usable photo
  was found on plav.me, plavto.me or elsewhere; the plav.me footer gives the address as Čaršijska b.b. It stays a
  procedural 3-storey building on its real footprint, with roof and facade marked estimated.
- Centar za kulturu "Husein Bašić" (Dom kulture), Pošta, Osnovni sud: no descriptions found; procedural, estimated.
- Hotel Plavsko jezero: reopened in August 2026 after more than 30 years (plavto.me news); no architectural data.
- Lead not yet read: the 2026 monograph "Plav – grad na jezeru" (announced on plav.me) may describe these buildings.

## Reference photos to review (links; not opened from the build environment)
- Sultanija: [plavto.me gallery](https://www.plavto.me/en/tourist-offer/sultanija-mosque/) (12+ photos),
  [volimprokletije.art.blog](https://volimprokletije.art.blog/2020/12/21/dzamija-sultanija-u-plavu/) (9 photos by ef. Sead Jasavić),
  [adrialine.me](https://www.adrialine.me/_en/sultanija_mosque.html) (incl. the dome),
  [upoznajcrnugoru.com](https://upoznajcrnugoru.com/dzamija-sultanija-plav/).
- Redžepagića džamija: [plavto.me gallery](https://www.plavto.me/en/tourist-offer/redzepagic-mosque/) (14+ photos),
  [upoznajcrnugoru.com](https://upoznajcrnugoru.com/redzepagica-dzamija-plav/),
  [bosnjaci.net](https://bosnjaci.net/prilog.php?pid=56490) (historical photo),
  Dreamstime stock [1](https://www.dreamstime.com/view-old-mosque-redzepagica-plav-montenegro-image104678238), [2](https://www.dreamstime.com/stock-photo-mosque-plav-view-old-redzepagica-center-montenegro-image38891440) (titles say Redžepagića; identity unconfirmed).
- Šabovića džamija: [plavto.me gallery](https://www.plavto.me/en/tourist-offer/sabovic-mosque/) (11 photos),
  [bosnjaci.net](https://bosnjaci.net/prilog.php?pid=56490) (opening, 1900/01).
- Stara džamija: owner's photos (used); [plavto.me gallery](https://www.plavto.me/en/tourist-offer/imperial-mosque/) (19+ incl. drone shots).
- Redžepagića kula: owner's photos (used); [plavto.me gallery](https://www.plavto.me/en/tourist-offer/redzepagic-tower/).
None of these galleries states a reuse licence. They are links for visual review, not material to copy.
