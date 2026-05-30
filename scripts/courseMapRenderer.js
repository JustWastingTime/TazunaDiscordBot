import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_COLORS = {
  background: "#2b2d31",
  title: "#24b7ff",
  axis: "#8b96a8",
  tick: "#9ea7b7",
  meterText: "#6f7888",
  segmentBorder: "rgba(255, 255, 255, 0.12)",
  activationLine: "#d11f2a",
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeSegment(segment, length) {
  const start = clamp(Number(segment.start ?? 0), 0, length);
  const end = clamp(Number(segment.end ?? 0), 0, length);
  if (end <= start) return null;
  return {
    ...segment,
    start,
    end,
  };
}

function segmentLabel(segment) {
  if (segment.type === "uphill") return "↗";
  if (segment.type === "downhill") return "↘";
  if (segment.type === "flat") return "";
  return segment.label ?? "";
}

function computeTickStep(length) {
  if (length <= 1200) return 100;
  if (length <= 2000) return 200;
  if (length <= 3000) return 300;
  return 400;
}

function buildSvg(mapData, options) {
  const width = options.width ?? 1500;
  const rowGap = 8;
  const rowHeight = 54;
  const margin = { top: 92, right: 48, bottom: 18, left: 48 };
  const trackWidth = width - margin.left - margin.right;
  const trackTop = margin.top;
  const title = mapData.name ?? `Course ${mapData.length}m`;
  const length = Number(mapData.length);
  const rowBottom = trackTop + rowHeight * 3 + rowGap * 2;
  const axisY = rowBottom + 32;
  const height = options.height ?? axisY + 34;

  if (!Number.isFinite(length) || length <= 0) {
    throw new Error("mapData.length must be a positive number.");
  }

  const rows = [
    {
      key: "elevation",
      y: trackTop,
      segments: (mapData.elevation ?? []).map((s) => normalizeSegment(s, length)).filter(Boolean),
    },
    {
      key: "layout",
      y: trackTop + rowHeight + rowGap,
      segments: (mapData.layout ?? []).map((s) => normalizeSegment(s, length)).filter(Boolean),
    },
    {
      key: "zones",
      y: trackTop + rowHeight * 2 + rowGap * 2,
      segments: (mapData.zones ?? []).map((s) => normalizeSegment(s, length)).filter(Boolean),
    },
  ];

  const xFromDistance = (distance) => {
    return margin.left + (clamp(distance, 0, length) / length) * trackWidth;
  };
  const trackEndY = trackTop + rowHeight * 3 + rowGap * 2;

  const parts = [];
  const boundaryLabels = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${DEFAULT_COLORS.background}" />`,
    `<text x="${width / 2}" y="46" text-anchor="middle" fill="${DEFAULT_COLORS.title}" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="700">${escapeXml(title)}</text>`
  );

  for (const row of rows) {
    for (const segment of row.segments) {
      const x = xFromDistance(segment.start);
      const w = xFromDistance(segment.end) - x;
      const label = segmentLabel(segment);
      const fill = segment.color ?? "#d1d5db";
      const textColor = segment.textColor ?? "#20262e";

      parts.push(
        `<rect x="${x.toFixed(2)}" y="${row.y}" width="${w.toFixed(2)}" height="${rowHeight}" fill="${fill}" stroke="${DEFAULT_COLORS.segmentBorder}" stroke-width="1"/>`
      );

      if (label && w > 44) {
        parts.push(
          `<text x="${(x + w / 2).toFixed(2)}" y="${(row.y + rowHeight / 2 + 5).toFixed(2)}" text-anchor="middle" fill="${textColor}" font-size="17" font-family="Arial, Helvetica, sans-serif" font-weight="700">${escapeXml(label)}</text>`
        );
      }
    }

    // Queue meter markers where segment boundaries change for later drawing.
    // Drawing these after all rows prevents row 1/2 labels from being covered.
    for (const segment of row.segments) {
      if (segment.end >= length) continue;
      boundaryLabels.push({
        x: xFromDistance(segment.end),
        y: row.y + rowHeight,
        text: `${segment.end}m`,
      });
    }
  }
  for (const marker of boundaryLabels) {
    parts.push(
      `<line x1="${marker.x.toFixed(2)}" y1="${(marker.y - 7).toFixed(2)}" x2="${marker.x.toFixed(2)}" y2="${(marker.y + 5).toFixed(2)}" stroke="${DEFAULT_COLORS.tick}" stroke-width="1.5"/>`,
      `<text x="${marker.x.toFixed(2)}" y="${(marker.y - 6).toFixed(2)}" text-anchor="middle" fill="${DEFAULT_COLORS.meterText}" font-size="11" font-family="Arial, Helvetica, sans-serif">${marker.text}</text>`
    );
  }
  const tickStep = options.tickStep ?? computeTickStep(length);

  parts.push(`<line x1="${margin.left}" y1="${axisY}" x2="${width - margin.right}" y2="${axisY}" stroke="${DEFAULT_COLORS.axis}" stroke-width="2"/>`);
  for (let d = 0; d <= length; d += tickStep) {
    const x = xFromDistance(d);
    parts.push(
      `<line x1="${x.toFixed(2)}" y1="${axisY}" x2="${x.toFixed(2)}" y2="${(axisY - 10).toFixed(2)}" stroke="${DEFAULT_COLORS.tick}" stroke-width="2"/>`,
      `<text x="${x.toFixed(2)}" y="${(axisY + 20).toFixed(2)}" text-anchor="middle" fill="${DEFAULT_COLORS.axis}" font-size="13" font-family="Arial, Helvetica, sans-serif">${d}</text>`
    );
  }

  const markers = Array.isArray(options.skillMarkers) ? options.skillMarkers : [];
  for (const marker of markers) {
    // Supports two marker styles:
    // - line: { type: "line", distance: 420, color?: "#d11f2a", width?: 4 }
    // - box:  { type: "box", start: 267, end: 1067, color?: "#d11f2a", fillOpacity?: 0.18 }
    const markerType = marker.type ?? (marker.start != null && marker.end != null ? "box" : "line");
    const color = marker.color ?? DEFAULT_COLORS.activationLine;

    if (markerType === "box") {
      const start = clamp(Number(marker.start ?? 0), 0, length);
      const end = clamp(Number(marker.end ?? 0), 0, length);
      if (end <= start) continue;
      const x = xFromDistance(start);
      const w = xFromDistance(end) - x;
      const fillOpacity = clamp(Number(marker.fillOpacity ?? 0.18), 0, 1);
      const strokeWidth = Number(marker.strokeWidth ?? 2);
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${(trackTop - 12).toFixed(2)}" width="${w.toFixed(2)}" height="${(trackEndY - trackTop + 24).toFixed(2)}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-width="${strokeWidth}"/>`
      );
      continue;
    }

    const distance = clamp(Number(marker.distance ?? 0), 0, length);
    const lineX = xFromDistance(distance);
    const width = Number(marker.width ?? 4);
    parts.push(
      `<line x1="${lineX.toFixed(2)}" y1="${(trackTop - 12).toFixed(2)}" x2="${lineX.toFixed(2)}" y2="${(axisY + 4).toFixed(2)}" stroke="${color}" stroke-width="${width}"/>`
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

export async function renderCourseMapPng(mapData, outputPath, options = {}) {
  const svg = buildSvg(mapData, options);
  const outDir = path.dirname(outputPath);
  await fs.mkdir(outDir, { recursive: true });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outputPath);
  return outputPath;
}

const SAMPLE_MAP = {
  name: "Tokyo 1600m (counterclockwise)",
  length: 1600,
  elevation: [
    { start: 0, end: 450, label: "Flat", type: "flat", color: "#c9ec39" },
    { start: 450, end: 700, label: "Downhill", type: "downhill", color: "#67d2de" },
    { start: 700, end: 1150, label: "Flat", type: "flat", color: "#c9ec39" },
    { start: 1150, end: 1300, label: "Uphill", type: "uphill", color: "#e6ca9d" },
    { start: 1300, end: 1600, label: "Flat", type: "flat", color: "#c9ec39" },
  ],
  layout: [
    { start: 0, end: 550, label: "Straight", color: "#b8d4ea" },
    { start: 550, end: 825, label: "Corner 3", color: "#edccae" },
    { start: 825, end: 1075, label: "Corner 4", color: "#edccae" },
    { start: 1075, end: 1600, label: "Straight", color: "#b8d4ea" },
  ],
  zones: [
    { start: 0, end: 267, label: "Early", color: "#00a88f", textColor: "#ffffff" },
    { start: 267, end: 1067, label: "Mid", color: "#e3d95f" },
    { start: 1067, end: 1333, label: "Late", color: "#cf81bb" },
    { start: 1333, end: 1600, label: "Last Spurt", color: "#bf6ea8" },
  ],
};

async function runCli() {
  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, "..", "assets", "course-map-preview.png");

  await renderCourseMapPng(SAMPLE_MAP, outputPath, {
    width: 1500,
    height: 360,
    skillMarkers: [
      { type: "line", distance: 420, color: "#d11f2a" },
      { type: "line", distance: 1120, color: "#d11f2a" },
      { type: "box", start: 267, end: 1067, color: "#d11f2a", fillOpacity: 0.16 },
      { type: "box", start: 1067, end: 1600, color: "#d11f2a", fillOpacity: 0.16 },
    ],
  });

  console.log(`Rendered preview map: ${outputPath}`);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
