import * as THREE from 'three';
import { height, valleyX, noise2 } from './terrain.js';

const params = new URLSearchParams(location.search);
const RENDER = params.has('render');
const PHONE = matchMedia('(pointer: coarse)').matches;
const FILM_LEN = 15;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !RENDER, preserveDrawingBuffer: RENDER, powerPreference: 'high-performance' });
renderer.setPixelRatio(RENDER ? Number(params.get('rs') || 2) : Math.min(devicePixelRatio, PHONE ? 2 : 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(params.get('exp') || 1.05);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 2, 60000);

// --- 日：朝、谷の奥（北東）の低い空から。正面やや右からの半逆光で、葉が透けて光る ---
const SUN = new THREE.Vector3(Number(params.get('sx') || 0.62), Number(params.get('sy') || 0.52), Number(params.get('sz') || 0.45)).normalize();
const SUN_COL = new THREE.Color(1.0, 0.80, 0.58);
const sun = new THREE.DirectionalLight(SUN_COL, 4.0);
sun.castShadow = true;
sun.shadow.mapSize.set(RENDER ? 8192 : (PHONE ? 2048 : 4096), RENDER ? 8192 : (PHONE ? 2048 : 4096));
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
const SH = 1100;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 10, far: 9000 });
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(new THREE.Color(0.50, 0.62, 0.90), new THREE.Color(0.32, 0.14, 0.04), 0.6);
scene.add(hemi);

// --- 空気：遠いほど空の色へ、谷底には朝霧。全部の物に同じ式をかける ---
const AIR = /* glsl */`
uniform vec3 uSun;
uniform float uT;
uniform vec3 uCam;
uniform float uMist;
vec3 skyCol(vec3 d) {
  float h = max(d.y, 0.0);
  vec3 zen = vec3(0.10, 0.26, 0.72), hor = vec3(0.62, 0.72, 0.84);
  vec3 c = mix(hor, zen, pow(h, 0.45));
  float s = max(dot(d, uSun), 0.0);
  c += vec3(1.0, 0.78, 0.52) * (0.55 * pow(s, 6.0) + 0.9 * pow(s, 60.0));
  return c * 1.25;
}
vec3 aerial(vec3 col, vec3 wp) {
  vec3 dv = wp - uCam; float dist = length(dv); vec3 d = dv / dist;
  // 空気の霞（青白く）
  float fa = 1.0 - exp(-dist / 8000.0);
  // 谷の朝霧：高さで指数的に薄くなる層を、視線に沿って積分する
  float H = 55.0, h0 = 0.0, a = uMist;
  float ky = d.y * dist / H;
  float base = exp(-(uCam.y - h0) / H);
  float od = a * dist * base * (abs(ky) > 1e-3 ? (1.0 - exp(-ky)) / ky : 1.0);
  float fm = 1.0 - exp(-od);
  vec3 sc = skyCol(vec3(d.x, max(d.y, 0.02), d.z));
  float s = max(dot(d, uSun), 0.0);
  vec3 mistCol = vec3(1.0, 0.93, 0.84) * (0.95 + 1.4 * pow(s, 4.0));
  col = mix(col, sc, fa);
  col = mix(col, mistCol, fm);
  return col;
}
`;
const airUniforms = { uT: { value: 0 }, uSun: { value: SUN }, uCam: { value: camera.position }, uMist: { value: Number(params.get('mist') || 0.012) } };

