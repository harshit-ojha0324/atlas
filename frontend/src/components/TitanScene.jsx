import { memo, useEffect, useRef } from 'react';

// The world behind the whole app: Atlas, chained and kneeling, holding up a
// cracked and burning sky. Everything is drawn here, in code, and is decoration:
// the interface never depends on it, and it reads app state rather than owning any.
//
// Static layers (filtered SVG) are rasterised once and only ever moved or faded,
// so they stay cheap; the one thing redrawn per frame is the embers canvas.

const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const fix = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;

// Catmull-Rom through the points, as cubic Beziers: hand-placed points, organic curve.
function curve(points, closed = false) {
  const n = points.length;
  const at = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${fix(points[0])}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fix(c1)} ${fix(c2)} ${fix(p2)}`;
  }
  return closed ? `${d}Z` : d;
}

const right = (pts) => pts.map(([x, y]) => [500 + x, y]);
const left = (pts) => pts.map(([x, y]) => [500 - x, y]);

// His body, as separate masses of rock drawn back to front. Each overlaps the last
// and casts a shadow on it, which is what makes them read as muscle. Points are for
// the right side, as offsets from his centre line; every part but the centred ones
// is mirrored. Shade: top-lit by the fire (hot), or by the horizon as well (low).
const PARTS = [
  ['hot', [[250, 70], [262, 0], [352, -6], [366, 62], [338, 96], [282, 98]]], // hand on the sky
  ['hot', [[266, 78], [344, 60], [398, 118], [456, 196], [454, 254], [398, 264], [340, 216], [292, 150]]], // forearm
  ['hot', [[276, 300], [352, 226], [430, 214], [474, 250], [456, 306], [388, 352], [316, 392], [262, 366]]], // upper arm
  ['mid', [[-1, 338], [150, 330], [262, 348], [308, 440], [262, 548], [206, 628], [186, 700], [214, 770], [-1, 812]]], // torso
  ['hot', [[-1, 262], [70, 248], [150, 262], [238, 296], [250, 362], [130, 372], [-1, 372]]], // trapezius
  ['mid', [[120, 490], [240, 470], [262, 548], [206, 628], [184, 700], [136, 690], [114, 590]]], // oblique
  ['mid', [[16, 500], [98, 498], [106, 556], [20, 562]]], // abdominals
  ['mid', [[16, 568], [100, 564], [106, 624], [20, 628]]],
  ['mid', [[16, 634], [100, 630], [100, 690], [22, 696]]],
  ['hot', [[2, 372], [120, 346], [244, 362], [282, 432], [232, 500], [112, 516], [2, 494]]], // pectoral
  ['hot', [[214, 312], [272, 272], [346, 276], [392, 322], [372, 396], [312, 440], [246, 420]]], // deltoid
  ['low', [[30, 790], [110, 716], [212, 720], [298, 806], [320, 904], [276, 962], [158, 956], [84, 884]]], // thigh
  ['low', [[150, 948], [274, 928], [322, 978], [300, 1044], [176, 1048], [132, 1002]]], // knee
];
// the plate of rock at his hips, and his head with its crown of broken stone
const LOINS = curve([[440, 742], [500, 726], [560, 742], [544, 826], [500, 880], [456, 826]], true);
const HEAD = curve(
  [
    [504, 246], [522, 222], [534, 254], [556, 240], [570, 272], [574, 310], [560, 354], [536, 392],
    [500, 410], [464, 392], [440, 354], [426, 310], [432, 268], [450, 234], [464, 258], [486, 216],
  ],
  true,
);
const BROW = curve([[436, 314], [470, 306], [500, 318], [530, 306], [564, 314], [558, 324], [530, 322], [500, 330], [470, 322], [442, 324]], true);

const PART_PATHS = PARTS.flatMap(([shade, pts]) => {
  const mirrored = pts[0][0] < 0 ? [] : [curve(left(pts), true)];
  return [...mirrored, curve(right(pts), true)].map((d) => ({ shade, d }));
});
const SILHOUETTE = [...PART_PATHS.map((p) => p.d), LOINS, HEAD];

const chainLink = (x, y, angle, face, key) => (
  <rect
    key={key}
    x={face ? -7.5 : -2.6}
    y={-15}
    width={face ? 15 : 5.2}
    height={30}
    rx={face ? 7.5 : 2.6}
    transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})`}
    className={face ? 'chain-face' : 'chain-edge'}
  />
);

