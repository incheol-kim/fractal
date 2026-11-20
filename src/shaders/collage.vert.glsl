// Collage: one block's fragments in one mesh, in draw order: the previous cut (only while the
// current one is pasted over it), then the current cut, each as shadow, torn white edge, content.
// A fragment's state (a, dx, dy, s) comes from uLeaves (one texel per collage leaf row), the
// block's from the uniforms. The content's texture coordinates come from the rest position, so a
// fragment's picture moves with it and the fragments of a block fit together as one picture.
// The torn draw (uTornDraw, layers/collage.js) is the same vertices again: the current cut of the
// fragments being torn off (uTearing), over the photo pieces.
in vec2 position; // rest position, picture 0..1
in vec3 aOut;     // outline ribbons: xy the mitre for a half width of 1 times the side (picture px), z the side (+-1); 0 on fills
in vec4 aId;      // x: collage leaf row, y: part (0 shadow fill, 1 shadow ribbon, 2 torn edge, 3 content), z: layer (0 previous cut, 1 current cut), w: leaf id
in vec2 aLeafC;   // the leaf's centre, picture 0..1 (its own paste, s, scales about it)
in float aNb;     // outline ribbons: the collage row of the block's leaf across this outline point (-1: none)

uniform sampler2D uLeaves;  // a (0: not drawn by the block's mesh), dx, dy (stage heights at zoom 1), s
uniform sampler2D uTearing; // a fragment being torn off: x move (0..1), y fade (its opacity; 0: it is not being torn off); z rim (the opacity of its torn edge and shadow in the block's mesh); w cover (how much it covers the outline it shares with the block's other leaves, coverAcross in collage.js)
uniform int uStateW;
uniform float uTornDraw; // 1: this draw is the block's fragments being torn off; 0: the block's mesh
uniform vec2 uTearSize;  // a torn-off fragment's push (stage heights at zoom 1) and turn (degrees) at move 1, before its own 0.75..1.25
uniform float uOwnRimMin; // OWN_RIM_MIN (collage.js): the smallest own rim the torn edge's opening divides by
uniform vec4 uBlock; // xy: the block's box centre (picture 0..1); z: block row; w: the block's first depth level this frame
uniform vec4 uPaste; // x: u (the current cut's paste over the previous, 1 done); y: k (changes so far); z: 1 while the previous cut shows; w: loose
uniform vec3 uCurU;  // cutUV of the current cut: u = dot(uCurU, (x, y, 1)), v = dot(uCurV, (x, y, 1))
uniform vec3 uCurV;
uniform vec3 uPrevU; // the same for the previous cut
uniform vec3 uPrevV;
uniform vec4 uLen;   // x, y: torn edge width range; z, w: shadow offset range; 1/2160 of the stage height at zoom 1
uniform vec2 uLift;  // a cut being pasted at the start of its paste: x its extra scale, y its shadow's extra offset (times)
uniform float uMove; // ... and how far off its place it is (picture px; the direction is the block's and k's hash)

out vec2 vCurUV;
out vec2 vPrevUV;
out vec2 vRest;      // the rest position in picture px, the torn edge's noise domain (it stays with the paper)
out float vSide;     // across an outline ribbon: 0 on the outline, +-1 at its edges
out float vOpen;     // 1 where the outline is the outside of the block's pasted part (torn, white), 0 where a pasted leaf of the block lies across it; between while that leaf's rim fades below this one's
flat out vec4 vPart; // x: part, y: layer, z: loose, w: opacity (content 1, torn edge and shadow the rim; a fragment being torn off: its fade)
flat out uint vSeed; // the torn edge's noise: one per leaf and cut

vec4 fetch(sampler2D s, int i) {
  return texelFetch(s, ivec2(i % uStateW, i / uStateW), 0);
}

// A fragment being torn off, at move 0..1: the point p of it (picture 0..1) turned about the
// fragment's centre c and pushed away from the block's centre (both as it lies now), lifted
// (larger by uLift.x at move 1). How far it goes, which way it turns and how much come from a hash
// of its leaf id alone: push and turn 0.75..1.25 times uTearSize, the push's direction within 20
// degrees of straight out from the block's centre (from the hash where the centres meet).
vec2 tornOff(vec2 p, vec2 c, float move, uint leaf) {
  float h0 = u2f(hash3u(leaf, 0x3c6ef372u, 1u));
  float h1 = u2f(hash3u(leaf, 0x3c6ef372u, 2u));
  float h2 = u2f(hash3u(leaf, 0x3c6ef372u, 3u));
  float h3 = u2f(hash3u(leaf, 0x3c6ef372u, 4u));
  vec2 away = (c - uBlock.xy) * uPic.xy; // picture px
  float dir = (dot(away, away) > 1.0 ? atan(away.y, away.x) : 6.2831853 * h0) + (h1 - 0.5) * 0.6981317;
  float push = uTearSize.x * (0.75 + 0.5 * h2) * move * uPic.y / uPic.w; // stage heights -> picture px
  float turn = radians(uTearSize.y) * (0.75 + 0.5 * abs(2.0 * h3 - 1.0)) * (h3 < 0.5 ? -1.0 : 1.0) * move;
  vec2 d = (p - c) * uPic.xy * (1.0 + uLift.x * move);
  float cs = cos(turn);
  float sn = sin(turn);
  d = vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y) + push * vec2(cos(dir), sin(dir));
  return c + d / uPic.xy;
}