// 標準の材質に「世界座標」「空気」「葉の透け・葉むらの粗さ」を足す
function patch(mat, kind) {
  mat.customProgramCacheKey = () => 'patch-' + kind;   // 種類ごとに別のシェーダー（同じ関数なので既定だと使い回される）
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, airUniforms);
    if (kind === 'fly') sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVar;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv.x = (vMapUv.x + aVar) * 0.25;');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vLP;\nattribute float aCv;\nvarying float vCv;\n' + NOISE3)
      .replace('#include <begin_vertex>', kind === 'leaf' ? `#include <begin_vertex>
  #ifdef USE_INSTANCING
  vec3 seed = instanceMatrix[3].xyz * 0.37;
  #else
  vec3 seed = vec3(0.0);
  #endif
  transformed += objectNormal * (0.08 * vn3(transformed * 9.0 + seed) + 0.04 * vn3(transformed * 21.0 - seed));` : '#include <begin_vertex>')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 wpp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wpp = instanceMatrix * wpp;
  #endif
  vWP = (modelMatrix * wpp).xyz; vLP = transformed; vCv = aCv;`);
    let fs = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vLP;\nvarying float vCv;\n' + AIR + NOISE3 + CLOUD)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directDiffuse *= cloudShadow(vWP); reflectedLight.directSpecular *= cloudShadow(vWP);');
    if (kind === 'leaf') {
      // 葉むら：細かい雑音で暗いすき間と明るい葉を作り、色も少し揺らす
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
  // 画面の1画素より細かい葉は描かず、平均の暗さにする（ざらつき防止）
  float fw = length(fwidth(vWP)) * 1.0;
  float fine = smoothstep(0.9, 0.3, fw);
  diffuseColor.rgb *= vec3(vCv, pow(vCv, 1.6), pow(vCv, 2.2));   // 明るい塊ほど黄みに
  float lf = mix(0.5 * fbm3(vWP * 0.6), fbm3(vWP * 2.6), fine);
  float hole = mix(0.32, smoothstep(0.05, -0.45, lf), 0.35 + 0.65 * fine);
  diffuseColor.rgb *= mix(1.0, 0.22, hole) * (0.9 + 0.25 * fbm3(vWP * 0.23 + 7.0));
  // 樹冠の下ほど暗い（内側の自己陰）
  diffuseColor.rgb *= mix(0.25, 1.0, smoothstep(-0.7, 0.75, vLP.y));`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    float hb = lf + 0.5 * fine * fbm3(vWP * 4.1);
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float dhx = dFdx(hb), dhy = dFdy(hb);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    normal = normalize(abs(det) * normal - 0.35 * grad);
  }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  // 日を透かして見る葉は光る
  vec3 vd = normalize(vWP - uCam);
  float tr = pow(max(dot(vd, uSun), 0.0), 3.0);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.85, 0.6) * tr * 1.6 * (1.0 - 0.6 * hole);`);
    }
    if (kind === 'card') {
      // 葉の房の板：絵柄（葉の形・明暗）は貼った絵から。板の向きでなく樹冠の丸みで光を受ける
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= vec3(vCv, pow(vCv, 1.5), pow(vCv, 2.0));   // 明るい房ほど黄みに
  float rr = length(vLP * vec3(1.0, 1.35, 1.0));
  diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.15, 0.85, rr));   // 樹冠の奥ほど暗い
  diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(-0.45, 0.4, vLP.y)); // 下ほど暗い`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  normal = normalize(vNormal);`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  vec3 vd = normalize(vWP - uCam);
  float tr = pow(max(dot(vd, uSun), 0.0), 3.0);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.85, 0.6) * tr * 1.6;`);
    }
    if (kind === 'needle') {
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= vCv;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  normal = normalize(vNormal);`);
    }
    if (kind === 'fly') {
      fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  vec3 vd = normalize(vWP - uCam);
  float tr = pow(max(dot(vd, uSun), 0.0), 2.0);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.82, 0.55) * (0.15 + 1.6 * tr);`);
    }
    if (kind === 'ground') {
      fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
  // 樹冠の粒（径 10m ほど）を明暗で描く：遠くの山肌が林に見えるように
  float cn = vn3(vec3(vWP.xz * 0.11, 0.0)) * 0.6 + vn3(vec3(vWP.xz * 0.27, 3.0)) * 0.4;
  diffuseColor.rgb *= 0.45 + 0.8 * smoothstep(-0.5, 0.6, cn);
  // 木ごとの色の違い（黄・橙・赤）を、粒の大きさで
  float hv = vn3(vec3(vWP.xz * 0.09, 9.0));
  diffuseColor.rgb *= mix(vec3(1.15, 1.05, 0.8), vec3(1.05, 0.6, 0.55), smoothstep(-0.4, 0.5, hv));
  diffuseColor.rgb *= 0.85 + 0.3 * fbm3(vWP * 0.01);`);
    }
    fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = aerial(gl_FragColor.rgb, vWP);');
    sh.fragmentShader = fs;
  };
  return mat;
}
// 晴れの日の積雲：高さ 2.2km の層。風で流れる。空にも、地面に落ちる影にも同じ雲を使う
const CLOUD = /* glsl */`
float cdens(vec2 p) {
  p += vec2(1800.0, -900.0) + vec2(14.0, -9.0) * uT;
  float n = fbm3(vec3(p * 0.00032, 1.7)) + 0.35 * fbm3(vec3(p * 0.0011, 4.2));
  return smoothstep(0.02, 0.4, n);
}
float cloudShadow(vec3 wp) {
  vec2 p = wp.xz + uSun.xz / max(uSun.y, 0.1) * (2200.0 - wp.y);
  return 1.0 - 0.8 * smoothstep(0.1, 0.7, cdens(p));
}
`;
const NOISE3 = /* glsl */`
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z) * 2.0 - 1.0;
}
float fbm3(vec3 p) { return 0.55 * vn3(p) + 0.3 * vn3(p * 2.1 + 3.1) + 0.15 * vn3(p * 4.3 + 7.7); }
`;

// --- 地形：近く（8km 四方・細かい）と遠く（60km 四方・粗い）の2枚 ---
const NEAR = 8000, NN = RENDER ? 1024 : (PHONE ? 384 : 640);
function terrainGeo(size, n, oct, sink) {
  const g = new THREE.PlaneGeometry(size, size, n, n); g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    let y = height(x, z, oct);
    if (sink && Math.abs(x) < NEAR / 2 - 200 && Math.abs(z) < NEAR / 2 - 200) y -= 80;
    p.setY(i, y);
  }
  g.computeVertexNormals();
  const nrm = g.attributes.normal, farArr = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), ny = nrm.getY(i);
    // 斜面が急な所は岩、それ以外は林床（遠くでは紅葉の色の平均）
    const rock = THREE.MathUtils.smoothstep(0.34, 0.22, ny) * (sink ? 0 : Math.exp(-((x - valleyX(z)) ** 2) / (2 * 60 * 60)));
    const c = canopyColor(x, z, p.getY(i), Math.random());
    // 木を置かない所（遠景・ページで省いた所）は、地面の色を林の明るさにする
    const bare = sink ? 1 : (RENDER ? 0 : THREE.MathUtils.smoothstep(Math.max(Math.abs(x - valleyX(z)) - 1200, -1200 - z), -60, 60));
    const far = 0.15 + 0.3 * bare;
    farArr[i] = far;
    let r = c.r * far, gg = c.g * far, b = c.b * far;
    r = r * (1 - rock) + 0.16 * rock; gg = gg * (1 - rock) + 0.13 * rock; b = b * (1 - rock) + 0.10 * rock;
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.userData.final = col.slice();
  g.userData.turn = Float32Array.from({ length: p.count }, (_, i) => turnDay(p.getY(i), (i * 0.618) % 1));
  g.userData.far = farArr;
  return g;
}

// 紅葉の色：種類の群れ（低い周波数）＋1本ごとのばらつき。高い所ほど進んでいる（赤・茶）
const PAL = {
  orange: new THREE.Color().setRGB(0.62, 0.10, 0.006),
  rust: new THREE.Color().setRGB(0.42, 0.06, 0.008),
  yellow: new THREE.Color().setRGB(0.68, 0.30, 0.008),
  red: new THREE.Color().setRGB(0.62, 0.035, 0.015),
  green: new THREE.Color().setRGB(0.14, 0.19, 0.03),
  conifer: new THREE.Color().setRGB(0.30, 0.42, 0.30),
};
function canopyColor(x, z, y, r) {
  const sp = noise2(x / 160, z / 160) * 0.7 + noise2(x / 45, z / 45) * 0.3;
  const alt = THREE.MathUtils.clamp((y - 150) / 700, 0, 1);
  const c = new THREE.Color();
  if (sp > 0.15) c.copy(PAL.yellow).lerp(PAL.orange, r * 0.6);
  else if (sp < -0.4) c.copy(PAL.rust).lerp(PAL.orange, r);
  else c.copy(PAL.orange).lerp(PAL.yellow, r * 0.7);
  if (r > 0.91 + 0.06 * (1 - alt)) c.copy(PAL.red).lerp(PAL.orange, (r - 0.91) * 5);
  if (alt < 0.12 && r < 0.18) c.lerp(PAL.green, 0.5);
  return c;
}

// 色づく日（10/1 からの日数）：標高が高いほど早く、1本ごとに ±4 日ばらつく
function turnDay(y, r) {
  const alt = THREE.MathUtils.clamp((y - 100) / 650, 0, 1);
  return 35 - 17 * alt + 8 * (r - 0.5);
}
// その日の色：緑 → 紅葉（final） → 散りかけ（くすんで暗い）
const _c = new THREE.Color();
function seasonColor(final, T, day, out) {
  if (day === null) return out.copy(final);
  const k = THREE.MathUtils.smoothstep(day, T - 7, T + 3);
  out.copy(PAL.green).lerp(final, k);
  const late = THREE.MathUtils.smoothstep(day, T + 10, T + 24);
  return out.lerp(_c.setRGB(final.r * 0.42, final.g * 0.36, final.b * 0.3), late * 0.85);
}
const groundMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }), 'ground');
const nearT = new THREE.Mesh(terrainGeo(NEAR, NN, 8, false), groundMat);
nearT.receiveShadow = true;
const farT = new THREE.Mesh(terrainGeo(60000, RENDER ? 768 : 384, 6, true), groundMat);
farT.receiveShadow = false;
scene.add(nearT, farT);

// --- 木：広葉樹（葉の塊を寄せた樹冠）と杉（細い円錐を重ねた形） ---
// 樹冠：小さな葉の塊を 20 個前後、樹冠の外形（楕円体）の表面近くに散らす。塊ごとに明るさと色味を変える。
// 形は 4 種類（丸い・縦長・横に広い・片寄り）。遠くの木は塊の少ない形（LOD）。
function crownGeo(variant, lod) {
  const rnd = mulberry(7 + variant * 31);
  const env = [[1, 1, 1], [0.85, 1.2, 0.85], [1.2, 0.8, 1.1], [1.1, 1, 0.9]][variant];
  const parts = [];
  const add = (x, y, z, r, cv, det) => {
    const g = new THREE.IcosahedronGeometry(r, det); g.translate(x, y, z);
    g.setAttribute('aCv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(cv), 1));
    parts.push(g);
  };
  add(0, 0.05, 0, 0.62, 0.8, 1);                         // 芯（すき間から見える奥の葉）
  const n = lod ? 7 : 22;
  for (let i = 0; i < n; i++) {
    let x, y, z;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1 || y < -0.55);
    const l = Math.hypot(x, y, z) || 1, k = 0.62 + 0.3 * rnd();
    x = x / l * k * 0.62 * env[0]; y = y / l * k * 0.5 * env[1] + 0.1; z = z / l * k * 0.62 * env[2];
    if (variant === 3) x += 0.12;
    const r = lod ? 0.3 + 0.08 * rnd() : 0.17 + 0.12 * rnd();
    add(x, y, z, r, 0.75 + 0.45 * rnd() * (0.6 + 0.6 * Math.max(y, 0)), 1);
  }
  return mergeGeos(parts);
}
// 杉：針葉の房の絵を貼った板を、9 段の枝に放射状に並べる（下の枝ほど長く、少し垂れる）。法線は幹から外向き
function needleTexture() {
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), rnd = mulberry(5);
  g.lineCap = 'round';
  for (let i = 0; i < 2200; i++) {
    // 枝の中心線から外へ、短い針葉の束
    const t = rnd(), cx = N * (0.04 + 0.9 * t), cy = N / 2 + (rnd() - 0.5) * N * 0.8 * Math.pow(Math.sin(t * Math.PI * 0.9 + 0.2), 0.6);
    const a = (rnd() - 0.5) * 2.2 + (cy > N / 2 ? 0.5 : -0.5), L = 8 + 14 * rnd();
    const v = 25 + 70 * rnd();
    g.strokeStyle = `rgb(${v * 0.55 | 0},${v | 0},${v * 0.5 | 0})`; g.lineWidth = 2 + 2 * rnd();
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L); g.stroke();
  }
  g.strokeStyle = 'rgb(45,32,22)'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, N / 2); g.lineTo(N * 0.9, N / 2); g.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function coniferGeo() {
  const rnd = mulberry(23);
  const pos = [], nor = [], uv = [], cv = [];
  const tiers = RENDER ? 16 : 9;
  for (let k = 0; k < tiers; k++) {
    const y = 0.18 + 0.78 * (k / tiers), R = 0.36 * Math.pow(1 - k / tiers, 0.9) + 0.03;
    const n = Math.max(5, Math.round(12 - k * 0.45));
    for (let j = 0; j < n; j++) {
      const an = (j / n) * Math.PI * 2 + k * 1.7 + rnd() * 0.5;
      const dx = Math.cos(an), dz = Math.sin(an), droop = 0.12 + 0.1 * (1 - k / tiers);
      const w = R * 1.25 + 0.05;                                 // 板の幅（枝と直角方向）
      const ox = -dz * w / 2, oz = dx * w / 2;
      // 幹 → 枝先（少し垂れる）
      const P = [[0, y + 0.02, 0], [dx * R, y - droop * R * 2, dz * R]];
      const quad = [[P[0], -1, 0], [P[1], -1, 1], [P[1], 1, 1], [P[0], -1, 0], [P[1], 1, 1], [P[0], 1, 0]];
      const ao = 0.6 + 0.4 * (k / tiers) + 0.15 * rnd();
      for (const [pp, side, u] of quad) {
        pos.push(pp[0] + side * ox * (u ? 1 : 0.3), pp[1], pp[2] + side * oz * (u ? 1 : 0.3));
        const nx = dx, ny = 0.6, nz = dz, l = Math.hypot(nx, ny, nz);
        nor.push(nx / l, ny / l, nz / l); uv.push(u, side < 0 ? 0 : 1); cv.push(ao);
      }
    }
  }
  // 芯：枝のすき間から見える奥の暗い葉（細い円錐）
  const core = new THREE.ConeGeometry(0.2, 0.8, 8, 1, true).toNonIndexed(); core.translate(0, 0.58, 0);
  const cp = core.attributes.position, cn = core.attributes.normal;
  for (let i = 0; i < cp.count; i++) { pos.push(cp.getX(i), cp.getY(i), cp.getZ(i)); nor.push(cn.getX(i), cn.getY(i), cn.getZ(i)); uv.push(0.5, 0.5); cv.push(0.35); }
  // 幹（細い角柱、下だけ見える）
  const trunk = new THREE.CylinderGeometry(0.012, 0.03, 0.4, 5, 1, true).toNonIndexed(); trunk.translate(0, 0.2, 0);
  const tp = trunk.attributes.position, tn = trunk.attributes.normal;
  for (let i = 0; i < tp.count; i++) { pos.push(tp.getX(i), tp.getY(i), tp.getZ(i)); nor.push(tn.getX(i), tn.getY(i), tn.getZ(i)); uv.push(0.02, 0.5); cv.push(0.5); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCv', new THREE.Float32BufferAttribute(cv, 1));
  return g;
}
function mergeGeos(gs) {
  gs = gs.map((g) => (g.index !== null ? g.toNonIndexed() : g));
  let n = 0; for (const g of gs) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), cv = new Float32Array(n).fill(1);
  let o = 0;
  for (const g of gs) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.aCv) cv.set(g.attributes.aCv.array, o);
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aCv', new THREE.BufferAttribute(cv, 1));
  return g;
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const leafMat = patch(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: false }), 'leaf');
const conMat = patch(new THREE.MeshStandardMaterial({ map: needleTexture(), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }), 'needle');

const TREE = { x0: -1700, x1: 1700, z0: -3000, z1: 2600, step: RENDER ? 6.5 : (PHONE ? 13 : 9) };
function plantTrees() {
  const rnd = mulberry(42);
  const dec = [], con = [];
  for (let z = TREE.z0; z < TREE.z1; z += TREE.step) {
    for (let x = TREE.x0; x < TREE.x1; x += TREE.step) {
      const px = x + (rnd() - 0.5) * TREE.step * 0.9, pz = z + (rnd() - 0.5) * TREE.step * 0.9;
      const y = height(px, pz);
      const e = 3;
      const ny = 2 * e / Math.hypot(height(px + e, pz) - height(px - e, pz), height(px, pz + e) - height(px, pz - e), 2 * e);
      if (ny < 0.28) continue;                         // 崖には生えない
      // ページでは、飛ぶ道から見える範囲（谷から 1.2km・道の先 2.5km）だけに木を置く。その外は地面の色で林に見せる
      if (!RENDER && (Math.abs(px - valleyX(pz)) > 1200 || pz < -1200)) continue;
      const r = rnd();
      const grove = THREE.MathUtils.smoothstep(noise2(px / 140 + 50, pz / 140), 0.35, 0.7);
      if (r < 0.004 + 0.75 * grove) con.push([px, y, pz, rnd()]);
      else dec.push([px, y, pz, rnd()]);
    }
  }
  return { dec, con };
}
const { dec, con } = plantTrees();
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
// カメラの道（谷の中心線）から 900m 以内は細かい形、それより遠くは LOD
const groups = [];
for (let v = 0; v < 4; v++) for (const lod of [false, true]) groups.push({ v, lod, list: [] });
dec.forEach((t) => {
  const v = Math.floor(t[3] * 997) % 4, lod = Math.abs(t[0] - valleyX(t[2])) > (RENDER ? 900 : 380);
  groups[v * 2 + (lod ? 1 : 0)].list.push(t);
});
// 葉の房の絵：小さな葉（ブナ・カエデの楕円）を数百枚、中ほど密に。灰色で描き、色は木ごとに掛ける
function leafTexture() {
  const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), rnd = mulberry(3);
  // 房の奥の暗い葉 → 手前の明るい葉 の順に重ねる
  for (let pass = 0; pass < 2; pass++) {
    const n = pass ? 700 : 450;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (pass ? 0.40 : 0.36) * N;
      const x = N / 2 + Math.cos(a) * rr, y = N / 2 + Math.sin(a) * rr * 0.92;
      const L = (pass ? 15 : 13) * (0.7 + 0.6 * rnd()), W = L * (0.45 + 0.2 * rnd());
      const v = pass ? 195 + 60 * rnd() : 110 + 60 * rnd();
      g.save(); g.translate(x, y); g.rotate(rnd() * Math.PI * 2);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.beginPath(); g.ellipse(0, 0, L / 2, W / 2, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgba(0,0,0,0.25)`; g.fillRect(-L / 2, -0.6, L, 1.2);   // 葉脈の影
      g.restore();
    }
  }
  // 細い枝
  g.strokeStyle = 'rgb(40,32,26)'; g.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const a = rnd() * Math.PI * 2; g.beginPath(); g.moveTo(N / 2, N / 2);
    g.lineTo(N / 2 + Math.cos(a) * N * 0.3, N / 2 + Math.sin(a) * N * 0.3); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// 樹冠＝葉の房の板を、楕円体の中に散らす。法線は樹冠の中心からの向き（丸く光を受ける）