// One chain hanging between two points, link by link along its sag.
function chain(a, b, sag, id) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.abs(sag) * 0.8;
  const count = Math.max(3, Math.round(length / 23));
  const links = [];
  const point = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + sag * 4 * t * (1 - t)];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const [p, q] = [point(Math.max(0, t - 0.01)), point(Math.min(1, t + 0.01))];
    const angle = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI - 90;
    links.push(chainLink(...point(t), angle, i % 2 === 0, `${id}-${i}`));
  }
  return links;
}

// Chains bound across the body, then the long ones running off out of the frame.
const pair = (a, b, sag, id) => [
  ...chain([500 + a[0], a[1]], [500 + b[0], b[1]], sag, `${id}r`),
  ...chain([500 - a[0], a[1]], [500 - b[0], b[1]], sag, `${id}l`),
];
const BOUND = [
  ...chain([232, 372], [768, 372], 110, 'chest'),
  ...chain([236, 488], [764, 488], 70, 'ribs'),
  ...chain([312, 700], [688, 700], 44, 'hip'),
  ...pair([290, 148], [424, 150], 22, 'arm'),
  ...pair([270, 92], [372, 92], 12, 'wrist'),
  ...pair([322, 306], [462, 262], 24, 'bicep'),
  ...pair([92, 846], [306, 860], 30, 'thigh'),
];
const FREE = [
  ...pair([372, 92], [1220, -40], 96, 'sky'),
  ...pair([462, 262], [1240, 240], 120, 'shoulder'),
  ...pair([290, 520], [700, 1040], 44, 'side'),
  ...pair([210, 730], [520, 1060], 28, 'low'),
];

// A fissure wanders from a point in a general direction, forking as it goes.
function fissures(seed, starts) {
  const rand = rng(seed);
  const paths = [];
  const grow = (x, y, heading, steps, width) => {
    const pts = [[x, y]];
    let angle = heading;
    for (let i = 0; i < steps; i++) {
      angle += (rand() - 0.5) * 1.3 + (heading - angle) * 0.34;
      x += Math.cos(angle) * (9 + rand() * 13);
      y += Math.sin(angle) * (9 + rand() * 13);
      pts.push([x, y]);
      if (width > 1.6 && rand() < 0.17) {
        grow(x, y, angle + (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.7), Math.ceil((steps - i) * 0.6), width * 0.56);
      }
    }
    paths.push({ d: curve(pts), width });
  };
  for (const [x, y, heading, steps, width] of starts) grow(x, y, heading, steps, width);
  return paths;
}

const both = (x, y, heading, steps, width) => [
  [500 + x, y, heading, steps, width],
  [500 - x, y, Math.PI - heading, steps, width],
];
const DOWN = Math.PI / 2;
// Molten from the hands to the heart, in four strengths: each set lights as the
// library grows (see --charge), so a full library burns visibly hotter than an empty one.
const VEINS = [
  fissures(21, [[500, 462, DOWN, 17, 9], [500, 410, -DOWN, 2, 4], ...both(34, 436, 0.28, 11, 4.4), ...both(30, 470, 0.9, 8, 3)]),
  fissures(33, [...both(308, 62, 1.0, 13, 4.2), ...both(120, 300, 0.3, 8, 3.2), [500, 240, DOWN, 5, 2.8], [468, 232, 1.9, 5, 2.2], [534, 232, 1.2, 5, 2.2]]),
  fissures(47, [...both(424, 244, 2.7, 11, 3.8), ...both(300, 300, 1.75, 8, 3.2), ...both(190, 500, 1.85, 9, 2.8)]),
  fissures(59, [...both(204, 738, 1.2, 12, 4), ...both(226, 958, 0.9, 4, 3), ...both(60, 500, DOWN, 9, 2.4), [530, 262, 1.9, 5, 2]]),
];

const Veins = memo(function Veins({ paths, className }) {
  return (
    <g className={className} clipPath="url(#t-silhouette)">
      <g className="vein-glow" filter="url(#t-glow)">
        {paths.map((p, i) => (
          <path key={i} d={p.d} strokeWidth={p.width * 2.4} />
        ))}
      </g>
      <g className="vein-core">
        {paths.map((p, i) => (
          <path key={i} d={p.d} strokeWidth={p.width * 0.72} />
        ))}
      </g>
    </g>
  );
});

