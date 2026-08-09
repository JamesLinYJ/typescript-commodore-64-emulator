// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器界面与 PRG 画面验证器
//
//   文件:       verifyBrowser.ts
//
//   日期:       2026年08月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

interface CanvasFrame {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

const PREVIEW_URL = 'http://127.0.0.1:4173';
const OUTPUT_DIRECTORY = resolve('output/playwright/reference-ui');
const PROGRAM_START_TIMEOUT_MS = 10_000;
const PROGRAM_COUNTER_PATTERN = /PC \$([0-9A-F]{4})/u;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const RGBA_BYTE_COUNT = 4;
const MINIMUM_PROGRAM_CHANGED_PIXELS = 4_000;
const MINIMUM_PROGRAM_COLOR_COUNT = 2;
const MINIMUM_TOUCH_TARGET_PX = 44;
const MINIMUM_MOBILE_CANVAS_WIDTH_PX = 320;
const DESKTOP_VIEWPORT = { height: 900, width: 1_440 } as const;
const MOBILE_PORTRAIT_VIEWPORT = { height: 844, width: 390 } as const;
const MOBILE_LANDSCAPE_VIEWPORT = { height: 390, width: 844 } as const;

async function waitForProgramExecution(page: Page): Promise<number> {
  const executionData = page.locator('[aria-label="实时执行数据"]');
  const deadline = Date.now() + PROGRAM_START_TIMEOUT_MS;
  let latestText = '';

  while (Date.now() < deadline) {
    latestText = (await executionData.textContent()) ?? '';
    const match = PROGRAM_COUNTER_PATTERN.exec(latestText);
    const programCounter = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 16);
    if (programCounter >= 0x0801 && programCounter < 0xa000) return programCounter;
    await page.waitForTimeout(100);
  }

  throw new Error(`Galaga did not begin executing from RAM; latest status was "${latestText}".`);
}

function collectBrowserProblems(page: Page, problems: string[]): void {
  const previewOrigin = new URL(PREVIEW_URL).origin;
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).origin !== previewOrigin) return;
    problems.push(
      `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown error'})`,
    );
  });
  page.on('response', (response) => {
    if (response.status() < 400 || new URL(response.url()).origin !== previewOrigin) return;
    problems.push(
      `response ${response.status()}: ${response.request().method()} ${response.url()}`,
    );
  });
}

async function waitForBoot(page: Page): Promise<void> {
  await page.locator('.boot-overlay.is-complete').waitFor({ state: 'attached', timeout: 20_000 });
  await page.waitForFunction(() => {
    const overlay = document.querySelector('.boot-overlay');
    if (!overlay?.classList.contains('is-complete')) return false;
    const style = getComputedStyle(overlay);
    return style.opacity === '0' && style.visibility === 'hidden';
  });
}

async function verifyNoHorizontalOverflow(page: Page, viewportName: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const contentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );
    return contentWidth - viewportWidth;
  });
  if (overflow > 1) {
    throw new Error(`${viewportName} layout overflows horizontally by ${overflow}px.`);
  }
}

async function verifyMinimumTouchTargets(page: Page, viewportName: string): Promise<void> {
  const undersized = await page
    .locator('button, select, summary, a[href], [tabindex="0"]')
    .evaluateAll(
      (elements, minimumSize) =>
        elements.flatMap((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (
            bounds.width === 0 ||
            bounds.height === 0 ||
            style.display === 'none' ||
            style.visibility === 'hidden'
          ) {
            return [];
          }
          if (bounds.width >= minimumSize && bounds.height >= minimumSize) return [];
          const label =
            element.getAttribute('aria-label') ??
            element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 64) ??
            element.tagName.toLowerCase();
          return [`${label}: ${bounds.width.toFixed(1)}x${bounds.height.toFixed(1)}px`];
        }),
      MINIMUM_TOUCH_TARGET_PX,
    );
  if (undersized.length > 0) {
    throw new Error(
      `${viewportName} has controls smaller than ${MINIMUM_TOUCH_TARGET_PX}px:\n${undersized.join('\n')}`,
    );
  }
}

async function captureCanvasFrame(page: Page): Promise<CanvasFrame> {
  const dataUrl = await page.locator('canvas').evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new TypeError('The emulator screen is not an HTML canvas element.');
    }
    return element.toDataURL('image/png');
  });
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('The emulator canvas did not produce a PNG data URL.');
  }
  const decoded = PNG.sync.read(Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64'));
  return { data: decoded.data, height: decoded.height, width: decoded.width };
}

function frameByte(frame: CanvasFrame, offset: number): number {
  const value = frame.data[offset];
  if (value === undefined) {
    throw new RangeError(`Canvas frame byte ${offset} is outside its decoded pixel data.`);
  }
  return value;
}