function cardCrownGeo(variant, lod) {
  const rnd = mulberry(11 + variant * 17);
  const env = [[1, 1, 1], [0.85, 1.2, 0.85], [1.2, 0.8, 1.1], [1.1, 1, 0.9]][variant];
  const n = lod ? (RENDER ? 18 : 10) : (RENDER ? 56 : 30);
  const pos = [], nor = [], uv = [], cv = [];
  const up = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3(), pp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let x, y, z;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1 || y < -0.6);
    const k = Math.pow(rnd(), 0.35);                     // 外側ほど多く
    const l = Math.hypot(x, y, z) || 1;
    c.set(x / l * k * 0.6 * env[0] + (variant === 3 ? 0.1 : 0), y / l * k * 0.48 * env[1] + 0.08, z / l * k * 0.6 * env[2]);
    const sz = (lod ? 0.75 : 0.5) * (0.8 + 0.4 * rnd());
    // 板の向き：外向きに近い、ランダムに傾けた面
    up.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    nn.copy(c).normalize().multiplyScalar(0.6).add(up).normalize();
    t1.set(0, 1, 0).cross(nn); if (t1.lengthSq() < 1e-4) t1.set(1, 0, 0); t1.normalize(); t2.crossVectors(nn, t1);
    const ang = rnd() * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
    const e1 = t1.clone().multiplyScalar(ca).addScaledVector(t2, sa).multiplyScalar(sz / 2);
    const e2 = t2.clone().multiplyScalar(ca).addScaledVector(t1, -sa).multiplyScalar(sz / 2);
    const corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, -1, 0, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
    const shade = 0.75 + 0.45 * rnd() * (0.5 + 0.8 * Math.max(c.y + 0.2, 0));
    for (const [a1, a2, u, v] of corners) {
      pp.copy(c).addScaledVector(e1, a1).addScaledVector(e2, a2);
      pos.push(pp.x, pp.y, pp.z);
      const sn = pp.clone().multiply(new THREE.Vector3(1, 1.3, 1)).normalize();
      nor.push(sn.x, sn.y, sn.z); uv.push(u, v); cv.push(shade);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCv', new THREE.Float32BufferAttribute(cv, 1));
  return g;
}
const LEAF_TEX = leafTexture();
const cardMat = patch(new THREE.MeshStandardMaterial({ map: LEAF_TEX, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 }), 'card');
const decMeshes = groups.filter((g) => g.list.length).map((g) => {
  const m = new THREE.InstancedMesh(cardCrownGeo(g.v, g.lod), cardMat, g.list.length);
  g.list.forEach(([x, y, z, r], i) => {
    const d = 8.5 + 7 * r * r;                           // 樹冠の径 8.5〜15m
    q.setFromAxisAngle(v3.set(0, 1, 0), r * 40);
    m4.compose(v3.set(x, y + 9 + 5 * r, z), q, s3.set(d, d * 0.75, d));
    m.setMatrixAt(i, m4);
    m.setColorAt(i, canopyColor(x, z, y, (r * 7.13) % 1));
  });
  m.userData.final = m.instanceColor.array.slice();
  m.userData.turn = Float32Array.from(g.list, ([, y, , r]) => turnDay(y, (r * 3.71) % 1));
  return m;
});
// 樹冠の芯（板のすき間から見える奥の暗い葉）：小さな丸い塊
const coreGeo = (() => { const gg = new THREE.IcosahedronGeometry(0.42, RENDER ? 1 : 0); gg.translate(0, 0.05, 0); gg.setAttribute('aCv', new THREE.BufferAttribute(new Float32Array(gg.attributes.position.count).fill(0.6), 1)); return gg; })();
const coreMesh = new THREE.InstancedMesh(coreGeo, leafMat, dec.length);
dec.forEach(([x, y, z, r], i) => {
  const d = 8.5 + 7 * r * r;
  m4.compose(v3.set(x, y + 9 + 5 * r, z), q.identity(), s3.set(d, d * 0.75, d));
  coreMesh.setMatrixAt(i, m4);
  coreMesh.setColorAt(i, canopyColor(x, z, y, (r * 7.13) % 1));
});
coreMesh.userData.final = coreMesh.instanceColor.array.slice();
coreMesh.userData.turn = Float32Array.from(dec, ([, y, , r]) => turnDay(y, (r * 3.71) % 1));
decMeshes.push(coreMesh);

