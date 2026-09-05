# Heightmap (elevation) sources

All files are grayscale equirectangular (2:1) images where brightness encodes elevation -
see `src/terrain/heightmapImage.ts`/`heightfield.ts` for how they're sampled. All entries
below are public domain (US government work, NASA/USGS).

| File | Source | Mission/instrument |
|---|---|---|
| `mercury_source.jpg` | USGS Astrogeology Astropedia | MESSENGER MDIS |
| `venus_source.jpg` | USGS Astrogeology Astropedia | Magellan SAR (radar) - polar regions have real data gaps, softened via `HeightmapSource.minSample` in `scale.ts` rather than reading as a fake bottomless canyon |
| `earth_source.png` | USGS Astrogeology Astropedia | SRTM/GTOPO-derived |
| `moon_source.jpg` | USGS Astrogeology Astropedia | LRO LOLA |
| `mars_source.jpg` | USGS Astrogeology Astropedia | MGS MOLA |
| `pluto_source.jpg` | [USGS Astrogeology Astropedia](https://astrogeology.usgs.gov/search/map/pluto_new_horizons_lorri_mvic_global_dem_300m) | New Horizons LORRI/MVIC (July 2017 global DEM release) - covers the encounter hemisphere in high detail; the unseen far side is filled from lower-confidence approach-distance data, same "best available" spirit as every other body here |

**Eris** has no real elevation data of any kind - it has never been resolved as more than a
point of light by any telescope or spacecraft - and stays on `PlanetHeightfield`'s procedural
fallback permanently, not as a gap to fill later.

See `public/textures/SOURCES.md` for the parallel color-texture catalog.
