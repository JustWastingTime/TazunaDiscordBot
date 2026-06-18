import fs from "fs/promises";
import path from "path";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FONT_REGULAR_PATH = path.resolve(__dirname, "../assets/font/Rubik-Regular.ttf");
const FONT_BOLD_PATH = path.resolve(__dirname, "../assets/font/Rubik-Bold.ttf");
const FONT_FAMILY = "Rubik";
const METER_LABEL_FONT_SIZE = 9;

function renderSvgToPng(svg) {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_REGULAR_PATH, FONT_BOLD_PATH],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
      sansSerifFamily: FONT_FAMILY,
    },
  });
  return resvg.render().asPng();
}

export const MAP_COLORS = {
  sky: "#A8D4F8",
  elevationFlat: "#8DB86A",
  elevationUphill: "#E89548",
  elevationDownhill: "#C49AA8",
  layoutBlank: "#B8B2A8",
  layoutStraight: "#A8BDD6",
  layoutCorner: "#EDCA72",
  zoneEarly: "#59B292",
  zoneMid: "#D4BC6A",
  zoneLate: "#F7A5A5",
  zoneSpurt: "#E195AB",
  zoneFallback: "#C9BFB4",
};

const DEFAULT_COLORS = {
  background: "#2b2d31",
  title: "#6BB5A8",
  warning: "#e87a92",
  axis: "#8b96a8",
  tick: "#9ea7b7",
  meterText: "#6f7888",
  segmentBorder: "rgba(255, 255, 255, 0.12)",
  activationLine: "#ff4d6d",
  activationBoxStroke: "#ff5c7a",
  preconditionBoxStroke: "#d9b84a",
  positionKeepLine: "#934761",
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
  if (segment.type === "uphill" || segment.type === "downhill" || segment.type === "flat") return "";
  return segment.label ?? "";
}

function computeTickStep(length) {
  if (length <= 1200) return 100;
  if (length <= 2000) return 200;
  if (length <= 3000) return 300;
  return 400;
}

function layoutSegmentColor(segment) {
  const label = String(segment?.label ?? "").trim().toLowerCase();
  if (!label) return MAP_COLORS.layoutBlank;
  if (label.includes("corner")) return MAP_COLORS.layoutCorner;
  return MAP_COLORS.layoutStraight;
}

function zoneSegmentColor(segment) {
  const label = String(segment?.label ?? "").trim().toLowerCase();
  if (label.includes("spurt")) return MAP_COLORS.zoneSpurt;
  if (label.includes("early")) return MAP_COLORS.zoneEarly;
  if (label.includes("mid")) return MAP_COLORS.zoneMid;
  if (label.includes("late")) return MAP_COLORS.zoneLate;
  return MAP_COLORS.zoneFallback;
}

function elevationSegmentColor(segment) {
  const type = String(segment?.type ?? "").toLowerCase();
  const label = String(segment?.label ?? "").toLowerCase();
  if (type.includes("uphill") || label.includes("uphill")) return MAP_COLORS.elevationUphill;
  if (type.includes("downhill") || label.includes("downhill")) return MAP_COLORS.elevationDownhill;
  return MAP_COLORS.elevationFlat;
}

function defaultSegmentColor(rowKey, segment) {
  if (rowKey === "elevation") return elevationSegmentColor(segment);
  if (rowKey === "layout") return layoutSegmentColor(segment);
  if (rowKey === "zones") return zoneSegmentColor(segment);
  return "#d1d5db";
}

