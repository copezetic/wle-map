# Wallenpaupack Lake Estates — A Neighbor's Map

A 3D map of the community: pools, lakes, beaches, the marina and every street.
Made by a neighbor; not an official WLE publication.

Map data © OpenStreetMap contributors (ODbL), Overture Maps, USGS, U.S. Census.

## Map views

Illustrated is the default. The Aerial toggle uses Pennsylvania Emergency
Management Agency (PEMA) Cycle 2 imagery served by
[PASDA](https://www.pasda.psu.edu/). The Wayne County source is 2021 aerial
photography at 0.5-foot (six-inch) ground sample distance; it is not live imagery.
[Collection documentation](https://www.arcgisserver.oa.pa.gov/EWG/minutes/20240131slides.pdf).

`aerial.js` projects the public Web Mercator tiles onto the existing terrain,
clipping triangles to preserve the community outline. It progressively loads
levels 14–20 as the camera approaches, keeps lower-resolution parents while
children load, limits requests to four at a time, and evicts inactive subtrees
when the texture cache exceeds 140 loaded tiles. The visible working set is
retained even if it exceeds that cache target. No API key or paid account is
required. Tiles load only after Aerial is selected; the illustrated buildings,
trees and animated scenery are hidden in that view. Pins, search, and routing
remain shared between views.

[Imagery service](https://imagery.pasda.psu.edu/arcgis/rest/services/PEMAImagery_2021_2023_cache/MapServer).
Missing tiles retain any available lower-resolution photography, otherwise a
neutral ground color, with a Retry control. Switching back to Illustrated
cancels pending requests and restores the original map.

Serve locally with `python3 -m http.server 8766 --bind 127.0.0.1`.

## Copyright

© 2026 DeWitt Hutchins. All rights reserved. See `LICENSE`. The code, design, models and
artwork are not open source; photographs belong to their photographers and the map data
keeps its own licences.
