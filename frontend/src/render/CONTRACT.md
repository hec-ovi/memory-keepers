# frontend / render

Purpose: three.js only; no game rules. Everything pickable carries `userData.pickable` with a `kind` (`keeper | house | vacant | monument | book`).

- `scene.js` `WorldScene`: renderer, lights, and `blendZones(focusZ)`: the spatial day/night blend as the camera crosses sides.
- `camera.js` `GameCamera`: orbit/pan/zoom, `follow(object)` until the player pans, `pick(event, objects, camera?)`, `project(x,y,z)` for DOM overlays.
- `island.js` `buildIsland`: terrain with soft color blends, animated water (`waterUpdate(t)`), path ribbons, plaza + monument (the root agent's body), dark spire, seeded trees.
- `house.js`: `buildHouse(plot, palette)` seeded variations, `buildVacantSign(plot)` readable both sides.
- `keeper.js` `KeeperAvatar`: the blob body skinned by her palette, dark night variant, `bob(t, moving)`.
- `interior.js` `InteriorScene`: room, keeper on her chair, the 24-slot bookcase (`setBooks`), `room`/`shelf` views, 2D `pan` clamped to the shelf.
- `dreammovie.js` `DreamMovie.play(report, onDone)`: canvas playback of the dream graph, narrative fade, skip button.
