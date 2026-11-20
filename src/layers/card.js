// The end card (card.js; frameState's card), over everything, the grain and the glue chord's flash
// too (ORDER.card): no paper tooth, film grain or flash is drawn over it. Two rectangles over the
// whole frame, straight alpha over what is below: black with the opacity card.black, then the text
// with the opacity card.a, in CARD_INK, the name at CARD_NAME_ALPHA (card.frag.glsl).
// The text is drawn by a 2D canvas of the canvas's own pixel size, in CARD_FONT (put in
// document.fonts by assets.js before the first frame), and uploaded as a texture (drawText): the
// title's coverage in R, the name's in G. It is drawn again only when the canvas's size changes, so
// it is sharp at any size (never a smaller texture scaled up); it is the one thing the layer keeps
// from one frame to the next. Nothing is drawn while black and a are both 0, so every frame of the
// picture is what it is without this layer. Not made for ?ref=1 (renderer.js).
import cardVert from '../shaders/card.vert.glsl?raw';
import cardFrag from '../shaders/card.frag.glsl?raw';
import { hexRGB } from '../assets.js';
import { CARD_TEXT, CARD_INK, CARD_SIZE, CARD_SCALE, CARD_TRACKING, CARD_NAME_ALPHA, CARD_FONT } from '../card.js';

// The card's two lines into g (a 2D context on a W x H canvas, cleared): "Fractal" in red and
// "Incheol Kim" under it in green, in CARD_FONT at CARD_SIZE x CARD_SCALE x H px with CARD_TRACKING
// em of letter spacing. Each line's ink (measureText's actual bounding box, which leaves out the
// letter spacing after the last letter) is centred across; from the title's lowest ink to the
// name's highest is CARD_SIZE.gap x CARD_SCALE x H, and the two lines' ink together are centred up
// and down.
function drawText(g, W, H) {
  g.clearRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter'; // each line in its own channel, whatever overlaps
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const lines = [
    { text: CARD_TEXT.title, px: CARD_SIZE.title * CARD_SCALE * H, fill: '#ff0000' },
    { text: CARD_TEXT.name, px: CARD_SIZE.name * CARD_SCALE * H, fill: '#00ff00' },
  ];
  const set = (l) => {
    g.font = `${CARD_FONT.weight} ${l.px}px "${CARD_FONT.family}", sans-serif`;
    g.letterSpacing = `${CARD_TRACKING * l.px}px`;
  };
  for (const l of lines) {
    set(l);
    const m = g.measureText(l.text);
    // the ink from x - left to x + right about the pen, and from y - up to y + down about the baseline
    Object.assign(l, { left: m.actualBoundingBoxLeft, right: m.actualBoundingBoxRight, up: m.actualBoundingBoxAscent, down: m.actualBoundingBoxDescent });
  }
  const [title, name] = lines;
  const gap = CARD_SIZE.gap * CARD_SCALE * H;
  title.y = (H - (title.up + title.down + gap + name.up + name.down)) / 2 + title.up;
  name.y = title.y + title.down + gap + name.up;
  for (const l of lines) {
    set(l);
    g.fillStyle = l.fill;
    g.fillText(l.text, W / 2 - (l.right - l.left) / 2, l.y);
  }
}

export function createCardLayer(ctx) {
  const { THREE } = ctx;
  const ink = new THREE.Vector3(...hexRGB(CARD_INK));
  const uniforms = (text) => ({ uMask: { value: null }, uInk: { value: ink }, uA: { value: 0 }, uText: { value: text }, uNameAlpha: { value: CARD_NAME_ALPHA } });
  const black = uniforms(0);
  const letters = uniforms(1);
  const mesh = (u, order) => {
    const m = ctx.fullscreen(ctx.material({ vert: cardVert, frag: cardFrag, uniforms: u, blend: 'normal', common: false }), order);
    m.visible = false;
    return m;
  };
  const blackMesh = mesh(black, ctx.ORDER.card);
  const textMesh = mesh(letters, ctx.ORDER.card + 0.5);

  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const px = new THREE.Vector2();
  let made = ''; // the canvas size the texture was drawn for
  let texture = null;

  // the text texture for the canvas's size, drawn again when it has changed
  function textFor() {
    ctx.renderer.getDrawingBufferSize(px);
    const key = `${px.x}x${px.y}`;
    if (key === made) return texture;
    canvas.width = px.x;
    canvas.height = px.y;
    drawText(g, px.x, px.y);
    if (texture) texture.dispose();
    texture = new THREE.Texture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    // the canvas's own premultiplied values: R and G are the two lines' coverage as they are
    texture.premultiplyAlpha = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    made = key;
    return texture;
  }

  return {
    objects: [blackMesh, textMesh],
    update(state) {
      const { black: k, a } = state.card;
      letters.uMask.value = textFor();
      blackMesh.visible = k > 0;
      textMesh.visible = a > 0;
      black.uA.value = blackMesh.visible ? k : 0;
      letters.uA.value = textMesh.visible ? a : 0;
    },
  };
}
