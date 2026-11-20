# Fractal — Improvisation for Cello and Piano

A visual piece for a 47-second improvisation for cello and piano by **[Incheol Kim](https://linktr.ee/incheol)**.

It gives visual form to an image of repetition that came out of the improvisation. The picture starts as an empty
sheet of paper: pencil lines are drawn on it, flat colour fills them, a collage of cut-out photographs grows over
them, and in the end it all becomes a single photograph. Every change falls on a note of the cello or the piano.

**Watch it**

- Web version (WebGL2, plays with the music): https://incheol-kim.github.io/fractal/
- YouTube version (4K): https://youtu.be/EL6Oa3PcX5c

The web version draws the collage with lighter, half-size pieces for most of the piece; for the full 4K quality,
watch the YouTube version.

Everything is drawn in the browser, from code, from the pictures in `assets/` and from timing data of the
performance; the video is a recording of this page.

## Controls

| Input | Action |
|---|---|
| Tap / click, or `Space` | Play / pause |
| Double-tap the left / right third, or `←` / `→` | 5 s back / forward (keep tapping to add 5 s) |
| `,` / `.` | To the cello's note before / after |
| Drag the bar on the pause screen | Jump |

The web version loads about 75 MB, and smooth playback needs a capable GPU. On laptops with two GPUs, browsers
often run on the power-saving one: in Windows, Settings → System → Display → Graphics, set your browser to
*High performance*. `chrome://gpu` (or `edge://gpu`) shows which GPU is in use. If the page runs short of
graphics memory, add `?tex=half` to the address.

## Run locally

Requirements: Node.js 22.12 or later.

```
npm install
npm run dev
```

Then open http://localhost:5173/. The page needs the server; opening `index.html` as a file does not work.

Page options:

- `#t=34.2` — a still frame of second 34.2
- `?w=1920&h=1080` — render at a fixed size regardless of the window
- `?pieces=web` / `?pieces=full` — the set of collage pieces. This repository has only the web set
  (`assets/collage-web/`: lighter, half-size pieces for most of the piece; the full 4K quality is in the YouTube
  version), the default here; `?pieces=full`, the full-size originals the video was made with, is an error here:
  they are not published
- `?tex=half` — the large pictures (the key image and the others) at half size, for GPUs short of memory
- `?collage=calm|mid|high` — how often the collage's pieces change with the cello (`high`, the video's, by
  default); the keys 1, 2 and 3 switch it while the page runs

The others (`?fx=0`, `?ref=1`, `?hud=1`) are described at the top of `src/main.js`.

## Build from source

Requirements: Node.js 22.12 or later for the page and its tests; Python 3.14 with the packages pinned in
`requirements.txt` for the tools that make the material in `assets/` (each tool is described, in Korean, in
`tools/README.md`). `requirements.txt` pins CUDA builds of PyTorch for the tools that upscale and segment;
the Python tests need only the lighter packages (`numpy`, `scipy`, `pillow`, `opencv-python-headless` and
`scikit-image`). The Python tests have only been run on Windows.

```
npm test
npx vite build --base=/fractal/      # the site as GitHub Pages serves it, in local-only/temp/dist/
python -m unittest discover -s tools -p "test_*.py"
```

In Git Bash, run the build as `MSYS_NO_PATHCONV=1 npx vite build --base=/fractal/`; otherwise Git Bash turns
`/fractal/` into a Windows path.

This repository does not include the reference images (the original pictures the key image and the collage's
pieces come from), the full-size collage pieces, the documents of the working process, the DAW project or the
final WAV. So the tools that read them do not run here: upscaling and segmenting the key image and building its
region map (`upscale.py`, `segment.py`, `make_regions.py`, `check_regions.py`), picking, cutting and baking the
collage (`pick_collage.py`, `upscale_refs.py`, `make_collage.py`, also with `--bake` and `--check`), and making
the web set from the originals (`make_collage_web.py`; its `--check` runs). `make_music.py` also reads the final
mix, its WAV and an MP3, which are not here (the page's copy of the MP3 is `assets/fractal.mp3`). The tools that
work from `assets/` and `data/` run (`make_flat.py`, `make_plate.py`, `make_strokes.py`, `make_score.py`,
`make_life.py`). The tests that need a missing file say which one and are skipped; the file `PUBLIC_TREE` at the
root marks this repository as the published copy.

## Video export

`tools/export_video.mjs` renders the 4K and 1080p 60 fps video in headless Microsoft Edge (Windows): every frame
is the average of 16 sub-frames over a 1/120 s shutter, kept first as lossless chunks and then encoded once
into H.264 at both sizes, with the original WAV's PCM samples copied in as they are. It needs ffmpeg 5.1 or
later on PATH and the original WAV (`resources/Mixdown/2026-11-07 fractal/2026-11-07 fractal - final.wav`),
which is not included. The video was made with the full-size collage pieces, which are not here either: an
export from this repository would draw the collage with the lighter web pieces, half size for most of the
piece. The video is published on YouTube, not here.

The `tools/check_*.mjs` scripts are browser checks used during development (headless Edge). The browser checks
and the video export run on Windows only (headless Microsoft Edge with Direct3D).

## Structure

```
index.html            the page: canvas, loading notice, pause screen and controls
src/main.js           loading, the clock and playback, the page's options, renderFrame for the tools
src/timeline.js       what is on screen at each moment, from the score (pure functions)
src/renderer.js       the WebGL2 renderer (Three.js); src/layers/ one module per layer, src/shaders/ GLSL
src/assets.js         loading the material; collage_set.js which set of collage pieces; base.js addresses
                      under the site's base path
src/controls.js       the playback controls' logic; ui.js draws them over the canvas
src/card.js           the end card
assets/               the material the page draws from, made by tools/: key image, plate, region map,
                      strokes, score, music data, collage pieces (collage-web/), font
data/                 the tools' hand-made inputs
resources/            the performance: its MIDI
test/                 unit tests (node --test)
tools/                material tools (Python), browser checks and the video export (Node); tools/README.md
.github/workflows/    builds the site under /fractal/ and publishes it to GitHub Pages
```

## 한국어 요약

김인철(Incheol Kim)의 47초 첼로와 피아노 즉흥 연주에 맞춘 비주얼 아트입니다. 연주에서 떠올린 '반복'의 이미지를
형상화했습니다. 빈 종이에 연필 선이 그려지고, 색면이 채워지고, 오려 붙인 사진들의 콜라주를 거쳐 한 장의 사진이
됩니다. 모든 변화는 첼로나 피아노의 음에 맞춰 일어납니다.

- 웹 버전: https://incheol-kim.github.io/fractal/ (콜라주를 대부분 가벼운 절반 크기 조각으로 그립니다. 4K 고화질은
  유튜브 버전으로 보세요: https://youtu.be/EL6Oa3PcX5c)
- 조작: 탭이나 클릭 또는 스페이스로 재생 및 일시정지, 좌우 두 번 탭 또는 ←/→로 5초 이동, `,`/`.`로 앞뒤 첼로 음으로
  이동, 일시정지 화면의 막대로 이동.
- 노트북에서는 Windows 그래픽 설정에서 브라우저를 '고성능' GPU로 지정하면 훨씬 매끄럽습니다.
- 로컬 실행: `npm install`, `npm run dev`. 테스트: `npm test`.

## Credits

Music: Incheol Kim — improvisation for cello and piano, *Fractal*.

Visuals: Directed by Incheol Kim, coded with Claude Code.

Images: generated with Midjourney.

Typeface: Geo (Google Fonts, SIL Open Font License, Version 1.1).

© 2026 Incheol Kim. All rights reserved.
