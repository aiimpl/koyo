# Koyo

A valley in the Japanese mountains at the height of autumn, flown over in three.js. Morning mist lies in the valley floor, the slopes are covered in beech and maple turning yellow, orange and red, with dark stands of cedar, and leaves blow past the camera.

**Open: https://aiimpl.github.io/koyo/** (drag to look around, slide the date from early October to late November)

Nothing is pre-rendered and there are no image files: the mountains, about 450,000 trees in the film (fewer on the page), the leaves, the mist and the clouds are all made in the browser.

## How it is built

| | |
|---|---|
| Mountains | A rounded noise for the shoulders of the hills plus a little ridged noise for the folds, with one winding valley carved down the middle and a narrow gorge along the river. A second, coarse terrain 60 km across carries the far ranges |
| Broadleaf trees | Each crown is up to 56 small cards (30 on the page, 56 in the film) in the shape of an egg, each card painted with a clump of a few hundred leaves (drawn on a canvas at load time). The cards are lit as if they were the surface of the crown, not flat cards, so the crown has a sunny side and a shadow side; cards deep in the crown are darker and a dark core fills the gaps. Four crown shapes, and far trees use fewer, larger cards |
| Cedars | Up to sixteen tiers of branches, each a ring of cards painted with tufts of needles, drooping a little, around a dark core. They grow in groves |
| Colour | Each tree has its own colour (beech yellow, orange, rust, a few maples in red) in patches of the same kind. Each tree also has a day it turns, earlier higher up: the date slider moves every tree from green to its colour and then to a faded brown |
| Light | A low morning sun with shadows, sky light from above, and light through the leaves when you look towards the sun. Clouds drift over and their shadows cross the slopes |
| Air | Distance fades to the colour of the sky; mist in the valley thins with height, integrated along each view ray |
| Falling leaves | Iroha maple and beech leaves at their real size (6 to 9 cm), cupped, swinging like a pendulum and spinning as they fall, blown by the wind. They glow when the sun is behind them |

- `web/src/main.js`: the scene, the trees and leaves, the flight and the page
- `web/src/terrain.js`: the height of the land
- `tools/`: frames for the video (`render.py`), the mp4 (`encode.sh`), a page check at desktop and phone size (`check_page.py`)

```sh
make serve          # http://127.0.0.1:8815/
make setup          # Python + Playwright for the video and the check
make preview        # a rough 30 fps version of the film
make film video     # build/koyo.mp4 (1080x1350, 60 fps)
make check          # pyflakes, then the page at desktop and phone size
```

## License

MIT (`LICENSE`). three.js is MIT, see `web/vendor/three/LICENSE`.