// 日付を変える（ページのつまみ）。null は動画と同じ「見頃」の色
const _f = new THREE.Color(), _o = new THREE.Color();
function applySeason(day) {
  for (const m of decMeshes) {
    const F = m.userData.final, T = m.userData.turn, A = m.instanceColor.array;
    for (let i = 0; i < T.length; i++) {
      seasonColor(_f.fromArray(F, i * 3), T[i], day, _o).toArray(A, i * 3);
    }
    m.instanceColor.needsUpdate = true;
  }
  for (const t of [nearT, farT]) {
    const g = t.geometry, F = g.userData.final, T = g.userData.turn, A = g.attributes.color.array, FA = g.userData.far;
    for (let i = 0; i < T.length; i++) {
      _f.fromArray(F, i * 3);
      const k = day === null ? 1 : THREE.MathUtils.smoothstep(day, T[i] - 7, T[i] + 3);
      const late = day === null ? 0 : THREE.MathUtils.smoothstep(day, T[i] + 10, T[i] + 24);
      // 林床・遠景の色は「緑の平均 × far」から「紅葉 × far」へ（岩はそのまま：final が岩色なら g の比で判別しない）
      const far = FA[i];
      _o.setRGB(PAL.green.r * far, PAL.green.g * far, PAL.green.b * far).lerp(_f, k);
      _o.lerp(_c.setRGB(_f.r * 0.5, _f.g * 0.42, _f.b * 0.36), late * 0.8);
      _o.toArray(A, i * 3);
    }
    g.attributes.color.needsUpdate = true;
  }
}
const conMesh = new THREE.InstancedMesh(coniferGeo(), conMat, con.length);
con.forEach(([x, y, z, r], i) => {
  const h = 14 + 16 * r;
  q.setFromEuler(new THREE.Euler((r - 0.5) * 0.08, r * 40, ((r * 13) % 1 - 0.5) * 0.08));
  m4.compose(v3.set(x, y + 1, z), q, s3.set(h * 0.42, h, h * 0.42));
  conMesh.setMatrixAt(i, m4);
  conMesh.setColorAt(i, PAL.conifer.clone().multiplyScalar(0.75 + 0.5 * r));
});
for (const m of [...decMeshes, conMesh]) { m.castShadow = m.receiveShadow = true; m.frustumCulled = false; scene.add(m); }
console.log('trees', dec.length, con.length, decMeshes.length);

