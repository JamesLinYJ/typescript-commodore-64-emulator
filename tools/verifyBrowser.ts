// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器界面与 PRG 画面验证器
//
//   文件:       verifyBrowser.ts
//
//   日期:       2026年07月17日
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
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
}

async function waitForBoot(page: Page): Promise<void> {
  await page.locator('.boot-overlay.is-complete').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const overlay = document.querySelector('.boot-overlay');
    return overlay !== null && getComputedStyle(overlay).opacity === '0';
  });
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

async function verifyMobile(page: Page): Promise<void> {
  await page.goto(PREVIEW_URL, { waitUntil: 'networkidle' });
  await waitForBoot(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 1) throw new Error(`Mobile layout overflows horizontally by ${overflow}px.`);

  await page.screenshot({
    path: resolve(OUTPUT_DIRECTORY, 'current-mobile.png'),
    fullPage: true,
  });
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const problems: string[] = [];

  try {
    const desktop = await browser.newPage({ viewport: { width: 1675, height: 941 } });
    collectBrowserProblems(desktop, problems);
    await verifyDesktop(desktop);
    await desktop.close();

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    collectBrowserProblems(mobile, problems);
    await verifyMobile(mobile);
    await mobile.close();
  } finally {
    await browser.close();
  }

  if (problems.length > 0) {
    throw new Error(`Browser verification reported problems:\n${problems.join('\n')}`);
  }
  console.log(
    'PASS browser UI: desktop interactions, PRG canvas output, mobile overflow, 0 warnings/errors.',
  );
}

await main();