// The rock of the sky: lit stone, its underside hanging in broken teeth, torn open by
// lava. Contour lines of fractal noise read as branching cracks; a second, coarser
// noise breaks them into patches, so some of the sky is whole and some is burning.
const [SKY_EDGE, SKY_LIP] = (() => {
  const rand = rng(91);
  const lip = [];
  for (let x = -40; x <= 1640; x += 26 + rand() * 34) {
    lip.push([x, 206 + Math.sin(x / 170) * 12 + (rand() < 0.3 ? 16 + rand() * 30 : (rand() - 0.5) * 16)]);
  }
  const line = lip.map(fix).join('L');
  return [`M-40 -10L1640 -10L1640 ${lip.at(-1)[1].toFixed(1)}L${lip.slice().reverse().map(fix).join('L')}Z`, `M${line}`];
})();

const Sky = memo(function Sky() {
  return (
    <div className="sky">
      <svg viewBox="0 0 1600 270" preserveAspectRatio="none">
        <defs>
          <filter id="s-rock" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.011 0.042" numOctaves="6" seed="4" result="n" />
            <feDiffuseLighting in="n" surfaceScale="9" diffuseConstant="0.95" lightingColor="#7c5340">
              <feDistantLight azimuth="90" elevation="44" />
            </feDiffuseLighting>
            <feComposite in2="SourceAlpha" operator="in" />
          </filter>
          <linearGradient id="s-shade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#050201" stopOpacity=".86" />
            <stop offset=".5" stopColor="#0b0504" stopOpacity=".48" />
            <stop offset="1" stopColor="#3a1206" stopOpacity=".2" />
          </linearGradient>
        </defs>
        <path d={SKY_EDGE} fill="#000" filter="url(#s-rock)" />
        <path d={SKY_EDGE} fill="url(#s-shade)" />
      </svg>
      <svg className="sky-heat" viewBox="0 0 1600 270" preserveAspectRatio="none">
        <defs>
          <filter id="s-lava" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.0075 0.026" numOctaves="4" seed="17" />
            <feColorMatrix values="0 0 0 0 1  0 0 0 0 .6  0 0 0 0 .16  1 0 0 0 0" />
            <feComponentTransfer result="lines">
              <feFuncA type="table" tableValues="0 0 0 0 0 0 0 0 0 0 0 .9 0 0 0 0 0 0 0 0 0 0 0" />
            </feComponentTransfer>
            <feTurbulence type="fractalNoise" baseFrequency="0.0034 0.016" numOctaves="2" seed="29" />
            <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  5 0 0 0 -2.15" result="patches" />
            <feComposite in="lines" in2="patches" operator="in" result="fissures" />
            <feGaussianBlur in="fissures" stdDeviation="3.4" result="glow" />
            <feColorMatrix in="glow" values="1 0 0 0 0  0 .45 0 0 0  0 0 .18 0 0  0 0 0 1.5 0" result="red" />
            <feColorMatrix in="fissures" values="1 0 0 0 0  0 1.25 0 0 .22  0 0 1 0 .3  0 0 0 1 0" result="hot" />
            <feMerge result="burn">
              <feMergeNode in="red" />
              <feMergeNode in="hot" />
            </feMerge>
            <feComposite in="burn" in2="SourceAlpha" operator="in" />
          </filter>
          <filter id="s-lip" x="-2%" y="-60%" width="104%" height="220%">
            <feGaussianBlur stdDeviation="9 4" />
          </filter>
        </defs>
        <path d={SKY_EDGE} fill="#000" filter="url(#s-lava)" />
        <path d={SKY_LIP} fill="none" stroke="#ff5a14" strokeWidth="10" filter="url(#s-lip)" opacity=".85" />
        <path d={SKY_LIP} fill="none" stroke="#ffb15a" strokeWidth="1.4" opacity=".7" />
      </svg>
    </div>
  );
});