function verifyProgramCanvas(before: CanvasFrame, after: CanvasFrame): void {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `Program canvas changed dimensions from ${before.width}x${before.height} ` +
        `to ${after.width}x${after.height}.`,
    );
  }

  const expectedBytes = after.width * after.height * RGBA_BYTE_COUNT;
  if (before.data.length !== expectedBytes || after.data.length !== expectedBytes) {
    throw new Error(
      `Decoded canvas data does not match ${after.width}x${after.height} RGBA dimensions.`,
    );
  }

  let changedPixels = 0;
  const colors = new Set<number>();
  for (let offset = 0; offset < expectedBytes; offset += RGBA_BYTE_COUNT) {
    const red = frameByte(after, offset);
    const green = frameByte(after, offset + 1);
    const blue = frameByte(after, offset + 2);
    colors.add((red << 16) | (green << 8) | blue);

    if (
      red !== frameByte(before, offset) ||
      green !== frameByte(before, offset + 1) ||
      blue !== frameByte(before, offset + 2)
    ) {
      changedPixels += 1;
    }
  }

  if (changedPixels < MINIMUM_PROGRAM_CHANGED_PIXELS) {
    throw new Error(
      `Galaga changed only ${changedPixels} canvas pixels after loading; ` +
        `expected at least ${MINIMUM_PROGRAM_CHANGED_PIXELS}.`,
    );
  }
  if (colors.size < MINIMUM_PROGRAM_COLOR_COUNT) {
    throw new Error(
      `Galaga canvas contains ${colors.size} color; expected at least ${MINIMUM_PROGRAM_COLOR_COUNT}.`,
    );
  }
}

async function verifyDesktop(page: Page): Promise<void> {
  await page.goto(PREVIEW_URL, { waitUntil: 'networkidle' });
  await waitForBoot(page);
  await verifyNoHorizontalOverflow(page, 'Desktop');

  await page.getByRole('heading', { name: 'Commodore 64' }).waitFor();
  await page.getByRole('heading', { name: '快捷载入 PRG' }).waitFor();
  await page.getByRole('heading', { name: '运行控制' }).waitFor();
  await page.getByRole('heading', { name: '快捷键参考' }).waitFor();

  await page.getByRole('button', { name: '暂停' }).click();
  await page.getByText('已暂停', { exact: true }).first().waitFor();
  const basicReadyFrame = await captureCanvasFrame(page);
  await page.getByRole('button', { name: '运行' }).click();
  await page.getByText('运行中', { exact: true }).first().waitFor();

  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await page.locator('.app-page--dark').waitFor();
  await page.getByRole('button', { name: '切换到浅色主题' }).click();

  await page.getByRole('button', { name: '载入程序' }).click();
  await page.getByText(/已载入 .* 字节至 \$0801/).waitFor({ timeout: 10_000 });
  await waitForProgramExecution(page);
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: '暂停' }).click();
  verifyProgramCanvas(basicReadyFrame, await captureCanvasFrame(page));
  await page.getByRole('button', { name: '运行' }).click();

  await page.screenshot({
    path: resolve(OUTPUT_DIRECTORY, 'current-desktop.png'),
    fullPage: true,
  });
}

async function verifyTouchInput(page: Page): Promise<void> {
  const dpad = page.getByRole('group', { name: '八方向控制' });
  const fire = page.getByRole('button', { name: '开火' });
  const dpadBounds = await dpad.boundingBox();
  const fireBounds = await fire.boundingBox();
  if (!dpadBounds || !fireBounds) {
    throw new Error('Touch controls disappeared before input testing.');
  }
  const upLeftPoint = {
    force: 1,
    id: 1,
    radiusX: 8,
    radiusY: 8,
    x: dpadBounds.x + dpadBounds.width * 0.2,
    y: dpadBounds.y + dpadBounds.height * 0.2,
  };
  const upRightPoint = {
    ...upLeftPoint,
    x: dpadBounds.x + dpadBounds.width * 0.8,
  };
  const firePoint = {
    force: 1,
    id: 2,
    radiusX: 8,
    radiusY: 8,
    x: fireBounds.x + fireBounds.width / 2,
    y: fireBounds.y + fireBounds.height / 2,
  };
  const session = await page.context().newCDPSession(page);

  await session.send('Input.dispatchTouchEvent', {
    touchPoints: [upLeftPoint],
    type: 'touchStart',
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-joystick-control="up"]')?.getAttribute('aria-pressed') ===
        'true' &&
      document.querySelector('[data-joystick-control="left"]')?.getAttribute('aria-pressed') ===
        'true',
  );

  await session.send('Input.dispatchTouchEvent', {
    touchPoints: [upLeftPoint, firePoint],
    type: 'touchStart',
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-joystick-control="up"]')?.getAttribute('aria-pressed') ===
        'true' &&
      document.querySelector('[data-joystick-control="fire"]')?.getAttribute('aria-pressed') ===
        'true',
  );

  await session.send('Input.dispatchTouchEvent', {
    touchPoints: [upRightPoint, firePoint],
    type: 'touchMove',
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-joystick-control="up"]')?.getAttribute('aria-pressed') ===
        'true' &&
      document.querySelector('[data-joystick-control="left"]')?.getAttribute('aria-pressed') ===
        'false' &&
      document.querySelector('[data-joystick-control="right"]')?.getAttribute('aria-pressed') ===
        'true' &&
      document.querySelector('[data-joystick-control="fire"]')?.getAttribute('aria-pressed') ===
        'true',
  );

  // 当前 Chromium 的 CDP touchEnd 以 touchPoints 指明本次结束的触点。
  await session.send('Input.dispatchTouchEvent', {
    touchPoints: [firePoint],
    type: 'touchEnd',
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-joystick-control="up"]')?.getAttribute('aria-pressed') ===
        'true' &&
      document.querySelector('[data-joystick-control="right"]')?.getAttribute('aria-pressed') ===
        'true' &&
      document.querySelector('[data-joystick-control="fire"]')?.getAttribute('aria-pressed') ===
        'false',
  );

  await session.send('Input.dispatchTouchEvent', {
    touchPoints: [upRightPoint],
    type: 'touchEnd',
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-joystick-control="up"]')?.getAttribute('aria-pressed') ===
        'false' &&
      document.querySelector('[data-joystick-control="right"]')?.getAttribute('aria-pressed') ===
        'false',
  );
}

