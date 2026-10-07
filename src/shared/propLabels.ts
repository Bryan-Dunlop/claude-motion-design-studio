// One name per property, shared by the Properties panel, timeline keyframe rows and toasts.
// label = short row label, long = standalone name (timeline rows, toasts), tip = tooltip.
export interface PropLabel {
  label: string;
  long: string;
  tip: string;
}

export const PROP_LABELS: Record<string, PropLabel> = {
  x: { label: 'X', long: 'X position', tip: 'Horizontal position of the anchor point, in project pixels from the left edge.' },
  y: { label: 'Y', long: 'Y position', tip: 'Vertical position of the anchor point, in project pixels from the top edge.' },
  scale: { label: 'Scale', long: 'Scale', tip: 'Size multiplier. 1 = original size, 2 = double, 0.5 = half.' },
  rotation: { label: 'Rotation', long: 'Rotation', tip: 'Rotation in degrees around the anchor point. Positive = clockwise.' },
  opacity: { label: 'Opacity', long: 'Opacity', tip: 'How see-through the layer is. 1 = solid, 0 = invisible.' },
  fontSize: { label: 'Size', long: 'Font size', tip: 'Text height in project pixels.' },
  letterSpacing: { label: 'Spacing', long: 'Letter spacing', tip: 'Extra space between letters, in pixels. Negative tightens.' },
  color: { label: 'Colour', long: 'Text colour', tip: 'Text colour (the start colour when the fill is a gradient).' },
  width: { label: 'Width', long: 'Width', tip: 'Width in project pixels (before scale).' },
  height: { label: 'Height', long: 'Height', tip: 'Height in project pixels (before scale).' },
  cornerRadius: { label: 'Corners', long: 'Corner radius', tip: 'Rounds the rectangle corners, in pixels.' },
  fill: { label: 'Fill', long: 'Fill colour', tip: 'Fill colour of the shape (the start colour when the fill is a gradient).' },
  stroke: { label: 'Outline', long: 'Outline colour', tip: 'Colour of the outline.' },
  strokeWidth: { label: 'Outline width', long: 'Outline width', tip: 'Outline thickness in pixels. 0 = no outline.' },
  gradientTo: { label: 'To', long: 'Gradient end colour', tip: 'The colour the gradient fades to.' },
  gradientAngle: { label: 'Angle', long: 'Gradient angle', tip: 'Direction of the gradient in degrees: 0 = left to right, 90 = top to bottom.' },
  innerRadius: { label: 'Inner size', long: 'Star inner size', tip: 'How deep the star points are cut in (fraction of the outer size).' },
  trimStart: { label: 'Start %', long: 'Trim start', tip: 'Where the visible part of the outline begins, as a percentage of its length.' },
  trimEnd: { label: 'End %', long: 'Trim end', tip: 'Where the visible part of the outline ends. Animate 0 → 100% to "draw" the outline.' },
  trimOffset: { label: 'Offset %', long: 'Trim offset', tip: 'Slides the visible part along the outline (wraps around).' },
  blur: { label: 'Blur', long: 'Blur', tip: 'Softens the whole layer, in project pixels.' },
  shadowColor: { label: 'Colour', long: 'Shadow colour', tip: 'Colour and transparency of the drop shadow.' },
  shadowBlur: { label: 'Softness', long: 'Shadow softness', tip: 'How blurry the shadow edge is, in project pixels.' },
  shadowOffsetX: { label: 'Offset X', long: 'Shadow offset X', tip: 'Moves the shadow right (positive) or left (negative).' },
  shadowOffsetY: { label: 'Offset Y', long: 'Shadow offset Y', tip: 'Moves the shadow down (positive) or up (negative).' },
};

export function propLabel(prop: string): PropLabel {
  return PROP_LABELS[prop] ?? { label: prop, long: prop, tip: prop };
}
