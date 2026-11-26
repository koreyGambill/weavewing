import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { APP_BASE_NAME } from "../lib/mobileBranding";

const ThemedPath = withUniwind(Path);

const MARK_PATHS = [
  "M128 128L128 26M128 128L216 77M128 128L216 179M128 128L128 230M128 128L40 179M128 128L40 77",
  "M128 26Q153 85 216 77Q178 128 216 179Q153 171 128 230Q103 171 40 179Q78 128 40 77Q103 85 128 26Z",
  "M128 60Q145 99 187 94Q161 128 187 162Q145 157 128 196Q111 157 69 162Q95 128 69 94Q111 99 128 60Z",
  "M128 94Q136 114 157 111Q144 128 157 145Q136 142 128 162Q120 142 99 145Q112 128 99 111Q120 114 128 94Z",
];

// Pads the mark's 204-unit extent so the widened strokes stay inside the frame.
const VIEW_BOX_SIZE = 220;
// The source strokes vanish below about 40pt, so keep them near 1.2pt at any size.
const RENDERED_STROKE_WIDTH = 1.2;

/** The app's mark in one color, sized by its square edge. */
export function AppMark(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const strokeWidth = Math.max(3.5, (RENDERED_STROKE_WIDTH * VIEW_BOX_SIZE) / props.size);
  return (
    <Svg
      accessibilityLabel={APP_BASE_NAME}
      height={props.size}
      width={props.size}
      viewBox={`18 18 ${VIEW_BOX_SIZE} ${VIEW_BOX_SIZE}`}
    >
      {MARK_PATHS.map((d) => (
        <ThemedPath
          key={d}
          d={d}
          color={props.color}
          colorClassName={props.colorClassName}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