// Three stacked layers: chains that sway, the rock that never changes, the heat that breathes.
const Titan = memo(function Titan() {
  return (
    <div className="titan">
      <svg viewBox="0 0 1000 1000">
        <defs>
          <radialGradient id="t-fire" cx=".5" cy=".42" r=".5">
            <stop offset="0" stopColor="#ffa24a" />
            <stop offset=".22" stopColor="#f2571a" />
            <stop offset=".5" stopColor="#a52e0c" />
            <stop offset=".78" stopColor="#511708" stopOpacity=".62" />
            <stop offset="1" stopColor="#2c0d05" stopOpacity="0" />
          </radialGradient>
          <filter id="t-billow" x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="4" seed="8" />
            <feDisplacementMap in="SourceGraphic" scale="170" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
        <ellipse cx="500" cy="180" rx="620" ry="430" fill="url(#t-fire)" filter="url(#t-billow)" />
      </svg>
      <svg className="titan-chains" viewBox="0 0 1000 1000">
        {FREE}
      </svg>
      <svg viewBox="0 0 1000 1000">
        <defs>
          <clipPath id="t-union">
            {SILHOUETTE.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </clipPath>
          <filter id="t-rock" x="0" y="-5%" width="100%" height="110%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.024 0.03" numOctaves="6" seed="11" result="n" />
            <feDiffuseLighting in="n" surfaceScale="8" diffuseConstant="1.15" lightingColor="#ffffff">
              <feDistantLight azimuth="265" elevation="58" />
            </feDiffuseLighting>
          </filter>
          <filter id="t-part" x="-25%" y="-25%" width="150%" height="150%">
            <feDropShadow dx="0" dy="7" stdDeviation="7" floodColor="#020100" floodOpacity=".92" />
          </filter>
          <filter id="t-halo" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id="t-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <radialGradient id="t-hot" cx=".5" cy=".5" r=".62" fx=".5" fy=".2">
            <stop offset="0" stopColor="#5e3c2d" />
            <stop offset=".36" stopColor="#35211a" />
            <stop offset=".72" stopColor="#170d0a" />
            <stop offset="1" stopColor="#070302" />
          </radialGradient>
          <radialGradient id="t-mid" cx=".5" cy=".5" r=".64" fx=".5" fy=".26">
            <stop offset="0" stopColor="#41291f" />
            <stop offset=".42" stopColor="#261712" />
            <stop offset=".78" stopColor="#110907" />
            <stop offset="1" stopColor="#060302" />
          </radialGradient>
          <radialGradient id="t-low" cx=".5" cy=".5" r=".66" fx=".5" fy=".82">
            <stop offset="0" stopColor="#4d3421" />
            <stop offset=".42" stopColor="#281a11" />
            <stop offset=".8" stopColor="#100906" />
            <stop offset="1" stopColor="#050302" />
          </radialGradient>
          <linearGradient id="t-face" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4c2f23" />
            <stop offset=".26" stopColor="#21130e" />
            <stop offset=".62" stopColor="#090403" />
            <stop offset="1" stopColor="#170c08" />
          </linearGradient>
          <linearGradient id="t-edge-hot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ff9a4d" stopOpacity=".85" />
            <stop offset=".3" stopColor="#d9531a" stopOpacity=".4" />
            <stop offset=".6" stopColor="#d9531a" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="t-edge-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c8561f" stopOpacity=".5" />
            <stop offset=".4" stopColor="#c8561f" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="t-edge-low" x1="0" y1="0" x2="0" y2="1">
            <stop offset=".4" stopColor="#e0a040" stopOpacity="0" />
            <stop offset="1" stopColor="#f0b24a" stopOpacity=".62" />
          </linearGradient>
        </defs>

        {/* the fire behind him bleeding around his edges */}
        <g filter="url(#t-halo)" fill="#ff6a1f" opacity=".82">
          {SILHOUETTE.map((d, i) => (
            <path key={i} d={d} stroke="#ff6a1f" strokeWidth="5" />
          ))}
        </g>

        {PART_PATHS.map((p, i) => (
          <path key={i} d={p.d} fill={`url(#t-${p.shade})`} stroke={`url(#t-edge-${p.shade})`} strokeWidth="2.4" filter="url(#t-part)" />
        ))}
        <path d={LOINS} fill="url(#t-mid)" stroke="url(#t-edge-low)" strokeWidth="2" filter="url(#t-part)" />

        {/* the bowed head, with its face in its own shadow: a brow and two slits of fire */}
        <path d={HEAD} fill="url(#t-face)" stroke="url(#t-edge-hot)" strokeWidth="3" filter="url(#t-part)" />
        <path d={BROW} fill="#3b241b" stroke="url(#t-edge-hot)" strokeWidth="1.6" filter="url(#t-part)" />

        {/* one rock over all of him, so the parts read as a single carved thing */}
        <g clipPath="url(#t-union)" style={{ mixBlendMode: 'overlay' }} opacity=".78">
          <rect x="0" y="-30" width="1000" height="1090" fill="#000" filter="url(#t-rock)" />
        </g>
        <g clipPath="url(#t-union)" fill="none" stroke="#040201" strokeLinecap="round" filter="url(#t-soft)" opacity=".8">
          {[
            [[0, 372], [0, 500]],
            [[0, 496], [0, 722]],
            [[310, 92], [356, 150], [408, 226]],
            [[296, 118], [336, 168], [372, 216]],
            [[150, 760], [196, 830], [226, 936]],
            [[230, 760], [264, 840], [282, 926]],
          ].flatMap((c, i) => [
            <path key={`r${i}`} d={curve(right(c))} strokeWidth="9" />,
            <path key={`l${i}`} d={curve(left(c))} strokeWidth="9" />,
          ])}
        </g>

        <g className="titan-bound">{BOUND}</g>
      </svg>
      <svg className="titan-heat" viewBox="0 0 1000 1000">
        <defs>
          <clipPath id="t-silhouette">
            {SILHOUETTE.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </clipPath>
          <filter id="t-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter id="t-eye" x="-40%" y="-200%" width="180%" height="500%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* the molten fissures; lit by --charge, set by set */}
        {VEINS.map((paths, i) => (
          <Veins key={i} paths={paths} className={`veins veins-${i}`} />
        ))}

        <g fill="none" stroke="#ff8a2a" strokeWidth="5" strokeLinecap="round" filter="url(#t-eye)">
          <path d="M456 333 Q470 327 486 335 M544 333 Q530 327 514 335" />
        </g>
        <path d="M458 333 Q470 329 484 335 M542 333 Q530 329 516 335" fill="none" stroke="#ffd98a" strokeWidth="1.8" strokeLinecap="round" />

        {/* Atlas's own mark, burning at the heart of the titan */}
        <g className="titan-core">
          <g className="core-mark" fill="none" strokeLinecap="round">
            <circle cx="500" cy="436" r="27" strokeWidth="3.4" />
            <ellipse cx="500" cy="436" rx="27" ry="8" strokeWidth="2.2" />
            <ellipse cx="500" cy="436" rx="9" ry="27" strokeWidth="2.2" />
            <ellipse cx="500" cy="436" rx="27" ry="10" strokeWidth="2.6" transform="rotate(-23.5 500 436)" />
          </g>
        </g>
      </svg>
      <div className="core-halo" />
    </div>
  );
});

// Broken rock at the edges of the ground, where the chains are anchored.
const SPIRES = (() => {
  const rand = rng(77);
  const spire = (x, height, width) => {
    const pts = [[x - width, 300], [x - width * 0.5, 300 - height * 0.5], [x - width * 0.18, 300 - height * 0.72], [x, 300 - height], [x + width * 0.2, 300 - height * 0.68], [x + width * 0.55, 300 - height * 0.42], [x + width, 300]];
    return `M${pts.map(fix).join('L')}Z`;
  };
  const out = [];
  for (let i = 0; i < 9; i++) {
    out.push(spire(rand() * 300, 70 + rand() * 190, 26 + rand() * 40));
    out.push(spire(1600 - rand() * 300, 70 + rand() * 190, 26 + rand() * 40));
  }
  return out.join('');
})();

const Ground = memo(function Ground() {
  return (
    <div className="stage-ground">
      <svg viewBox="0 0 1600 300" preserveAspectRatio="none">
        <path d={SPIRES} fill="#0a0504" />
      </svg>
    </div>
  );
});

// Every ready document is a star over the horizon, placed by its id so it stays put.
function Stars({ documents }) {
  return (
    <div className="stars">
      {documents.slice(0, 48).map((doc) => {
        const rand = rng(doc.id * 7919 + 13);
        rand();
        return (
          <i
            key={doc.id}
            className={doc.status === 'ready' ? 'star' : 'star pending'}
            style={{ left: `${3 + rand() * 94}%`, top: `${34 + rand() * 30}%`, '--twinkle': `${3 + rand() * 4}s` }}
          />
        );
      })}
    </div>
  );
}

function useEmbers(canvasRef, stageRef, readingRef, burstRef) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const g = canvas.getContext('2d');
    const rig = stage.querySelector('.rig');
    const sky = stage.querySelector('.sky');
    const rand = rng(1234);
    const embers = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = performance.now();
    let spawn = 0;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * scale;
      canvas.height = height * scale;
      g.setTransform(scale, 0, 0, scale, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const add = (x, y, speed) => {
      if (embers.length >= 170) embers.shift();
      embers.push({
        x,
        y,
        vx: (rand() - 0.5) * speed * 0.7,
        vy: -(0.45 + rand() * 0.8) * speed,
        life: 0,
        span: 2.4 + rand() * 4.2,
        size: 0.7 + rand() * 1.9,
        seed: rand() * 100,
      });
    };

    // the pointer leans the scene a little, so it is alive before anyone clicks
    const onPointer = (e) => {
      if (e.pointerType !== 'mouse') return;
      pointer.tx = (e.clientX / width - 0.5) * 2;
      pointer.ty = (e.clientY / height - 0.5) * 2;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 2.4);
      pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 2.4);
      rig.style.translate = `${(pointer.x * -12).toFixed(2)}px ${(pointer.y * -4).toFixed(2)}px`;
      sky.style.translate = `${(pointer.x * -5).toFixed(2)}px 0`;

      const box = rig.getBoundingClientRect();
      const rate = readingRef.current ? 34 : 11;
      spawn += dt * rate;
      for (; spawn > 1; spawn--) {
        const fromBody = rand() < 0.62;
        add(
          fromBody ? box.left + box.width * (0.18 + rand() * 0.64) : rand() * width,
          fromBody ? box.top + box.height * (0.25 + rand() * 0.7) : height * (0.74 + rand() * 0.28),
          readingRef.current ? 62 : 38,
        );
      }
      if (burstRef.current) {
        for (let i = 0; i < 70; i++) {
          add(box.left + box.width * (0.3 + rand() * 0.4), box.top + box.height * (0.1 + rand() * 0.5), 120);
        }
        burstRef.current = false;
      }

      g.clearRect(0, 0, width, height);
      g.globalCompositeOperation = 'lighter';
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.life += dt;
        if (e.life > e.span) {
          embers.splice(i, 1);
          continue;
        }
        e.vx += Math.sin(now / 900 + e.seed) * dt * 16;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        const fade = Math.min(e.life / 0.4, 1) * (1 - e.life / e.span);
        g.fillStyle = `rgba(255,${Math.round(110 + 90 * (1 - e.life / e.span))},50,${(fade * 0.9).toFixed(3)})`;
        g.beginPath();
        g.arc(e.x, e.y, e.size, 0, 6.283);
        g.fill();
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
    };
  }, [canvasRef, stageRef, readingRef, burstRef]);
}

// mode: signin | ask | thread | library. charge: 0-1, how much the library holds.
export default function TitanScene({ mode, charge = 0.2, reading = false, documents = [] }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const readingRef = useRef(reading);
  const burstRef = useRef(true); // the first frames: the sky lands on his hands
  const wasReading = useRef(reading);

  useEmbers(canvasRef, stageRef, readingRef, burstRef);

  useEffect(() => {
    readingRef.current = reading;
    if (wasReading.current && !reading) burstRef.current = true; // an answer arrives: he holds, sparks fly
    wasReading.current = reading;
  }, [reading]);

  return (
    <div
      ref={stageRef}
      className="stage"
      data-mode={mode}
      data-reading={reading || undefined}
      style={{ '--charge': charge.toFixed(3) }}
      aria-hidden="true"
    >
      <div className="stage-backdrop" />
      <div className="stage-moon" />
      <Stars documents={documents.filter((d) => d.status !== 'failed')} />
      <div className="rig">
        <Titan />
      </div>
      <Sky />
      <Ground />
      <canvas ref={canvasRef} className="embers" />
      <div className="stage-scrim" />
    </div>
  );
}
