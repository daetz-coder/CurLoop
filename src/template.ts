import { PNG } from 'pngjs';
import * as fs from 'fs';

/**
 * 纯 TS 模板匹配（替代 pyautogui + opencv-python）。
 *
 * 原理：对截屏与模板做灰度化 + 降采样，然后跑归一化互相关（NCC）。
 * 与 cv2.matchTemplate(TM_CCOEFF_NORMED) 同原理；pyautogui 的
 * confidence= 即对 CCOEFF_NORMED 分数设阈值。置信度阈值保留与 Python 相同语义。
 *
 * 降采样：截屏 1920x1080 降到 480x270 左右搜索（速度 ~x16），NCC 在降采样
 * 空间上分数近似。模板匹配是定位按钮，粗粒度已足够（pyautogui 原实现也常
 * 在小分辨率下工作）。
 */

export interface MatchBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MatchResult {
  ok: boolean;
  box?: MatchBox;
  center?: [number, number];
  score?: number;
  grayscale?: boolean;
  reason?: string;
}

function loadGray(file: string): { w: number; h: number; gray: Float64Array } {
  const png = PNG.sync.read(fs.readFileSync(file));
  const w = png.width;
  const h = png.height;
  const gray = new Float64Array(w * h);
  const data = png.data;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    gray[j] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { w, h, gray };
}

/** 降采样整数倍。scale >= 1。 */
function downsample(gray: Float64Array, w: number, h: number, scale: number): { w: number; h: number; gray: Float64Array } {
  if (scale <= 1) return { w, h, gray };
  const dw = Math.floor(w / scale);
  const dh = Math.floor(h / scale);
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = y * scale;
    for (let x = 0; x < dw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const yy = sy + dy;
          const xx = x * scale + dx;
          if (yy < h && xx < w) {
            sum += gray[yy * w + xx];
            n++;
          }
        }
      }
      out[y * dw + x] = sum / n;
    }
  }
  return { w: dw, h: dh, gray: out };
}

/** 归一化互相关（TM_CCOEFF_NORMED）。返回最佳分数与位置。 */
function matchNcc(
  img: Float64Array,
  iw: number,
  ih: number,
  tpl: Float64Array,
  tw: number,
  th: number,
): { score: number; x: number; y: number } {
  // 模板均值与去均值模板
  let tSum = 0;
  for (let i = 0; i < tw * th; i++) tSum += tpl[i];
  const tMean = tSum / (tw * th);
  const tDiff = new Float64Array(tw * th);
  let tSsq = 0;
  for (let i = 0; i < tw * th; i++) {
    tDiff[i] = tpl[i] - tMean;
    tSsq += tDiff[i] * tDiff[i];
  }
  const tNorm = Math.sqrt(tSsq);
  if (tNorm === 0) return { score: 0, x: 0, y: 0 };

  const maxX = iw - tw;
  const maxY = ih - th;
  let bestScore = -Infinity;
  let bestX = 0;
  let bestY = 0;

  // 逐位置计算 CCOEFF_NORMED
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      let sum = 0;
      let sq = 0;
      let csum = 0;
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * iw + x;
        for (let tx = 0; tx < tw; tx++) {
          const iv = img[row + tx];
          sum += iv;
          sq += iv * iv;
          csum += tDiff[ty * tw + tx] * iv;
        }
      }
      const iNorm = Math.sqrt(Math.max(0, sq - (sum * sum) / (tw * th)));
      if (iNorm === 0) continue;
      // CCOEFF_NORMED = sum((t-tm)*(i-im)) / (|t-tm| * |i-im|)
      // 展开：分子 = sum(td*i) - iMean*sum(td)，而 sum(td)=0，故分子即 csum。
      // （旧实现误减 iMean*tSum（tSum=Σt≠0），导致 score 越界到负值、位置被亮度污染）
      const ccoe = csum / (tNorm * iNorm);
      if (ccoe > bestScore) {
        bestScore = ccoe;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { score: bestScore, x: bestX, y: bestY };
}

/**
 * 在截屏文件中定位模板。返回（映射回原始坐标的）最佳匹配。
 * @param scale 降采样倍数（越大越快、分辨率越低）。
 */
export function locateTemplateOnPng(
  screenshotFile: string,
  templateFile: string,
  scale = 4,
): MatchResult {
  let screen = loadGray(screenshotFile);
  let tpl = loadGray(templateFile);
  if (tpl.w >= screen.w || tpl.h >= screen.h) {
    return { ok: false, reason: `template too large (${tpl.w}x${tpl.h} vs screen ${screen.w}x${screen.h})` };
  }
  const ds = downsample(screen.gray, screen.w, screen.h, scale);
  const dt = downsample(tpl.gray, tpl.w, tpl.h, scale);
  if (dt.w >= ds.w || dt.h >= ds.h) {
    // 模板太小，降采样后可能失效 —— 原尺寸匹配
    return matchAtScale(screen, tpl, 1);
  }
  const r = matchNcc(ds.gray, ds.w, ds.h, dt.gray, dt.w, dt.h);
  // 映射回原始坐标（取区域中心映射，粗定位）
  const left = r.x * scale;
  const top = r.y * scale;
  const width = tpl.w;
  const height = tpl.h;
  return {
    ok: true,
    box: { left, top, width, height },
    center: [left + Math.floor(width / 2), top + Math.floor(height / 2)],
    score: r.score,
  };
}

function matchAtScale(
  screen: { w: number; h: number; gray: Float64Array },
  tpl: { w: number; h: number; gray: Float64Array },
  scale: number,
): MatchResult {
  const ds = downsample(screen.gray, screen.w, screen.h, scale);
  const dt = downsample(tpl.gray, tpl.w, tpl.h, scale);
  const r = matchNcc(ds.gray, ds.w, ds.h, dt.gray, dt.w, dt.h);
  const left = r.x * scale;
  const top = r.y * scale;
  return {
    ok: true,
    box: { left, top, width: tpl.w, height: tpl.h },
    center: [left + Math.floor(tpl.w / 2), top + Math.floor(tpl.h / 2)],
    score: r.score,
  };
}
