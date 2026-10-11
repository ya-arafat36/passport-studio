import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { A4, PHOTO, PER_PAGE, layoutPositions, buildPdf } from "../src/layout";

const M10 = { top: 10, right: 10, bottom: 10, left: 10 };
const EPS = 1e-9;

describe("page/photo constants", () => {
  it("A4 page size is 595.28 x 841.89 pt", () => {
    assert.equal(A4.w, 595.28);
    assert.equal(A4.h, 841.89);
  });

  it("passport photo size is 115.2 x 144 pt (1.6x2 in @ 72dpi)", () => {
    assert.equal(PHOTO.w, 115.2);
    assert.equal(PHOTO.h, 144);
  });

  it("layout is 4x5 = 20 photos per page", () => {
    assert.equal(PER_PAGE, 20);
  });
});

describe("layoutPositions", () => {
  it("20 photos with 10mm margins -> 20 positions, all on page 0, exact rect size", () => {
    const pos = layoutPositions(20, M10);
    assert.equal(pos.length, 20);
    for (const p of pos) {
      assert.equal(p.page, 0);
      assert.equal(p.w, 115.2);
      assert.equal(p.h, 144);
    }
  });

  it("45 photos -> page distribution [20, 20, 5]", () => {
    const pos = layoutPositions(45, M10);
    assert.equal(pos.length, 45);
    const counts = [0, 0, 0];
    pos.forEach((p, i) => {
      counts[p.page]++;
      assert.equal(p.page, Math.floor(i / 20), `photo ${i} on wrong page`);
    });
    assert.deepEqual(counts, [20, 20, 5]);
  });

  it("no two rects on the same page overlap (with epsilon)", () => {
    const pos = layoutPositions(45, M10);
    for (let page = 0; page < 3; page++) {
      const rects = pos.filter((p) => p.page === page);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          assert.ok(
            overlapX <= EPS || overlapY <= EPS,
            `rects ${i} and ${j} overlap on page ${page}`
          );
        }
      }
    }
  });

  it("every rect is fully inside the page", () => {
    const pos = layoutPositions(45, M10);
    for (const p of pos) {
      assert.ok(p.x >= -EPS, `x < 0: ${p.x}`);
      assert.ok(p.y >= -EPS, `y < 0: ${p.y}`);
      assert.ok(p.x + p.w <= A4.w + EPS, `x+w exceeds page: ${p.x + p.w}`);
      assert.ok(p.y + p.h <= A4.h + EPS, `y+h exceeds page: ${p.y + p.h}`);
    }
  });

  it("gaps are even across the grid and >= 4pt", () => {
    const pos = layoutPositions(20, M10);
    const expectedGapX = pos[1].x - pos[0].x - PHOTO.w;
    const expectedGapY = pos[0].y - pos[4].y - PHOTO.h; // row 1 sits below row 0 (bottom-left origin)
    assert.ok(expectedGapX >= 4 - EPS, `gapX too small: ${expectedGapX}`);
    assert.ok(expectedGapY >= 4 - EPS, `gapY too small: ${expectedGapY}`);

    for (let r = 0; r < 5; r++) {
      for (let c = 1; c < 4; c++) {
        const idx = r * 4 + c;
        const gapX = pos[idx].x - pos[idx - 1].x - PHOTO.w;
        assert.ok(
          Math.abs(gapX - expectedGapX) < EPS,
          `uneven gapX at row ${r} col ${c}: ${gapX} vs ${expectedGapX}`
        );
      }
    }
    for (let c = 0; c < 4; c++) {
      for (let r = 1; r < 5; r++) {
        const gapY = pos[(r - 1) * 4 + c].y - pos[r * 4 + c].y - PHOTO.h;
        assert.ok(
          Math.abs(gapY - expectedGapY) < EPS,
          `uneven gapY at col ${c} row ${r}: ${gapY} vs ${expectedGapY}`
        );
      }
    }
  });

  it("larger margins shrink the gaps but keep the grid valid", () => {
    const pos = layoutPositions(20, { top: 12, right: 20, bottom: 12, left: 20 });
    assert.equal(pos.length, 20);
    const gapX = pos[1].x - pos[0].x - PHOTO.w;
    const gapY = pos[0].y - pos[4].y - PHOTO.h;
    assert.ok(gapX >= 4 - EPS, `gapX too small: ${gapX}`);
    assert.ok(gapY >= 4 - EPS, `gapY too small: ${gapY}`);
    // smaller than the 10mm-margin gaps
    const base = layoutPositions(20, M10);
    assert.ok(gapX < base[1].x - base[0].x - PHOTO.w);
    for (const p of pos) {
      assert.ok(p.x + p.w <= A4.w + EPS && p.y + p.h <= A4.h + EPS);
    }
  });

  it("oversize margins throw with 'margins too large'", () => {
    const huge = { top: 100, right: 100, bottom: 100, left: 100 };
    assert.throws(() => layoutPositions(1, huge), /margins too large/);
    assert.throws(() => layoutPositions(20, huge), /margins too large/);
  });

  it("zero photos -> empty array", () => {
    assert.deepEqual(layoutPositions(0, M10), []);
  });
});

describe("buildPdf", () => {
  it("rejects on empty image list", async () => {
    await assert.rejects(buildPdf([], { marginsMm: M10, cutMarks: false }), /no images/);
  });

  it("rejects when margins are too large", async () => {
    const img = await sharp({
      create: { width: 48, height: 60, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const huge = { top: 100, right: 100, bottom: 100, left: 100 };
    await assert.rejects(
      buildPdf([img], { marginsMm: huge, cutMarks: false }),
      /margins too large/
    );
  });
});