async function verifyMobile(
  page: Page,
  viewportName: string,
  viewportHeight: number,
  screenshotName: string,
  options: { readonly input: boolean; readonly initiallyVisible: boolean },
): Promise<void> {
  await page.goto(PREVIEW_URL, { waitUntil: 'networkidle' });
  await waitForBoot(page);
  await verifyNoHorizontalOverflow(page, viewportName);
  await verifyMinimumTouchTargets(page, viewportName);

  const touchControls = page.getByRole('region', { name: '触控操纵杆' });
  await touchControls.waitFor();
  const touchBounds = await touchControls.boundingBox();
  if (!touchBounds) throw new Error(`${viewportName} touch controls are not visible.`);
  if (options.initiallyVisible && touchBounds.y + touchBounds.height > viewportHeight) {
    throw new Error(
      `${viewportName} touch controls are not fully available in the initial viewport.`,
    );
  }

  const canvasBounds = await page.locator('canvas').boundingBox();
  if (!canvasBounds || canvasBounds.width < MINIMUM_MOBILE_CANVAS_WIDTH_PX) {
    throw new Error(
      `Mobile canvas is ${canvasBounds?.width ?? 0}px wide; ` +
        `expected at least ${MINIMUM_MOBILE_CANVAS_WIDTH_PX}px.`,
    );
  }

  if (options.input) await verifyTouchInput(page);

  if (!options.initiallyVisible) await touchControls.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(OUTPUT_DIRECTORY, screenshotName),
    fullPage: options.initiallyVisible,
  });

  const postCapture = await touchControls.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      coarsePointer: matchMedia('(hover: none) and (pointer: coarse)').matches,
      display: getComputedStyle(element).display,
      top: bounds.top,
    };
  });
  if (
    postCapture.display === 'none' ||
    (!options.initiallyVisible && !postCapture.coarsePointer) ||
    postCapture.top < 0 ||
    postCapture.bottom > viewportHeight
  ) {
    throw new Error(
      `${viewportName} touch controls changed during capture: ${JSON.stringify(postCapture)}.`,
    );
  }
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const problems: string[] = [];

  try {
    const desktop = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
    collectBrowserProblems(desktop, problems);
    await verifyDesktop(desktop);
    await desktop.close();

    const mobile = await browser.newPage({
      hasTouch: true,
      isMobile: true,
      viewport: MOBILE_PORTRAIT_VIEWPORT,
    });
    collectBrowserProblems(mobile, problems);
    await verifyMobile(
      mobile,
      'Mobile portrait',
      MOBILE_PORTRAIT_VIEWPORT.height,
      'current-mobile.png',
      { initiallyVisible: true, input: true },
    );
    await mobile.close();

    const landscape = await browser.newPage({
      hasTouch: true,
      isMobile: true,
      viewport: MOBILE_LANDSCAPE_VIEWPORT,
    });
    collectBrowserProblems(landscape, problems);
    await verifyMobile(
      landscape,
      'Mobile landscape',
      MOBILE_LANDSCAPE_VIEWPORT.height,
      'current-mobile-landscape.png',
      { initiallyVisible: false, input: false },
    );
    await landscape.close();
  } finally {
    await browser.close();
  }

  if (problems.length > 0) {
    throw new Error(`Browser verification reported problems:\n${problems.join('\n')}`);
  }
  console.log(
    'PASS browser UI: 1440 desktop, 390 portrait, 844 landscape, CDP multi-touch, 44px targets, 0 overflow/warnings/errors.',
  );
}

await main();
