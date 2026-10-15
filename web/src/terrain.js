// 山と谷の地形：尾根の立つ雑音（ridged）に、蛇行する谷を1本刻む。木を置く・カメラを飛ばす両方で同じ関数を使う。
// 単位は m。x が東、z が南、y が上。

// 2D simplex noise (Stefan Gustavson のものを短くしたもの)
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const perm = new Uint8Array(512);
{
  let s = 1234567;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const GX = [1, -1, 1, -1, 1, -1, 0, 0], GY = [1, 1, -1, -1, 0, 0, 1, -1];
export function noise2(x, y) {
  const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0, tt;
  tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { const g = perm[ii + perm[jj]] & 7; tt *= tt; n += tt * tt * (GX[g] * x0 + GY[g] * y0); }
  tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; tt *= tt; n += tt * tt * (GX[g] * x1 + GY[g] * y1); }
  tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; tt *= tt; n += tt * tt * (GX[g] * x2 + GY[g] * y2); }
  return 70 * n;
}

// 谷の中心線：南(+z)から北(-z)へ蛇行する
export function valleyX(z) {
  return 260 * Math.sin(z / 900) + 120 * Math.sin(z / 370 + 1.3);
}

// 尾根の立つ雑音（山肌のひだ）
function ridged(x, z, oct) {
  let a = 0, f = 1 / 1400, amp = 1, w = 1, sum = 0;
  for (let o = 0; o < oct; o++) {
    let n = 1 - Math.abs(noise2(x * f + o * 17.3, z * f - o * 9.1));
    n = n * (0.6 + 0.4 * n); n *= w; w = Math.min(1, n * 1.3);
    a += n * amp; sum += amp; amp *= 0.42; f *= 2.03;
  }
  return a / sum;
}

// なだらかな雑音（丸い山の肩）
function fbm(x, z, oct) {
  let a = 0, f = 1 / 1800, amp = 1, sum = 0;
  for (let o = 0; o < oct; o++) { a += noise2(x * f + o * 5.1, z * f + o * 3.7) * amp; sum += amp; amp *= 0.45; f *= 2.1; }
  return a / sum;
}

export function height(x, z, oct = 7) {
  // 大きな山並み：尾根のひだ（ridged）を、丸い山（fbm）に半分だけ混ぜる
  const big = noise2(x / 6000, z / 6000) * 0.5 + 0.5;
  const r = ridged(x, z, Math.min(oct, 3)), m = fbm(x, z, oct) * 0.5 + 0.5;
  let h = 140 + 640 * (0.2 * r + 0.8 * m * m * (3 - 2 * m)) * (0.55 + 0.6 * big);
  // 谷：中心線からの距離で V 字に削る（谷底は狭く、斜面は急）
  const d = Math.abs(x - valleyX(z));
  const v = 1 - Math.exp(-(d * d) / (2 * 420 * 420));
  h = h * (0.25 + 0.75 * v) + 40 * (1 - v);
  // 谷底の峡谷：川沿いだけ急に切れ込む（岩の崖が見える所）
  const g = Math.exp(-(d * d) / (2 * 45 * 45));
  h -= 55 * g;
  // 細かい凹凸
  h += 6 * noise2(x / 40, z / 40) + 14 * noise2(x / 130, z / 130);
  return h;
}