// --- 空 ---
const skyMat = new THREE.ShaderMaterial({
  uniforms: airUniforms, side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: AIR + NOISE3 + CLOUD + `varying vec3 vD;
  void main(){ vec3 d = normalize(vD); vec3 c = skyCol(d);
    if (d.y > 0.0) {
      vec2 p = uCam.xz + d.xz / max(d.y, 0.03) * (2200.0 - uCam.y);
      float a = cdens(p);
      float lit = 1.0 - 0.75 * cdens(p + uSun.xz * 260.0);
      vec3 cc = mix(vec3(0.42, 0.47, 0.56), vec3(1.25, 1.12, 0.98), lit);
      float fade = smoothstep(0.0, 0.12, d.y);
      c = mix(c, cc * 1.3, a * fade);
    }
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(50000, 32, 16), skyMat);
sky.frustumCulled = false; sky.renderOrder = -1;
scene.add(sky);

// --- カメラの道（15 秒の一続き）---
// 0–5s 霧の谷の上を進みながら上がり、奥に重なる山並みを見せる → 5–10s 左の斜面へ降りて木の上すれすれ
// → 10–15s 引き上げて谷全体へ。雲の影が斜面を流れる
const CAM_KEYS = (() => {
  const h = (x, z) => height(x, z);
  const x0 = valleyX(1900) - 40, tz = 700, tx = valleyX(tz) + 60;
  return {
    pos: [
      [x0, h(x0, 1900) + 260, 1900],
      [180, 470, 1760],
      [150, 610, 1590],
      [-120, h(-120, 1430) + 120, 1450],
      [-250, h(-250, 1300) + 46, 1300],
      [-210, h(-210, 1180) + 90, 1180],
      [-170, 440, 1090],
    ],
    look: [
      [tx, h(tx, tz) - 120, tz],
      [130, 200, 0],
      [80, 330, -1600],
      [-250, h(-250, 900) + 30, 900],
      [-300, h(-300, 1050) + 10, 1050],
      [-150, h(-150, 900), 860],
      [150, 100, -300],
    ],
  };
})();
const camCurve = new THREE.CatmullRomCurve3(CAM_KEYS.pos.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
const lookCurve = new THREE.CatmullRomCurve3(CAM_KEYS.look.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
// 速さをならす：カメラの位置の進み＋視線の回りの大きさの合計が、時間に比例するように道の媒介変数を引き直す
const WARP = (() => {
  const N = 600, acc = [0];
  let pp = camCurve.getPoint(0), pl = lookCurve.getPoint(0);
  for (let i = 1; i <= N; i++) {
    const u = i / N, p = camCurve.getPoint(u), l = lookCurve.getPoint(u);
    const d0 = pl.clone().sub(pp).normalize(), d1 = l.clone().sub(p).normalize();
    acc.push(acc[i - 1] + p.distanceTo(pp) + 900 * d0.angleTo(d1));
    pp = p; pl = l;
  }
  return (s) => {
    const target = s * acc[N];
    let i = 1; while (i < N && acc[i] < target) i++;
    return (i - 1 + (target - acc[i - 1]) / Math.max(acc[i] - acc[i - 1], 1e-6)) / N;
  };
})();
function camAt(t) {
  const s0 = THREE.MathUtils.clamp(t / FILM_LEN, 0, 1);
  const u = WARP(0.5 - 0.5 * Math.cos(Math.PI * s0) * 0.35 + (s0 - 0.5) * 0.65);   // 両端を少しゆっくり
  const pos = camCurve.getPoint(u), look = lookCurve.getPoint(u);
  pos.y = Math.max(pos.y, height(pos.x, pos.z) + 40);   // 木に刺さらない
  return { pos, look };
}

// --- 舞う葉：実寸（6〜9cm）の葉を、斜面すれすれを飛ぶ道（5.5〜13秒）のまわりに。
// 葉の絵は 4 種（イロハモミジ 2・ブナ 2）。少し反った面で、振り子のように揺れ、回りながら落ちる。日に透けると光る
function leafAtlas() {
  const S = 256, cv = document.createElement('canvas'); cv.width = S * 4; cv.height = S;
  const g = cv.getContext('2d'), rnd = mulberry(77);
  const fills = [['#b51c0a', '#e04a16'], ['#d0600c', '#ec9a22'], ['#9a5a16', '#c98a2c'], ['#8a3a16', '#b8682a']];
  for (let k = 0; k < 4; k++) {
    g.save(); g.translate(k * S + S / 2, S / 2);
    const [c0, c1] = fills[k];
    const grad = g.createRadialGradient(0, 10, 4, 0, 0, S * 0.45); grad.addColorStop(0, c1); grad.addColorStop(1, c0);
    g.fillStyle = grad; g.beginPath();
    if (k < 2) {
      // イロハモミジ：7 裂の掌状。裂片は細長い披針形で先が尖り、縁に細かい鋸歯。切れ込みは葉の半分ほど
      const lobes = 7, M = 700;
      for (let i = 0; i <= M; i++) {
        const a = (i / M) * Math.PI * 2;                 // 0 = 上
        const k = a * lobes / (Math.PI * 2) + 0.5, ph = k - Math.floor(k);   // 裂片の中での位置（0.5 が先端）
        const lobe = Math.pow(1 - Math.abs(ph - 0.5) * 2, 1.25);   // 先の尖った裂片
        const down = Math.cos(a);                        // 下向きの裂片は短く、柄の所は切れ込む
        const len = 0.62 + 0.38 * (0.5 + 0.5 * down) ** 0.6;
        const serr = 0.025 * Math.abs(Math.sin(ph * Math.PI * 9)) * lobe;
        const r = S * 0.46 * (0.36 + 0.64 * lobe * len) * (1 - serr);
        const x = Math.sin(a) * r, y = -Math.cos(a) * r + S * 0.05;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    } else {
      // ブナ：卵形、波打つ縁、平行な側脈
      for (let i = 0; i <= 80; i++) {
        const a = (i / 80) * Math.PI * 2;
        const r = S * 0.42 * (1 + 0.035 * Math.sin(a * 18));
        const tipw = 0.5 + 0.5 * Math.pow(Math.max(0, -Math.cos(a)), 0.4);   // 先（上）ほど細く尖る
        const x = Math.sin(a) * r * 0.5 * (Math.cos(a) > 0 ? Math.pow(1 - Math.cos(a) * 0.55, 1.2) : 1), y = -Math.cos(a) * r * (a < Math.PI * 0.5 || a > Math.PI * 1.5 ? 1.05 : 0.8) * tipw / tipw;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    }
    g.closePath(); g.fill();
    // 縁を少し濃く（乾いて縮れた縁）
    g.lineWidth = 5; g.strokeStyle = 'rgba(70,15,5,0.35)'; g.stroke();
    // 葉脈
    g.strokeStyle = 'rgba(255,230,170,0.45)'; g.lineWidth = 2.2;
    if (k < 2) {
      for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; g.beginPath(); g.moveTo(0, S * 0.05); g.lineTo(Math.sin(a) * S * 0.36, -Math.cos(a) * S * 0.36 + S * 0.05); g.stroke(); }
    } else {
      g.beginPath(); g.moveTo(0, S * 0.36); g.lineTo(0, -S * 0.4); g.stroke(); g.lineWidth = 1.4;
      for (let i = 0; i < 9; i++) { const y = S * 0.3 - i * S * 0.075; for (const sgn of [-1, 1]) { g.beginPath(); g.moveTo(0, y); g.lineTo(sgn * S * 0.2, y - S * 0.09); g.stroke(); } }
    }
    // 小さな傷・斑点
    for (let i = 0; i < 25; i++) { g.fillStyle = `rgba(60,20,8,${0.15 + 0.25 * rnd()})`; g.beginPath(); g.arc((rnd() - 0.5) * S * 0.5, (rnd() - 0.5) * S * 0.5, 1 + 3 * rnd(), 0, 7); g.fill(); }
    // 葉柄
    g.strokeStyle = '#6b3010'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, k < 2 ? 8 : S * 0.36); g.lineTo(0, S * 0.49); g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const WIND = new THREE.Vector3(2.6, 0, -1.2);
const LEAVES = RENDER ? 12000 : (PHONE ? 2500 : 6000);
const leafGeo = (() => {
  const gg = new THREE.PlaneGeometry(1, 1, 6, 6), p = gg.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, 0.22 * x * x - 0.08 * y * y); }   // 縁が反り上がる
  gg.computeVertexNormals();
  gg.setAttribute('aCv', new THREE.BufferAttribute(new Float32Array(p.count).fill(1), 1));
  return gg;
})();
const flyMat = patch(new THREE.MeshStandardMaterial({ map: leafAtlas(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75 }), 'fly');
const fly = new THREE.InstancedMesh(leafGeo, flyMat, LEAVES);
fly.frustumCulled = false;
const aVar = new Float32Array(LEAVES);
const flySeed = [];
{
  const r = mulberry(901);
  for (let i = 0; i < LEAVES; i++) {
    // 道（5.5〜13秒）のまわり、半径 35m の中。少し前寄り
    // 道（5〜13.5秒）のすぐまわり 1.5〜14m。落ちる・流れる分を見込んで、その時刻に道の近くに来るよう逆算して置く
    const tt = 5 + 8.5 * r();
    const c = camAt(tt).pos;
    const rad = 1.5 + 12.5 * Math.pow(r(), 0.8), an = r() * Math.PI * 2;
    const fallv = 0.9 + 0.7 * r();
    const base = new THREE.Vector3(c.x + Math.cos(an) * rad, c.y + Math.sin(an) * rad * 0.7, c.z + (r() - 0.5) * 20);
    base.addScaledVector(WIND, -tt); base.y += fallv * tt;
    flySeed.push({ base, size: 0.08 + 0.05 * r(), fallv, sway: 0.4 + 0.6 * r(), w: 1.6 + 1.8 * r(),
      ph: r() * 6.28, spin: (r() - 0.5) * 6, axis: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), tint: 0.85 + 0.3 * r() });
    aVar[i] = Math.floor(r() * 4);
    fly.setColorAt(i, new THREE.Color(1, 1, 1).multiplyScalar(flySeed[i].tint));
  }
}
leafGeo.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 1));
scene.add(fly);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
function placeLeaves(t) {
  flySeed.forEach((L, i) => {
    // 落ちる量は 60m で折り返す（ずっと降り続ける）
    const dy = L.fallv * t;
    const sw = Math.sin(L.w * t + L.ph);
    v3.copy(L.base).addScaledVector(WIND, t);
    v3.y -= dy;
    v3.x += L.sway * sw; v3.z += 0.5 * L.sway * Math.cos(L.w * t + L.ph);
    // 回転：くるくる（spin）＋振り子の傾き
    qa.setFromAxisAngle(L.axis, L.spin * t + L.ph);
    qb.setFromAxisAngle(v3b.set(1, 0, 0), 0.9 * sw);
    q.multiplyQuaternions(qa, qb);
    m4.compose(v3, q, s3.set(L.size, L.size, L.size));
    fly.setMatrixAt(i, m4);
  });
  fly.instanceMatrix.needsUpdate = true;
}
const v3b = new THREE.Vector3();

// ページ：影は飛ぶ範囲（谷の 2.6km 四方）を 1 回だけ描いて使い回す（毎コマ全部の木を影に描くと重い）
if (!RENDER) {
  const SHL = 1300;
  Object.assign(sun.shadow.camera, { left: -SHL, right: SHL, top: SHL, bottom: -SHL });
  sun.shadow.camera.updateProjectionMatrix();
  const ctr = new THREE.Vector3(0, height(0, 900), 900);
  sun.target.position.copy(ctr); sun.position.copy(ctr).addScaledVector(SUN, 4000); sun.target.updateMatrixWorld();
  renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
}
function place(t) {
  const c = camAt(t);
  camera.position.copy(c.pos); camera.lookAt(c.look);
  sky.position.copy(camera.position);
  airUniforms.uT.value = t;
  placeLeaves(t);
  if (!RENDER) return;
  // 影の範囲はカメラの前方に
  const f = new THREE.Vector3().subVectors(c.look, c.pos).setY(0).normalize();
  const ctr = c.pos.clone().addScaledVector(f, SH * 0.85); ctr.y = height(ctr.x, ctr.z);
  // 影の画素の格子に合わせて動かす（滑らかに動かすと影の縁がちらつく）
  const texel = (2 * SH) / sun.shadow.mapSize.x;
  const lx = new THREE.Vector3(0, 1, 0).cross(SUN).normalize(), ly = new THREE.Vector3().crossVectors(SUN, lx);
  const a = Math.round(ctr.dot(lx) / texel) * texel, b = Math.round(ctr.dot(ly) / texel) * texel, d = ctr.dot(SUN);
  ctr.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(SUN, d);
  sun.target.position.copy(ctr); sun.position.copy(ctr).addScaledVector(SUN, 4000);
  sun.target.updateMatrixWorld();
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

if (RENDER) {
  document.body.classList.add('film');
  window.__filmLen = FILM_LEN;
  window.__renderAt = (f, fps) => {
    place(f / fps); renderer.render(scene, camera); renderer.getContext().finish();
    return { t: f / fps };
  };
  window.__ready = true;
} else {
  // 飛ぶ道を往復でなく 15 秒でくり返す。ドラッグで見回す（離すと少しずつ前へ戻る）
  let yaw = 0, pitch = 0, drag = null, paused = false, tFilm = 0, last = performance.now();
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), right = new THREE.Vector3();
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); hint.style.opacity = 0; });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = 2.2 / canvas.clientHeight;
    yaw = drag.yaw - (e.clientX - drag.x) * k;
    pitch = THREE.MathUtils.clamp(drag.pitch - (e.clientY - drag.y) * k, -0.8, 0.8);
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

  const hint = document.getElementById('hint'), dateEl = document.getElementById('date'), slider = document.getElementById('day');
  const label = (d) => { const dt = new Date(2026, 9, 1 + Math.round(d)); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const setDay = () => { const d = Number(slider.value); dateEl.textContent = label(d); applySeason(d); };
  slider.addEventListener('input', setDay); setDay();
  document.getElementById('pause').addEventListener('click', (e) => { paused = !paused; e.currentTarget.textContent = paused ? 'Fly' : 'Pause'; });

  // 最初の 3 秒で 1 秒 40 コマに届かなければ、画面の細かさを下げる（2 回まで）
  let frames = 0, since = performance.now(), drops = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now;
    frames++;
    if (now - since > 3000) {
      if (frames / ((now - since) / 1000) < 40 && drops < 2) { drops++; renderer.setPixelRatio(renderer.getPixelRatio() * 0.72); resize(); }
      frames = 0; since = now;
    }
    if (!paused) tFilm = (tFilm + dt) % FILM_LEN;
    if (!drag) { yaw *= Math.pow(0.25, dt); pitch *= Math.pow(0.25, dt); }
    place(tFilm);
    if (yaw || pitch) {
      camera.getWorldDirection(dir);
      dir.applyAxisAngle(up, yaw);
      right.crossVectors(dir, up).normalize();
      dir.applyAxisAngle(right, pitch);
      camera.lookAt(camera.position.clone().add(dir));
    }
    renderer.render(scene, camera);
  });
}