function formatStatThresholds(statThresholds) {
  if (!Array.isArray(statThresholds)) return "";
  const cleaned = [...new Set(statThresholds.map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (!cleaned.length) return "";
  return `Stat Thresholds: ${cleaned.join(" & ")}`;
}

function resolveSegmentElevationDelta(segment) {
  const span = Number(segment?.end) - Number(segment?.start);
  if (!Number.isFinite(span) || span <= 0) return 0;

  const change = Number(segment?.change);
  if (Number.isFinite(change)) {
    // Game SlopePer: grade percent applied over the segment distance (meters).
    return (change / 100) * span;
  }

  const type = String(segment?.type ?? "").toLowerCase();
  if (type.includes("uphill")) return span / 100;
  if (type.includes("downhill")) return -span / 100;
  return 0;
}

function slopedElevationColor(segment) {
  return elevationSegmentColor(segment);
}

function buildElevationProfile(segments, rowY, rowHeight, elevationScale = null) {
  let elevation = 0;
  const boundaries = [{ distance: segments[0]?.start ?? 0, elevation: 0 }];

  for (const segment of segments) {
    elevation += resolveSegmentElevationDelta(segment);
    boundaries.push({ distance: segment.end, elevation });
  }

  const elevationAtDistance = (distance) => {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (distance >= segment.start && distance <= segment.end) {
        const startElevation = boundaries[i].elevation;
        const endElevation = boundaries[i + 1].elevation;
        const span = segment.end - segment.start;
        if (span <= 0 || startElevation === endElevation) return startElevation;
        const ratio = (distance - segment.start) / span;
        return startElevation + (endElevation - startElevation) * ratio;
      }
    }
    return boundaries[boundaries.length - 1]?.elevation ?? 0;
  };

  const sampleElevations = boundaries.map((point) => point.elevation);
  const minElevation = Math.min(...sampleElevations);
  const maxElevation = Math.max(...sampleElevations);
  const baselineY = rowY + rowHeight * 0.56;
  const amplitude = rowHeight * 0.4;
  const scale = Number(elevationScale);

  const yFromElevation = (value) => {
    if (Number.isFinite(scale) && scale > 0) {
      return baselineY - (value / scale) * amplitude;
    }
    const center = (minElevation + maxElevation) / 2;
    const halfRange = Math.max((maxElevation - minElevation) / 2, 0.5);
    return baselineY - ((value - center) / halfRange) * amplitude;
  };

  const yAtDistance = (distance) => yFromElevation(elevationAtDistance(distance));

  return { boundaries, yAtDistance, elevationAtDistance };
}

function renderSlopedElevationRow(parts, row, rowHeight, xFromDistance, boundaryLabels, elevationScale = null) {
  const rowBottom = row.y + rowHeight;
  const startX = xFromDistance(row.segments[0].start);
  const endX = xFromDistance(row.segments[row.segments.length - 1].end);
  const { yAtDistance } = buildElevationProfile(row.segments, row.y, rowHeight, elevationScale);

  parts.push(
    `<rect x="${startX.toFixed(2)}" y="${row.y}" width="${(endX - startX).toFixed(2)}" height="${rowHeight}" fill="${MAP_COLORS.sky}" stroke="${DEFAULT_COLORS.segmentBorder}" stroke-width="1"/>`
  );

  for (const segment of row.segments) {
    const x1 = xFromDistance(segment.start);
    const x2 = xFromDistance(segment.end);
    const y1 = yAtDistance(segment.start);
    const y2 = yAtDistance(segment.end);
    const fill = segment.color ?? slopedElevationColor(segment);
    const points = [
      `${x1.toFixed(2)},${rowBottom}`,
      `${x2.toFixed(2)},${rowBottom}`,
      `${x2.toFixed(2)},${y2.toFixed(2)}`,
      `${x1.toFixed(2)},${y1.toFixed(2)}`,
    ].join(" ");

    parts.push(`<polygon points="${points}" fill="${fill}" stroke="${DEFAULT_COLORS.segmentBorder}" stroke-width="0.8"/>`);
  }

  for (const segment of row.segments) {
    if (segment.end >= row.segments[row.segments.length - 1].end) continue;
    boundaryLabels.push({
      x: xFromDistance(segment.end),
      y: rowBottom,
      text: `${segment.end}m`,
    });
  }
}

function mergeTouchingBoxMarkers(markers, length) {
  const tolerance = 0.0001;
  const normalized = markers
    .map((marker) => {
      const start = clamp(Number(marker.start ?? 0), 0, length);
      const end = clamp(Number(marker.end ?? 0), 0, length);
      if (end <= start) return null;
      return { ...marker, type: "box", start, end };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const marker of normalized) {
    const prev = merged[merged.length - 1];
    const prevColor = prev?.color ?? DEFAULT_COLORS.activationBoxStroke;
    const markerColor = marker?.color ?? DEFAULT_COLORS.activationBoxStroke;
    const prevBehavior = String(prev?.trigger_behavior ?? prev?.behavior ?? "random").toLowerCase();
    const markerBehavior = String(marker?.trigger_behavior ?? marker?.behavior ?? "random").toLowerCase();
    const sameStyle = prev && prevColor === markerColor && prevBehavior === markerBehavior;
    if (prev && sameStyle && marker.start <= prev.end + tolerance) {
      prev.end = Math.max(prev.end, marker.end);
      prev.fillOpacity = Math.max(Number(prev.fillOpacity ?? 0.1), Number(marker.fillOpacity ?? 0.1));
      prev.strokeWidth = Math.max(Number(prev.strokeWidth ?? 2.2), Number(marker.strokeWidth ?? 2.2));
      continue;
    }
    merged.push({ ...marker });
  }
  return merged;
}

function buildSvg(mapData, options) {
  const width = options.width ?? 1500;
  const rowGap = 0;
  const rowHeight = 54;
  const margin = { top: 92, right: 48, bottom: 18, left: 48 };
  const trackWidth = width - margin.left - margin.right;
  const trackTop = margin.top;
  const title = mapData.name ?? `Course ${mapData.length}m`;
  const warningText = options.warningText ? String(options.warningText) : "";
  const backgroundOpacity = clamp(Number(options.backgroundOpacity ?? 0), 0, 1);
  const length = Number(mapData.length);
  const statThresholdText = formatStatThresholds(mapData.statThresholds);
  const elevationScale = mapData.elevationScale ?? mapData.elevation_scale ?? null;
  const rowBottom = trackTop + rowHeight * 3 + rowGap * 2;
  const axisY = rowBottom + 32;
  const statThresholdY = axisY + 42;
  const height = options.height ?? (statThresholdText ? statThresholdY + 22 : axisY + 34);

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
    `<defs>
      <pattern id="randomStripe" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(35)">
        <line x1="0" y1="0" x2="0" y2="10" stroke="#639de6" stroke-opacity="0.62" stroke-width="3"/>
      </pattern>
      <pattern id="asapHatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="8" stroke="#ff6f8a" stroke-opacity="0.35" stroke-width="2"/>
      </pattern>
      <pattern id="preconditionHatch" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="10" stroke="#e8cf7a" stroke-opacity="0.4" stroke-width="2"/>
      </pattern>
    </defs>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${DEFAULT_COLORS.background}" fill-opacity="${backgroundOpacity}"/>`,
    `<text x="${width / 2}" y="46" text-anchor="middle" fill="${DEFAULT_COLORS.title}" font-size="34" font-family="${FONT_FAMILY}" font-weight="700">${escapeXml(title)}</text>`
  );
  if (warningText) {
    parts.push(
      `<text x="${width / 2}" y="72" text-anchor="middle" fill="${DEFAULT_COLORS.warning}" font-size="18" font-family="${FONT_FAMILY}" font-weight="700">${escapeXml(warningText)}</text>`
    );
  }

  for (const row of rows) {
    if (row.key === "elevation" && row.segments.length > 0) {
      renderSlopedElevationRow(parts, row, rowHeight, xFromDistance, boundaryLabels, elevationScale);
      continue;
    }

    for (const segment of row.segments) {
      const x = xFromDistance(segment.start);
      const w = xFromDistance(segment.end) - x;
      const label = segmentLabel(segment);
      const fill = row.key === "layout"
        ? layoutSegmentColor(segment)
        : row.key === "zones"
          ? zoneSegmentColor(segment)
          : (segment.color ?? defaultSegmentColor(row.key, segment));
      const textColor = segment.textColor ?? "#20262e";

      parts.push(
        `<rect x="${x.toFixed(2)}" y="${row.y}" width="${w.toFixed(2)}" height="${rowHeight}" fill="${fill}" stroke="${DEFAULT_COLORS.segmentBorder}" stroke-width="1"/>`
      );

      if (label && w > 44) {
        parts.push(
          `<text x="${(x + w / 2).toFixed(2)}" y="${(row.y + rowHeight / 2 + 5).toFixed(2)}" text-anchor="middle" fill="${textColor}" font-size="17" font-family="${FONT_FAMILY}" font-weight="700">${escapeXml(label)}</text>`
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
      `<text x="${marker.x.toFixed(2)}" y="${(marker.y - 6).toFixed(2)}" text-anchor="middle" fill="${DEFAULT_COLORS.meterText}" font-size="${METER_LABEL_FONT_SIZE}" font-family="${FONT_FAMILY}" font-weight="400">${marker.text}</text>`
    );
  }
  const tickStep = options.tickStep ?? computeTickStep(length);

  parts.push(`<line x1="${margin.left}" y1="${axisY}" x2="${width - margin.right}" y2="${axisY}" stroke="${DEFAULT_COLORS.axis}" stroke-width="2"/>`);
  for (let d = 0; d <= length; d += tickStep) {
    const x = xFromDistance(d);
    parts.push(
      `<line x1="${x.toFixed(2)}" y1="${axisY}" x2="${x.toFixed(2)}" y2="${(axisY - 10).toFixed(2)}" stroke="${DEFAULT_COLORS.tick}" stroke-width="2"/>`,
      `<text x="${x.toFixed(2)}" y="${(axisY + 20).toFixed(2)}" text-anchor="middle" fill="${DEFAULT_COLORS.axis}" font-size="13" font-family="${FONT_FAMILY}" font-weight="400">${d}</text>`
    );
  }

  if (statThresholdText) {
    parts.push(
      `<text x="${(width / 2).toFixed(2)}" y="${statThresholdY.toFixed(2)}" text-anchor="middle" fill="${DEFAULT_COLORS.axis}" font-size="15" font-family="${FONT_FAMILY}" font-weight="700">${escapeXml(statThresholdText)}</text>`
    );
  }

  const rawMarkers = Array.isArray(options.skillMarkers) ? options.skillMarkers : [];
  const lineMarkers = [];
  const boxMarkers = [];
  for (const marker of rawMarkers) {
    const markerType = marker.type ?? (marker.start != null && marker.end != null ? "box" : "line");
    if (markerType === "box") {
      boxMarkers.push(marker);
    } else {
      lineMarkers.push(marker);
    }
  }
  const mergedBoxMarkers = mergeTouchingBoxMarkers(boxMarkers, length);

  for (const marker of [...mergedBoxMarkers, ...lineMarkers]) {
    // Supports two marker styles:
    // - line: { type: "line", distance: 420, color?: "#d11f2a", width?: 4 }
    // - box:  { type: "box", start: 267, end: 1067, color?: "#d11f2a", fillOpacity?: 0.18 }
    const markerType = marker.type ?? (marker.start != null && marker.end != null ? "box" : "line");
    const color = marker.color ?? (markerType === "box" ? DEFAULT_COLORS.activationBoxStroke : DEFAULT_COLORS.activationLine);

    if (markerType === "box") {
      const start = clamp(Number(marker.start ?? 0), 0, length);
      const end = clamp(Number(marker.end ?? 0), 0, length);
      if (end <= start) continue;
      const x = xFromDistance(start);
      const w = xFromDistance(end) - x;
      const behavior = String(marker.trigger_behavior ?? marker.behavior ?? "random").toLowerCase();
      const fillOpacity = clamp(Number(marker.fillOpacity ?? 0.1), 0, 1);
      const strokeWidth = Number(marker.strokeWidth ?? 2.2);
      const boxY = trackTop - 12;
      const boxH = trackEndY - trackTop + 24;

      // "random": solid translucent zone
      // "asap": lighter fill + hatch overlay + stronger outline
      if (behavior === "asap") {
        parts.push(
          `<rect x="${x.toFixed(2)}" y="${boxY.toFixed(2)}" width="${w.toFixed(2)}" height="${boxH.toFixed(2)}" rx="4" ry="4" fill="${color}" fill-opacity="${Math.min(fillOpacity, 0.08)}" stroke="none"/>`,
          `<rect x="${x.toFixed(2)}" y="${boxY.toFixed(2)}" width="${w.toFixed(2)}" height="${boxH.toFixed(2)}" rx="4" ry="4" fill="url(#asapHatch)" fill-opacity="0.4" stroke="${color}" stroke-width="${Math.max(strokeWidth, 2.4)}"/>`,
          `<text x="${(x + w / 2).toFixed(2)}" y="${(boxY - 6).toFixed(2)}" text-anchor="middle" fill="#ff7f97" font-size="12" font-family="${FONT_FAMILY}" font-weight="700">ASAP</text>`
        );
      } else if (behavior === "precondition") {
        const preColor = "#d9b84a";
        parts.push(
          `<rect x="${x.toFixed(2)}" y="${boxY.toFixed(2)}" width="${w.toFixed(2)}" height="${boxH.toFixed(2)}" rx="4" ry="4" fill="#f7e6a4" fill-opacity="0.2" stroke="none"/>`,
          `<rect x="${x.toFixed(2)}" y="${boxY.toFixed(2)}" width="${w.toFixed(2)}" height="${boxH.toFixed(2)}" rx="4" ry="4" fill="url(#preconditionHatch)" fill-opacity="0.45" stroke="${preColor}" stroke-width="${Math.max(2, strokeWidth)}"/>`,
          `<text x="${(x + w / 2).toFixed(2)}" y="${(boxY - 6).toFixed(2)}" text-anchor="middle" fill="#e5c767" font-size="12" font-family="${FONT_FAMILY}" font-weight="700">PRECONDITION</text>`
        );
      } else {
        const randomColor = "#4f88d4";
        parts.push(
          `<rect x="${x.toFixed(2)}" y="${boxY.toFixed(2)}" width="${w.toFixed(2)}" height="${boxH.toFixed(2)}" rx="4" ry="4" fill="#bfdcff" fill-opacity="0.24" stroke="none"/>`,
          `<rect x="${x.toFixed(2)}" y="${boxY.toFixed(2)}" width="${w.toFixed(2)}" height="${boxH.toFixed(2)}" rx="4" ry="4" fill="url(#randomStripe)" fill-opacity="0.55" stroke="${randomColor}" stroke-width="${Math.max(2, strokeWidth)}"/>`,
          `<text x="${(x + w / 2).toFixed(2)}" y="${(boxY - 6).toFixed(2)}" text-anchor="middle" fill="#5f98e3" font-size="12" font-family="${FONT_FAMILY}" font-weight="700">RANDOM</text>`
        );
      }
      continue;
    }

    const distance = clamp(Number(marker.distance ?? 0), 0, length);
    const lineX = xFromDistance(distance);
    const width = Number(marker.width ?? 4);
    parts.push(
      `<line x1="${lineX.toFixed(2)}" y1="${(trackTop - 12).toFixed(2)}" x2="${lineX.toFixed(2)}" y2="${(axisY + 4).toFixed(2)}" stroke="${color}" stroke-width="${width}"/>`
    );
  }

  const rawPositionKeepEnds = Array.isArray(mapData.positionKeepEnds)
    ? mapData.positionKeepEnds
    : (Array.isArray(mapData.position_keep_ends) ? mapData.position_keep_ends : []);
  const positionKeepEnds = rawPositionKeepEnds
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= length)
    .sort((a, b) => a - b);

  // Draw PK overlays last so labels stay visible on top of skill overlays.
  for (const distance of positionKeepEnds) {
    const lineX = xFromDistance(distance);
    const labelX = clamp(lineX + 6, margin.left + 4, width - margin.right - 22);
    const labelY = trackTop + rowHeight * 0.34;
    parts.push(
      `<line x1="${lineX.toFixed(2)}" y1="${(trackTop - 10).toFixed(2)}" x2="${lineX.toFixed(2)}" y2="${(axisY + 4).toFixed(2)}" stroke="${DEFAULT_COLORS.positionKeepLine}" stroke-width="2.8"/>`,
      `<text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="start" fill="${DEFAULT_COLORS.positionKeepLine}" font-size="11" font-family="${FONT_FAMILY}" font-weight="700">PK</text>`
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

export async function renderCourseMapPng(mapData, outputPath, options = {}) {
  const svg = buildSvg(mapData, options);
  const png = renderSvgToPng(svg);
  const outDir = path.dirname(outputPath);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outputPath, png);
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
    { start: 0, end: 267, label: "Early", color: MAP_COLORS.zoneEarly, textColor: "#ffffff" },
    { start: 267, end: 1067, label: "Mid", color: MAP_COLORS.zoneMid },
    { start: 1067, end: 1333, label: "Late", color: MAP_COLORS.zoneLate },
    { start: 1333, end: 1600, label: "Last Spurt", color: MAP_COLORS.zoneSpurt },
  ],
  positionKeepEnds: [500],
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
      { type: "box", start: 267, end: 1067, color: "#ff5c7a", fillOpacity: 0.13, trigger_behavior: "random" },
      { type: "box", start: 1067, end: 1600, color: "#ff5c7a", fillOpacity: 0.13, trigger_behavior: "asap" },
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
