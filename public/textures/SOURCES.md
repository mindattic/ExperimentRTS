# Color texture sources

All files are equirectangular (2:1) diffuse/color images - see `heightmapImage.ts`'s
`loadColorImage` and `heightfield.ts`'s `colorAt`/`useColorImage` for how they're sampled
(same lat/lon convention as the elevation maps in `public/heightmaps/`, so color and
elevation always stay aligned).

| File | Source | License | Notes |
|---|---|---|---|
| `mercury_color.jpg` | [USGS Astrogeology Astropedia](https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_global_color_mosaic_665m) | Public domain (NASA/USGS) | MESSENGER MDIS *Global Color Mosaic* - deliberately not the "Enhanced Color" product, which exaggerates mineral differences and isn't natural-looking |
| `earth_color.jpg` | [NASA Visible Earth - Blue Marble](https://visibleearth.nasa.gov/images/74117) | Public domain (NASA) | MODIS/Terra composite, resized down from the original 5400x2700 release |
| `mars_color.jpg` | [USGS Astrogeology Astropedia](https://astrogeology.usgs.gov/search/map/mars_viking_global_color_mosaic_925m) | Public domain (NASA/USGS) | Viking Orbiter red/violet-filter global color mosaic |
| `jupiter_color.jpg` | [NASA SVS - "Hubble Maps Jupiter in 4K"](https://svs.gsfc.nasa.gov/12021/) | Public domain (NASA) | Real Hubble-derived global map, genuinely equirectangular/wrap-ready |
| `saturn_color.jpg`, `uranus_color.jpg`, `neptune_color.jpg` | [Solar System Scope](https://www.solarsystemscope.com/textures/) (via Wikimedia Commons mirrors) | CC BY 4.0 (attribution required) | **Stylized, not raw photographic data.** Cassini/Voyager 2 imagery exists for these bodies but no genuine cartographic *global equirectangular* map was locatable for this pass - gas giants have no fixed rotating surface to project onto the way solid bodies do, and Uranus/Neptune were only ever visited by a single brief 1980s flyby. Solar System Scope's own site discloses gaps are "filled with fictional terrain that corresponds with the rest of the landscape." Attribute as: "Textures by Solar System Scope (solarsystemscope.com/textures), CC BY 4.0." |

## Deliberately not added this pass

- **Venus color**: no true-color photograph of Venus's surface exists at all - its clouds
  are opaque to visible light, and Magellan's radar imagery is inherently false-color (colored
  by elevation, not real surface appearance). Faking a "real" color texture here would be
  actively dishonest, so Venus keeps its existing procedural, elevation-driven coloring.
- **Moon color**: every multi-band Clementine/LROC product locatable this pass was either a
  single-band grayscale mosaic (no color at all) or a mineral-ratio false-color composite
  (bands assigned to RGB channels by ratio, not natural appearance) - not the subtle,
  naturalistic tint the Moon actually has. Stays procedural rather than shipping a
  mislabeled false-color map.
- **Pluto color**: New Horizons' full global *color* coverage (as opposed to the panchromatic
  LORRI/MVIC mosaic used for `pluto_source.jpg`) only exists for part of the encounter
  hemisphere - no clean single "global color mosaic" product was locatable this pass. Stays
  procedural; worth revisiting if USGS publishes one later.
- **Eris**: no data of any kind exists - stays fully procedural, permanently (not a gap).
