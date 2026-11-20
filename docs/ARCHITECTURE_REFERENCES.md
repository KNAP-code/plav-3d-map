# Authentic architecture: first 5 buildings (benchmark batch)

Status 2026-11-20. Five landmark buildings in central Plav are modelled individually on their OSM footprints.
Footprints, positions and orientation are unchanged; each model replaces only its own procedural building.
Camera shortcuts (chips): Redžepagića kula, Stara džamija, Sultanija, Redžepagića džamija, Šabovića džamija. The four mosque
chips look at the entrance side. The full verified/estimated lists are in `src/geo/landmarks.ts` (one list per model).

## Photo research pass (2026-11-20)

| source | what it has | could it be used here? | usage rights |
|---|---|---|---|
| Owner's own photos (kula, Stara džamija) | front and side views | yes | owner's |
| [plavto.me](https://www.plavto.me/en/tourist-offer/) (Tourist Organisation Plav) | galleries for Sultanija (12), Redžepagića džamija (14), Šabovića (10), Imperial/Stara (19+), kula (11) | text read; the three mosque galleries viewed on 2026-11-20 after the owner approved access to the site; used as visual references only, not copied into the project | no licence stated; treat as all rights reserved |
| [volimprokletije.art.blog](https://volimprokletije.art.blog/2020/12/21/dzamija-sultanija-u-plavu/) | 9 Sultanija photos by ef. Sead Jasavić | text read; images not viewable | no licence stated |
| [adrialine.me](https://www.adrialine.me/_en/sultanija_mosque.html) | Sultanija photos incl. the dome, location map | text read; images not viewable | Copyright Adria Line DMC |
| [upoznajcrnugoru.com](https://upoznajcrnugoru.com/redzepagica-dzamija-plav/) | one photo each of Redžepagića and Sultanija | text read; images blocked | all rights reserved |
| [avlija.me](https://avlija.me/islamsko-kulturno-nasljedje-plav/) | overview photo; says no old photo of Sultanija was found | text read | all rights reserved |
| [bosnjaci.net](https://bosnjaci.net/prilog.php?pid=56490) | historical photos of Stara, Redžepagića, Šabovića (opening 1900/01) | text read; images blocked | no licence stated |
| Dreamstime stock ([1](https://www.dreamstime.com/view-old-mosque-redzepagica-plav-montenegro-image104678238), [2](https://www.dreamstime.com/stock-photo-mosque-plav-view-old-redzepagica-center-montenegro-image38891440)) | photos titled "old mosque Redzepagica" | not viewed (paid licence; titles may mix up the mosques) | paid royalty-free licence |
| Wikimedia Commons | a Category:Plav exists per search, but its pages could not be opened from this environment | no | per file (CC) |
| İbrahimgil & Kudumovic (2023), [GU J Sci Part B 11(2)](https://dergipark.org.tr/en/pub/gujsb/article/1117022) | measured table and typology of Montenegrin wooden-minaret mosques, incl. three in Plav | text read (figures not viewable) | no licence stated; facts cited |
| balkanarchitecture.org, plavgusinje.me, ResearchGate | Plav pages | refused (robots / blocked) | n/a |

Update 2026-11-20: the image block was a network allow-list in the build environment, not an access control on the
sites. After the owner approved read-only access to plavto.me, volimprokletije.art.blog, adrialine.me and
upoznajcrnugoru.com, the plavto.me galleries for the three mosques were viewed. The photos were looked at only to read the
architecture; none is copied into the repository or the preview, and the comparison sheets link to them instead. The
photos that each attribute comes from are named below and in `src/geo/landmarks.ts`.

| mosque | exterior photos used (plavto.me) | what they show |
|---|---|---|
| Sultanija | [1710606531-1](https://www.plavto.me/files/images/1710606531-1.jpg), [1710606531-2](https://www.plavto.me/files/images/1710606531-2.jpg), [1710606530-12](https://www.plavto.me/files/images/1710606530-12.jpg) | street view with the whole minaret and dome; low view of the minaret between the hall and the entrance wing; elevated view of the hall and the wing's small domes |
| Redžepagića džamija | [1711363700-1](https://www.plavto.me/files/images/1711363700-1.jpg), [1711363699-2](https://www.plavto.me/files/images/1711363699-2.jpg) | corner view of the stone hall, roof, timber section and šadrvan; roof and minaret |
| Šabovića džamija | [1711282504-7](https://www.plavto.me/files/images/1711282504-7.jpg), [1711282504-8](https://www.plavto.me/files/images/1711282504-8.jpg), [1711282503-9](https://www.plavto.me/files/images/1711282503-9.jpg) | annex and long side; annex front straight on; long side through the gate |

The other gallery images are interiors or aerial views and were not needed for the exterior models.

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
Most were covered by the plavto.me galleries. Still missing:
- Sultanija: the SE (qibla) side, and a top or wide view that shows how many small domes the entrance wing has.
- Redžepagića džamija: the NW end, to settle what occupies the last 5.4 m of the OSM footprint, and the šadrvan's position.
- Šabovića džamija: the annex from above or the side, to settle its outline (flat front or polygon).

Reference photographs: the owner's own photos (kula, Stara džamija) and, for the three other mosques, the plavto.me gallery
photos listed above, viewed as references only. No Google imagery or extracted 3D geometry was used.

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
| walls | carved stone (builders from Debar); light grey cut-stone blocks | verified (text + photo 1710606530-12) |
| main dome | one large dark lead dome with ribs on a low light-stone drum, over the hall | verified (photo 1710606531-1); radius 5.4 m estimated from proportions |
| small domes | several small lead domes on the lower entrance wing | verified (photos 1710606531-2, 1710606530-12); 6 in a 2 × 3 grid is an estimate |
| entrance wing | lower than the hall, tall round-arched bays with gridded glazing, round-arched entrance | verified (photos 1710606531-1, -2); 6.5 m height and bay counts estimated |
| hall windows | rectangular, two rows | verified (photo 1710606530-12); counts estimated |
| minaret | 41.5 m concrete (adrialine.me); white cylindrical shaft on a square grey stone base, two balconies, tall dark pointed cap; between hall and wing at the OSM node | verified (text + photos 1710606531-1, -2 + OSM); balcony heights (about 22 and 28.5 m) and cap start (34 m) scaled from photo 1710606531-1 |
| šadrvan | white pavilion with arches and a small dome near the mosque | seen in photos; not modelled (position unknown) |
| layout | SE part = domed hall, NW part = entrance wing | consistent with photos; plan not documented |

Changed from the previous model: one balcony became two; the lead cap became a tall dark pointed cap on a white shaft
over a grey stone base; the flat wing roof gained six small domes; the wing's small arched windows became tall glazed bays;
the hall's arched windows became rectangular; the dome is darker with ribs and sits on a round drum.

## 4. Redžepagića džamija (1774, rebuilt 1871)
| attribute | value | confidence |
|---|---|---|
| footprint, position | OSM | verified |
| walls | bare rough stone in lime mortar (no render), dressed-stone plinth and a string course | verified (text + photo 1711363700-1) |
| windows | small round-arched windows with dressed-stone surrounds, larger lower row, smaller upper row | verified (photo 1711363700-1); counts per side estimated |
| roof | steep hipped roof of orange-red clay tiles with a short ridge, nearly pyramidal; gutters and a corner downpipe | verified (text + photos 1711363700-1, 1711363699-2); 38° pitch estimated |
| timber section | dark timber-boarded section at the entrance end under the same roof | verified (photo 1711363700-1 + "wooden porch" in text); 3.2 m depth estimated |
| prayer hall | 6.53 × 7.90 m interior, height 4.80 m | verified (İbrahimgil & Kudumovic 2023) |
| minaret | pine, 14 m; rises from the end of the short ridge; dark fishbone-clad shaft; enclosed balcony only slightly wider than the shaft, with a band of small openings; timber cone cap with a flared eave and a finial | verified (text + photos 1711363700-1, 1711363699-2); heights scaled from the photos to the 14 m total |
| rest of the footprint | the OSM outline is 17.9 m long; the roofed building in the photos is about 12.5 m | the remaining 5.4 m at the NW end is drawn only as a paved forecourt; needs checking |
| šadrvan | hexagonal pavilion, grey roof, white arches with green trim, beside the entrance | seen in photo 1711363700-1; not modelled (position unknown) |

Changed from the previous model: white render became bare stone; rectangular windows became small arched windows in two
rows; the open 4-post porch became an enclosed timber section; the roof became a short-ridged hip over the hall and timber
section only; the minaret was cut from about 23 m to 14 m with a slimmer balcony and a timber cap.

## 5. Šabovića džamija (c. 1900)
| attribute | value | confidence |
|---|---|---|
| footprint, position | OSM "Sabovica" | verified |
| hall walls | cream-buff stone blocks, darker stone corner pilasters, a mid-height band | verified (text + photo 1711282504-7) |
| hall windows | small round-arched, two rows | verified (photo 1711282504-7); counts estimated |
| roof | hipped, brown shingle imitation, moderate pitch | verified (text + photos 1711282504-7, -8); 33° estimated |
| minaret | pine, 7.5 m, rising from near the ridge; dark fishbone-clad shaft, enclosed balcony with small openings, small cone cap, finial | verified (text + photos 1711282504-7, -8); proportions scaled from photos |
| entrance annex | tan-brown rendered, dark projecting cornice, flat roof, three small ribbed dark-lead domes in a row, tall ogee-arched glazed bays with red frames, door in the middle bay | verified (text + paper + photo 1711282504-8) |
| annex outline | photo shows a flat front with three bays; OSM outline has four faces | OSM outline kept; one bay per face, door position estimated |
| prayer hall | 8.26 × 10.91 m, height 4.40 m | verified (paper) |

Changed from the previous model: grey stone became cream blocks with corner pilasters; the stone annex with a small door
became a rendered annex with ogee glazed bays and a dark cornice; the domes became ribbed; the roof became brown and
flatter; the minaret became slimmer with an open-band balcony.

## Batch 2: three Plav-Gusinje towers (2026-11-20)

Chosen because they are the best-documented remaining buildings in Plav: each has a Tourist Organisation Plav text with
dimensions and floors and a photo gallery. The models are built (`src/geo/landmarks.ts`, `PENDING_LANDMARKS`) but **not
placed on the map**: no reachable source gives their positions (plavto.me, photomontenegro.me, komoot, Wikivoyage and
OpenStreetMap were checked; OSM does not name them; dozens of 10 × 10 m footprints lie near Ribarska, Jusufagića and
Šabovića streets). They go on the map when the owner points out each footprint. Until then the close-up renders use a
stand-in footprint (render-only `?closeup=1&place=key@id`), labelled as such.

| tower | text source | photos used (plavto.me, viewed only) | verified | estimated |
|---|---|---|---|---|
| Bećiragića kula / kula Šaćir-bega (1899) | [plavto.me](https://www.plavto.me/en/tourist-offer/beciragic-tower-sacir-bega-tower/) | [1710606305-1](https://www.plavto.me/files/images/1710606305-1.jpg), [1710606306-4](https://www.plavto.me/files/images/1710606306-4.jpg), [1710606307-3](https://www.plavto.me/files/images/1710606307-3.jpg), [1710606307-8](https://www.plavto.me/files/images/1710606307-8.jpg) | hewn stone, ground + 2 floors, 10.3 × 10 m, arched carved door with inscription panel, small round-headed windows in square frames (pairs on the door face), machicolation box over the door, low hipped red-tile roof, chimney | position; eaves 10.6 m; pitch 24°; window counts |
| Hadžimušovića kula (1897/98) | [plavto.me](https://www.plavto.me/en/tourist-offer/hadzimusovica-tower/) | [1710895153-6](https://www.plavto.me/files/images/1710895153-6.jpg), [1710895154-1](https://www.plavto.me/files/images/1710895154-1.jpg), [1710895154-2](https://www.plavto.me/files/images/1710895154-2.jpg), [1710895154-4](https://www.plavto.me/files/images/1710895154-4.jpg) | Ribarska mahala; rough stone with dressed quoins, about 10 × 10.2 m, ground + 2 floors, two arched ground-floor doors, small arched and round windows, machicolation boxes (1 on the door face, 2 on one side), steep dark-grey tiled hip roof | exact position; eaves 10.0 m; pitch 32°; window positions |
| Đurovića kula / kula Mehmeda-Meda Jakup Ferovog (end 19th c.) | [plavto.me](https://www.plavto.me/en/tourist-offer/durovica-tower-mehmeda-meda-tower-jakup-ferovog/) | [1710607212-5](https://www.plavto.me/files/images/1710607212-5.jpg), [1710607213-2](https://www.plavto.me/files/images/1710607213-2.jpg), [1710607213-3](https://www.plavto.me/files/images/1710607213-3.jpg), [1710607213-4](https://www.plavto.me/files/images/1710607213-4.jpg) | cut stone with light quoins, two rows of tall arched windows with white surrounds and brown shutters, arched ground-floor door, dark hipped roof with two chimneys, roofed wooden external staircase (added in the renovation), corner downpipes | position; footprint size; eaves 8.6 m; pitch 30°; window counts; door and stair placement |

Other candidates checked for this batch: Opština Plav, Dom kulture, Pošta, Osnovni sud, Pijaca, the Hajro Šahmanović
school and Hotel Plavsko jezero have verified OSM footprints but no photo or description reachable from the build
environment, so they would only get restrained provisional models.

## Mosque orientation
The qibla from Plav is 136° (SE). The long axes of the Sultanija (157°), Redžepagića (144°) and Šabovića (139°) footprints all
point close to it, so their entrances are modelled on the NW end. This is an inference from the footprint and the qibla, not a
written fact.

## What is not done yet
- Phase 3 (Plav-specific house families) has not started. The ordinary houses still use the earlier procedural system.
- Batch 1 (five buildings) approved 2026-11-20. Batch 2 (three towers) is modelled and waits for the owner to confirm their positions.
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