void main() {
  int row = int(aId.x + 0.5);
  int part = int(aId.y + 0.5);
  int layer = int(aId.z + 0.5);
  vec4 L = fetch(uLeaves, row);
  vec4 T = fetch(uTearing, row);
  bool torn = uTornDraw > 0.5; // its index holds the current cut only
  float loose = uPaste.w;
  bool hide = torn ? T.y <= 0.0 : (L.x <= 0.0 || (layer == 0 && uPaste.z < 0.5));
  if (hide || (part <= 2 && loose <= 0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not here: outside the clip box
    return;
  }
  // the cut on this layer: k changes so far for the current one, one fewer for the one under it
  float k = layer == 1 ? uPaste.y : uPaste.y - 1.0;
  // a cut being pasted comes down a little off its place and lifted (larger, its shadow farther)
  // and drops into place as u reaches 1, over the cut before it
  float lift = layer == 1 && uPaste.x < 1.0 ? 1.0 - uPaste.x * uPaste.x : 0.0;
  uint kk = uint(max(k, 0.0));
  uint blockRow = uint(uBlock.z + 0.5);

  float grow = 1.0 + uLift.x * lift;
  vec2 p = aLeafC + (position - aLeafC) * L.w;               // the fragment's own paste (s)
  p = uBlock.xy + (p - uBlock.xy) * grow;                    // the cut's paste, about the box centre
  float ang = 6.2831853 * u2f(hash3u(blockRow, kk, 0x68e31da4u));
  p += lift * uMove * vec2(cos(ang), sin(ang)) / uPic.xy;
  p += vec2(L.y / (uPic.z * uPic.w), L.z / uPic.w);          // the fragment's offset
  // the fragment's centre as it lies now (its own paste scales about it)
  vec2 c = p - (position - aLeafC) * L.w * grow;
  // sizes on the paper: 1/2160 of the stage height at zoom 1, in picture px
  float unit = uPic.y / (2160.0 * uPic.w);
  // outline ribbons reach a little past the widest torn edge; the fragment shader cuts the edge
  float halfW = (uLen.y + 1.5) * unit * loose;
  vec2 across = aOut.xy * halfW / uPic.xy;
  p += across;
  float shadowLift = lift;
  if (torn) {
    // torn off over the photo, lifting as a cut does before it lands: its shadow goes farther
    p = tornOff(p, c, T.x, uint(aId.w + 0.5));
    shadowLift = max(lift, T.x);
  }
  if (part <= 1) {
    // the shadow falls to the bottom right, a little differently for each cut of the block
    float sh = mix(uLen.z, uLen.w, u2f(hash3u(blockRow, kk, 0x5bd1e995u))) * loose * (1.0 + uLift.y * shadowLift);
    p += vec2(sh * unit) / uPic.xy;
  }

  vec3 rest = vec3(position, 1.0);
  vCurUV = vec2(dot(uCurU, rest), dot(uCurV, rest));
  vPrevUV = vec2(dot(uPrevU, rest), dot(uPrevV, rest));
  vRest = (position + across) * uPic.xy;
  vSide = aOut.z;
  // inside the block the fragments meet as one picture (offset a little, like the flats): no torn
  // edge where the leaf across the outline is pasted now, opening as it goes under a develop or
  // bleed piece as far as this fragment is more there than it (its cover against this one's rim,
  // T.z: openAcross in collage.js, exactly) and open once it is gone; a fragment torn off is torn
  // all round
  vOpen = torn || aNb < 0.0 ? 1.0 : clamp((T.z - fetch(uTearing, int(aNb + 0.5)).w) / max(T.z, uOwnRimMin), 0.0, 1.0);
  // under a develop or bleed piece the edge and shadow fade as it comes up (T.z, the timeline's rim)
  vPart = vec4(float(part), float(layer), loose, torn ? T.y : (part <= 2 ? T.z : 1.0));
  vSeed = hash3u(uint(aId.w + 0.5), kk, 0x2c1b3c6du);
  // depth: three levels per layer (shadow, edge, content), nearer for everything drawn later; all of
  // them beyond the photo pieces' (piece.vert.glsl: the mesh uses 0.99 .. -0.99 + 1.98 / (3 cuts),
  // a cut-out folding in the front mesh lies between that and -0.9905), which come later and must
  // pass over the collage. The shadow parts of one layer share a level, so where they overlap the
  // second one fails the LESS test and a pixel is darkened once. The torn draw uses the same levels
  // from -0.9905 (level 0) to -0.99795 (25 blocks), nearer than every photo piece, folding ones
  // too, so it passes over them; it draws content, edge, shadow in that order, each part failing
  // under the nearer ones drawn before it. piece.vert.glsl's TORN_Z mirrors -0.9905: the two must
  // change together.
  float level = uBlock.w + float(layer * 3 + max(part - 1, 0));
  gl_Position = vec4(picToClip(p), (torn ? -0.9905 : 0.9995) - level * 5e-5, 1.0);
}
