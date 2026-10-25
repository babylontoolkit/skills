"""
Reference images for bt-unwrap: find the view images in a folder, cut each subject out of its background,
work out which way the model faces by matching silhouettes, line every image up with the mesh, and build
per-view depth buffers so a reference only paints surfaces it can actually see.

"Orthographic" references made by image generators are nearly always perspective renders: parts further
from the camera look smaller, and the camera is often a little above the model. Each reference therefore
gets a fitted camera: its direction (solved within a few degrees of the named view, or anywhere around
the model for three-quarter views), a perspective strength, its in-plane rotation, scale and offset.
"""
import math
import os
import re
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

import image_utils
import mesh_tools
import rasterizer
import uv_layout

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".tga", ".tif", ".tiff", ".bmp")
VIEW_KEYWORDS = {
    "front": {"front", "fwd", "frontview"},
    "rear": {"rear", "back", "rearview", "backview"},
    "left": {"left", "lhs", "leftside", "leftview"},
    "right": {"right", "rhs", "rightside", "rightview"},
    "top": {"top", "plan", "overhead", "topview"},
    "bottom": {"bottom", "under", "underside", "bottomview"},
}
OPPOSITE_VIEWS = ({"front", "rear"}, {"left", "right"}, {"top", "bottom"})
# Words that mark an image as something other than a view of the whole model: never used.
PARTIAL_VIEW_KEYWORDS = {"detail", "details", "turnaround", "sheet", "closeup", "close", "cutaway", "crop",
                         "cropped", "zoom", "interior", "exploded"}
# Words that mark an angled view of the whole model; its camera direction is solved from the silhouette.
OBLIQUE_KEYWORDS = {"three", "quarter", "threequarter", "iso", "isometric", "perspective", "persp", "oblique",
                    "angle", "angled"}
THREE_QUARTER_PATTERN = re.compile(r"3[_\- ]?4")
OBLIQUE_ANY = "oblique"                # name for an angled view whose file name gives no direction
# Compass names for oblique cameras, by yaw sector (0 = front, 90 = left, 180 = rear, -90 = right).
COMPASS_NAMES = ((0.0, "front"), (45.0, "front_left"), (90.0, "left"), (135.0, "rear_left"),
                 (180.0, "rear"), (-135.0, "rear_right"), (-90.0, "right"), (-45.0, "front_right"))

BORDER_SAMPLE_FRACTION = 0.02          # outer strip used to estimate the background color
FLOOD_GRID_LONG_SIDE = 700             # background flood fill runs on a grid about this size
BBOX_MINIMUM_PIXELS_FRACTION = 0.002   # a row / column needs this share of subject pixels to count
SCORE_CANVAS_SIZE = 256                # long side of the silhouette comparison
COARSE_CANVAS_SIZE = 128               # long side used while searching camera directions coarsely
SCORE_CANVAS_MARGIN = 0.15             # empty border around the subject in the comparison canvas
HORIZONTAL_VIEWS = ("front", "rear", "left", "right")

# Silhouettes are scored on stand-in meshes: vertices snapped to a grid of about one comparison pixel, so
# even a multi-million-triangle mesh scores quickly and without holes. The coarse stand-in serves the
# small canvas, the fine one the full canvas.
COARSE_PROXY_CELLS = 100
FINE_PROXY_CELLS = 150
PROXY_MINIMUM_TRIANGLES = 30_000       # smaller meshes are scored as they are

# Perspective strength: how much smaller the farthest point of the model looks than the nearest one
# (0 = true orthographic, 0.5 = the far end appears at 1 / 1.5 of its size).
PERSPECTIVE_START = 0.3
PERSPECTIVE_LIMIT = 1.6
PERSPECTIVE_PER_DEGREE = 0.025         # perspective step that goes with a 1-degree direction step
# Camera direction search. A straight view may sit a few degrees off its axis (AI "orthographic" images are
# often taken from slightly above); a three-quarter view is searched around the model.
STRAIGHT_TILT_LIMIT = 12.0             # degrees a straight view's camera may move off its named axis
STRAIGHT_TILT_MINIMUM_GAIN = 0.004     # ...and only when that matches the silhouette at least this much better
OBLIQUE_TILT_LIMIT = 20.0              # degrees a three-quarter camera may move from its coarse start
OBLIQUE_YAW_STEP = 15.0
OBLIQUE_FRONT_REAR_WINDOW = 80.0       # yaw searched each side of a named front or rear
OBLIQUE_PITCH_STEPS = {"level": (-15.0, 0.0, 15.0, 30.0, 45.0, 60.0), "top": (30.0, 45.0, 60.0),
                       "bottom": (-60.0, -45.0, -30.0, -15.0)}
OBLIQUE_STARTS = 2                     # best coarse candidates refined further
OBLIQUE_DISTINCT_DEGREES = 20.0        # coarse candidates closer than this count as the same start
OBLIQUE_DUPLICATE_DEGREES = 15.0       # an angled view this close to a better-matching view adds nothing
COARSE_PATTERN_STEPS = (4.0, 1.0)      # degrees: first and last compass-search step on the small canvas
FINE_PATTERN_STEPS = (0.5, 0.5)        # ...and on the full canvas
# Scale / offset corrections that absorb an AI image's slightly different proportions: largest values and
# the first and last search steps.
REFINE_LIMITS = (0.08, 0.08, 0.06, 0.06)
REFINE_STEPS = ((0.02, 0.0025), (0.02, 0.0025), (0.01, 0.00125), (0.01, 0.00125))
IDENTITY_REFINE = (1.0, 1.0, 0.0, 0.0)


@dataclass
class ViewFrame:
    """How the model projects into one reference: rotation, perspective and the fitted extents."""

    quarter_turns: int
    perspective: float
    depth_range: tuple        # (nearest, farthest) model depth along the view
    center: tuple             # principal point in view-plane meters (center of the model's extents)
    extents: tuple            # (min_x, max_x, min_y, max_y) of the projected model


@dataclass
class ReferenceSource:
    """A reference image to load: the view it shows and, for an angled view, what its name says."""

    view: str                             # front, rear, left, right, top, bottom, or an angled-view name
    path: str
    oblique: bool = False                 # an angled view: its camera direction is solved from the silhouette
    named_views: tuple = ()               # view words in an angled view's name, e.g. ("front", "right")


@dataclass
class ReferenceImage:
    """One reference view and everything learned about it."""

    view: str
    path: str
    pixels: np.ndarray                    # float32 (height, width, 4), row 0 at the bottom
    mask: np.ndarray                      # bool (height, width): subject pixels
    bbox: tuple                           # (x0, y0, x1, y1) of the subject in pixels, bottom-up
    quarter_turns: Optional[int] = None   # fixed in-plane rotation; None = detect
    iou: float = 0.0                      # silhouette match after alignment, 0..1
    refine: tuple = IDENTITY_REFINE       # scale x, scale y, offset x, offset y (fractions of bbox)
    frame: Optional[ViewFrame] = None
    used: bool = False
    note: str = ""
    depth: Optional[np.ndarray] = field(default=None, repr=False)
    warp: Optional[object] = field(default=None, repr=False)   # reference_warp.WarpField: local alignment
    agreement: Optional[object] = field(default=None, repr=False)  # reference_warp.AgreementMap: where to trust it
    direction: Optional[np.ndarray] = None  # unit vector from the model toward the camera (oriented frame)
    oblique: bool = False                 # an angled view whose camera direction is solved
    named_views: tuple = ()               # view words in an angled view's file name
    camera_tilt: float = 0.0              # degrees the solved camera sits off the named straight axis
    overlay: str = ""                     # alignment overlay image, when previews are on

    def report(self) -> dict:
        """Summary for the JSON report."""
        return {
            "view": self.view, "path": self.path, "used": self.used, "note": self.note,
            "angled_view": self.oblique,
            "silhouette_iou": round(self.iou, 3),
            "camera_yaw_pitch_degrees": [round(value, 1) for value in direction_angles(self.direction)],
            "camera_tilt_degrees": round(self.camera_tilt, 1),
            "quarter_turns": self.frame.quarter_turns if self.frame else self.quarter_turns,
            "perspective": round(self.frame.perspective, 3) if self.frame else None,
            "refine_scale": [round(self.refine[0], 3), round(self.refine[1], 3)],
            "refine_offset": [round(self.refine[2], 3), round(self.refine[3], 3)],
            "subject_bbox": [round(value, 1) for value in self.bbox],
            "local_warp": self.warp.report() if self.warp is not None else None,
            "consistency": self.agreement.report() if self.agreement is not None else None,
        }


def discover_references(directory: Optional[str], explicit: list, include_oblique: bool = True) -> tuple:
    """
    Finds the reference images. Explicit --ref entries come first; the rest are matched by file name in the
    folder. A name with one view word is a straight view (01_front_ortho.png, car_left_side.jpg, top.webp);
    the best-named file per view wins. A name with a three-quarter word (three_quarter, 3-4, iso, angle,
    perspective) or with two neighbouring view words (front_left, top_rear) is an angled view, and every one
    is kept. Detail, close-up, cutaway and turnaround-sheet images are skipped: they do not show the whole model.

    :param directory: Folder to scan, or None.
    :param explicit: (name, path) pairs from --ref. A name is a view (front, rear, left, right, top, bottom), a
        combination of neighbouring views for an angled view (front_left, top_rear_right ...) or 'oblique'
        for an angled view whose camera direction is unknown.
    :param include_oblique: Use angled views (False skips them).
    :returns: (list of ReferenceSource, list of notes about skipped files).
    :raises ValueError: for an unknown view name or a missing file / folder.
    """
    sources = []
    notes = []
    for name, path in explicit:
        if not os.path.isfile(path):
            raise ValueError(f"--ref {name}={path}: file not found")
        source = _source_from_view_name(name, path)
        if source.oblique and not include_oblique:
            notes.append(f"skipped {path}: angled view, and --no-oblique is set")
            continue
        sources.append(source)
    if directory:
        if not os.path.isdir(directory):
            raise ValueError(f"--refs folder not found: {directory}")
        sources.extend(_scan_folder(directory, {source.view for source in sources if not source.oblique},
                                    {source.path for source in sources}, include_oblique, notes))
    return _unique_view_names(sources), notes


def _source_from_view_name(name: str, path: str) -> ReferenceSource:
    """Turns a --ref view name into a source; raises ValueError for a name that is not a view."""
    lowered = name.strip().lower()
    if lowered in VIEW_KEYWORDS:
        return ReferenceSource(view=lowered, path=path)
    if lowered in (OBLIQUE_ANY, "any", "angle", "angled"):
        return ReferenceSource(view=OBLIQUE_ANY, path=path, oblique=True)
    parts = [part for part in re.split(r"[^a-z]+", lowered) if part]
    if len(parts) >= 2 and all(part in VIEW_KEYWORDS for part in parts) and not _names_opposite_views(parts):
        return ReferenceSource(view="_".join(_ordered_views(parts)), path=path, oblique=True,
                               named_views=tuple(_ordered_views(parts)))
    raise ValueError(f"--ref view '{name}' is not a view: use front, rear, left, right, top, bottom, a "
                     f"neighbouring pair such as front_left or top_rear, or oblique")


def _scan_folder(directory: str, explicit_views: set, explicit_paths: set, include_oblique: bool,
                 notes: list) -> list:
    """Matches the images in a folder to views by file name; see discover_references."""
    straight = {}
    angled = []
    for name in sorted(os.listdir(directory)):
        stem, extension = os.path.splitext(name)
        path = os.path.join(directory, name)
        if extension.lower() not in IMAGE_EXTENSIONS or path in explicit_paths:
            continue
        lowered = stem.lower()
        tokens = set(re.split(r"[^a-z0-9]+", lowered))
        if tokens & PARTIAL_VIEW_KEYWORDS:
            notes.append(f"skipped {name}: not a view of the whole model")
            continue
        views = [view for view, keywords in VIEW_KEYWORDS.items() if tokens & keywords]
        if _names_opposite_views(views):
            notes.append(f"skipped {name}: names opposite views ({', '.join(views)})")
            continue
        angled_name = bool(tokens & OBLIQUE_KEYWORDS) or bool(THREE_QUARTER_PATTERN.search(lowered)) or len(views) > 1
        if angled_name:
            if not include_oblique:
                notes.append(f"skipped {name}: angled view, and --no-oblique is set")
                continue
            ordered = tuple(_ordered_views(views))
            angled.append(ReferenceSource(view="_".join(ordered) or OBLIQUE_ANY, path=path, oblique=True,
                                          named_views=ordered))
        elif len(views) == 1:
            straight.setdefault(views[0], []).append(name)

    sources = []
    for view, names in straight.items():
        if view in explicit_views:
            notes.append(f"skipped {', '.join(names)}: --ref already gives the {view} view")
            continue
        names.sort(key=lambda candidate: ("ortho" not in candidate.lower(), len(candidate)))
        sources.append(ReferenceSource(view=view, path=os.path.join(directory, names[0])))
        for extra in names[1:]:
            notes.append(f"skipped {extra}: {names[0]} already covers the {view} view")
    return sources + angled


def _names_opposite_views(views) -> bool:
    """True when the view words include both members of an opposite pair (front and rear, ...)."""
    named = set(views)
    return any(pair <= named for pair in OPPOSITE_VIEWS)


def _ordered_views(views) -> list:
    """View words in a fixed order (top / bottom, front / rear, left / right), so names are predictable."""
    order = ("top", "bottom", "front", "rear", "left", "right")
    return sorted(set(views), key=order.index)


def _unique_view_names(sources: list) -> list:
    """Gives repeated angled-view names a number (oblique, oblique_2 ...); straight views are unique already."""
    seen = {}
    for source in sources:
        count = seen.get(source.view, 0) + 1
        seen[source.view] = count
        if count > 1:
            source.view = f"{source.view}_{count}"
    return sources


def load_reference(source: ReferenceSource, background_tolerance: float,
                   quarter_turns: Optional[int]) -> ReferenceImage:
    """
    Loads a reference and separates the subject from the background. A transparent background is used
    directly; otherwise the background color is taken from the image border.

    :param source: The image and the view it shows.
    :param background_tolerance: How far (0..1 per channel) a pixel may differ from the background color and
        still count as background.
    :param quarter_turns: Fixed in-plane rotation, or None to detect it (top / bottom views).
    :returns: The loaded reference. An angled view's camera direction is a first guess until alignment.
    :raises RuntimeError: when no subject can be found.
    """
    pixels = image_utils.load_image_array(source.path)
    height, width = pixels.shape[:2]
    alpha = pixels[:, :, 3]
    if alpha.min() < 0.5:
        mask = alpha > 0.5
    else:
        border = max(2, int(min(width, height) * BORDER_SAMPLE_FRACTION))
        strips = np.concatenate((pixels[:border, :, :3].reshape(-1, 3), pixels[-border:, :, :3].reshape(-1, 3),
                                 pixels[:, :border, :3].reshape(-1, 3), pixels[:, -border:, :3].reshape(-1, 3)))
        background = np.median(strips, axis=0)
        background_like = np.abs(pixels[:, :, :3] - background).max(axis=2) <= background_tolerance
        # Only background-colored pixels connected to the image border are background. White logos and
        # numbers on a light backdrop have the backdrop's color too, but they are enclosed by the subject.
        mask = ~(background_like & _connected_to_border(background_like))
    mask = image_utils.dilate_mask(image_utils.erode_mask(mask, 2), 2)
    bbox = _subject_bbox(mask)
    if bbox is None:
        raise RuntimeError(f"no subject found in {source.path}; try a different --ref-bg-tolerance")
    if source.oblique:
        direction = _named_direction(source.named_views)
        quarter_turns = 0
    else:
        direction = np.array(uv_layout.VIEW_DIRECTIONS[source.view], dtype=np.float64)
        if source.view in HORIZONTAL_VIEWS and quarter_turns is None:
            quarter_turns = 0
    return ReferenceImage(view=source.view, path=source.path, pixels=pixels, mask=mask, bbox=bbox,
                          quarter_turns=quarter_turns, direction=direction, oblique=source.oblique,
                          named_views=source.named_views)


def _named_direction(named_views: tuple) -> np.ndarray:
    """First-guess camera direction for an angled view: the average of its named views (front if none)."""
    total = np.zeros(3)
    for view in named_views or ("front",):
        total += np.array(uv_layout.VIEW_DIRECTIONS[view], dtype=np.float64)
    if np.linalg.norm(total) < 1e-9:
        total = np.array(uv_layout.VIEW_DIRECTIONS["front"], dtype=np.float64)
    return total / np.linalg.norm(total)


def _connected_to_border(candidates: np.ndarray) -> np.ndarray:
    """
    Flood-fills from the image border through candidate pixels. Runs on a reduced grid for speed, then
    widens the result by one reduced cell so it reaches every full-resolution edge pixel.

    :param candidates: Boolean (height, width) pixels the fill may pass through.
    :returns: Boolean (height, width): candidates reachable from the border.
    """
    height, width = candidates.shape
    factor = max(1, int(round(max(height, width) / FLOOD_GRID_LONG_SIDE)))
    small_height, small_width = max(1, height // factor), max(1, width // factor)
    passable = image_utils.resize_image(candidates.astype(np.float32), small_width, small_height) > 0.5
    reached = np.zeros_like(passable)
    reached[0, :], reached[-1, :], reached[:, 0], reached[:, -1] = passable[0, :], passable[-1, :], \
        passable[:, 0], passable[:, -1]
    while True:
        grown = reached.copy()
        grown[1:, :] |= reached[:-1, :]
        grown[:-1, :] |= reached[1:, :]
        grown[:, 1:] |= reached[:, :-1]
        grown[:, :-1] |= reached[:, 1:]
        grown &= passable
        if np.array_equal(grown, reached):
            break
        reached = grown
    reached = image_utils.dilate_mask(reached, 1)
    full = np.repeat(np.repeat(reached, factor, axis=0), factor, axis=1)
    padded = np.zeros((height, width), dtype=bool)
    padded[:min(height, full.shape[0]), :min(width, full.shape[1])] = full[:height, :width]
    if full.shape[0] < height:
        padded[full.shape[0]:, :] = True
    if full.shape[1] < width:
        padded[:, full.shape[1]:] = True
    return candidates & padded


def _subject_bbox(mask: np.ndarray) -> Optional[tuple]:
    """Bounding box of the subject, ignoring rows / columns with only a few stray pixels."""
    height, width = mask.shape
    columns = np.flatnonzero(mask.sum(axis=0) >= max(2, height * BBOX_MINIMUM_PIXELS_FRACTION))
    rows = np.flatnonzero(mask.sum(axis=1) >= max(2, width * BBOX_MINIMUM_PIXELS_FRACTION))
    if columns.size == 0 or rows.size == 0:
        return None
    return float(columns[0]), float(rows[0]), float(columns[-1] + 1), float(rows[-1] + 1)


def direction_angles(direction: Optional[np.ndarray]) -> tuple:
    """Camera yaw (0 = front, 90 = left) and pitch (up positive) in degrees for a view direction."""
    if direction is None:
        return (0.0, 0.0)
    yaw = math.degrees(math.atan2(direction[0], -direction[1]))
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, float(direction[2])))))
    return (yaw, pitch)


def _heading_rotation(model_rotation_degrees: float) -> Optional[np.ndarray]:
    """Rotation that expresses a view direction in the coordinates of a model not yet turned."""
    if not model_rotation_degrees:
        return None
    angle = math.radians(-model_rotation_degrees)
    return np.array(((math.cos(angle), -math.sin(angle), 0.0), (math.sin(angle), math.cos(angle), 0.0),
                     (0.0, 0.0, 1.0)))


def view_coordinates(points: np.ndarray, direction: np.ndarray, quarter_turns: int,
                     model_rotation_degrees: float = 0.0) -> np.ndarray:
    """
    Projects world points orthographically into a view's 2D image plane (meters): x to the image right, y up.

    :param points: float array (..., 3).
    :param direction: Unit vector from the model toward the camera.
    :param quarter_turns: In-plane rotation of the image, in 90-degree steps.
    :param model_rotation_degrees: Rotation about +Z the model WOULD get before viewing (used to score
        heading candidates without moving the mesh).
    :returns: float array (..., 2).
    """
    right, up = uv_layout.view_axes(np.asarray(direction, dtype=np.float64))
    rotation = _heading_rotation(model_rotation_degrees)
    if rotation is not None:
        right, up = rotation @ right, rotation @ up
    across = points @ right
    upward = points @ up
    turns = quarter_turns % 4
    if turns == 1:
        across, upward = -upward, across
    elif turns == 2:
        across, upward = -across, -upward
    elif turns == 3:
        across, upward = upward, -across
    return np.stack((across, upward), axis=-1)


def depth_along(points: np.ndarray, direction: np.ndarray, model_rotation_degrees: float = 0.0) -> np.ndarray:
    """
    Distance of points toward a view's camera; larger is closer.

    :param points: float array (..., 3).
    :param direction: Unit vector from the model toward the camera.
    :param model_rotation_degrees: As in view_coordinates.
    :returns: float array (...).
    """
    direction = np.asarray(direction, dtype=np.float64)
    rotation = _heading_rotation(model_rotation_degrees)
    if rotation is not None:
        direction = rotation @ direction
    return points @ direction


def build_view_frame(triangle_positions: np.ndarray, direction: np.ndarray, quarter_turns: int, perspective: float,
                     model_rotation_degrees: float = 0.0) -> ViewFrame:
    """
    Measures how the model projects into a view for a given rotation and perspective strength.

    :param triangle_positions: float array (count, 3, 3).
    :param direction: Unit vector from the model toward the camera.
    :param quarter_turns: In-plane rotation.
    :param perspective: Perspective strength (see PERSPECTIVE_START).
    :param model_rotation_degrees: Heading candidate, as in view_coordinates.
    :returns: The frame, including the projected extents.
    """
    return _frame_and_projection(triangle_positions, direction, quarter_turns, perspective, model_rotation_degrees)[0]


def _frame_and_projection(triangle_positions: np.ndarray, direction: np.ndarray, quarter_turns: int,
                          perspective: float, model_rotation_degrees: float = 0.0) -> tuple:
    """
    Builds a view frame and projects the triangles with it in one pass.

    :returns: (ViewFrame, float array (count, 3, 2) of projected corners in view-plane meters).
    """
    flat = triangle_positions.reshape(-1, 3)
    orthographic = view_coordinates(flat, direction, quarter_turns, model_rotation_degrees)
    depth = depth_along(flat, direction, model_rotation_degrees)
    center = ((orthographic[:, 0].min() + orthographic[:, 0].max()) / 2.0,
              (orthographic[:, 1].min() + orthographic[:, 1].max()) / 2.0)
    depth_range = (float(depth.max()), float(depth.min()))
    projected = _apply_perspective(orthographic, depth, depth_range, perspective, center)
    frame = ViewFrame(quarter_turns=quarter_turns, perspective=perspective, depth_range=depth_range, center=center,
                      extents=(projected[:, 0].min(), projected[:, 0].max(), projected[:, 1].min(),
                               projected[:, 1].max()))
    return frame, projected.reshape(triangle_positions.shape[:-1] + (2,))


def project_with_frame(points: np.ndarray, direction: np.ndarray, frame: ViewFrame,
                       model_rotation_degrees: float = 0.0) -> np.ndarray:
    """
    Projects world points into a view with the frame's rotation and perspective: points further from the
    camera are pulled toward the principal point.

    :param points: float array (..., 3).
    :param direction: Unit vector from the model toward the camera.
    :param frame: The fitted frame.
    :param model_rotation_degrees: Heading candidate, as in view_coordinates.
    :returns: float array (..., 2) in view-plane meters.
    """
    coordinates = view_coordinates(points, direction, frame.quarter_turns, model_rotation_degrees)
    if frame.perspective <= 0.0:
        return coordinates
    depth = depth_along(points, direction, model_rotation_degrees)
    return _apply_perspective(coordinates, depth, frame.depth_range, frame.perspective, frame.center)


def _apply_perspective(coordinates: np.ndarray, depth: np.ndarray, depth_range: tuple, perspective: float,
                       center: tuple) -> np.ndarray:
    """Pulls projected points toward the principal point the further they are from the camera."""
    if perspective <= 0.0:
        return coordinates
    nearest, farthest = depth_range
    behind = (nearest - depth) / max(nearest - farthest, 1e-12)
    shrink = 1.0 / (1.0 + perspective * np.clip(behind, 0.0, 1.0))
    principal_point = np.array(center)
    return principal_point + (coordinates - principal_point) * shrink[..., None]


def _nominal_mapping(coordinates_2d: np.ndarray, extents: tuple, bbox: tuple) -> np.ndarray:
    """Maps view-plane coordinates so the model's extents fill the reference subject's bounding box."""
    minimum_x, maximum_x, minimum_y, maximum_y = extents
    x0, y0, x1, y1 = bbox
    pixel_x = x0 + (coordinates_2d[..., 0] - minimum_x) / max(maximum_x - minimum_x, 1e-12) * (x1 - x0)
    pixel_y = y0 + (coordinates_2d[..., 1] - minimum_y) / max(maximum_y - minimum_y, 1e-12) * (y1 - y0)
    return np.stack((pixel_x, pixel_y), axis=-1)


def _apply_refine(pixel_points: np.ndarray, bbox: tuple, refine: tuple) -> np.ndarray:
    """Scales about the bbox center and shifts by fractions of the bbox size."""
    scale_x, scale_y, offset_x, offset_y = refine
    x0, y0, x1, y1 = bbox
    center_x, center_y = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    refined_x = center_x + (pixel_points[..., 0] - center_x) * scale_x + offset_x * (x1 - x0)
    refined_y = center_y + (pixel_points[..., 1] - center_y) * scale_y + offset_y * (y1 - y0)
    return np.stack((refined_x, refined_y), axis=-1)


def map_to_reference(reference: ReferenceImage, points: np.ndarray) -> np.ndarray:
    """
    Maps world points of the oriented model to pixel coordinates in a reference image, using the fitted
    alignment.

    :param reference: An aligned reference (align_reference must have run).
    :param points: float array (..., 3).
    :returns: float array (..., 2) of pixel coordinates, bottom-up.
    """
    coordinates_2d = project_with_frame(points, reference.direction, reference.frame)
    nominal = _nominal_mapping(coordinates_2d, reference.frame.extents, reference.bbox)
    return _apply_refine(nominal, reference.bbox, reference.refine)


class _ScoreCanvas:
    """Low-resolution window around a reference's subject, for fast silhouette comparisons."""

    def __init__(self, reference: ReferenceImage, size: int = SCORE_CANVAS_SIZE):
        x0, y0, x1, y1 = reference.bbox
        margin_x = (x1 - x0) * SCORE_CANVAS_MARGIN
        margin_y = (y1 - y0) * SCORE_CANVAS_MARGIN
        self.reference = reference
        self.origin_x, self.origin_y = x0 - margin_x, y0 - margin_y
        span_x, span_y = (x1 - x0) + 2 * margin_x, (y1 - y0) + 2 * margin_y
        self.pixels_per_unit = size / max(span_x, span_y)
        self.width = max(8, int(round(span_x * self.pixels_per_unit)))
        self.height = max(8, int(round(span_y * self.pixels_per_unit)))
        grid_x, grid_y = np.meshgrid(np.arange(self.width) + 0.5, np.arange(self.height) + 0.5)
        self.grid = np.stack((self.origin_x + grid_x / self.pixels_per_unit,
                              self.origin_y + grid_y / self.pixels_per_unit), axis=-1)
        self.identity_mask = self._reference_mask(IDENTITY_REFINE)

    def mesh_mask(self, pixel_points: np.ndarray) -> np.ndarray:
        """Rasterizes mesh triangles given in reference pixel coordinates."""
        canvas_points = np.stack(((pixel_points[..., 0] - self.origin_x) * self.pixels_per_unit,
                                  (pixel_points[..., 1] - self.origin_y) * self.pixels_per_unit), axis=-1)
        return rasterizer.rasterize_mask(canvas_points, self.width, self.height)

    def overlap(self, mesh_mask: np.ndarray, refine: tuple) -> float:
        """
        Intersection over union of the mesh silhouette and the reference subject, with the mesh moved by
        `refine`. The mesh stays put; the reference is sampled where the moved mesh would land.
        """
        reference_mask = self.identity_mask if refine == IDENTITY_REFINE else self._reference_mask(refine)
        union = np.logical_or(mesh_mask, reference_mask).sum()
        return float(np.logical_and(mesh_mask, reference_mask).sum() / max(union, 1))

    def _reference_mask(self, refine: tuple) -> np.ndarray:
        """The reference subject sampled on the canvas grid, moved by `refine`."""
        sample_points = _apply_refine(self.grid, self.reference.bbox, refine)
        return image_utils.sample_nearest(self.reference.mask, sample_points[..., 0].ravel(),
                                          sample_points[..., 1].ravel()).reshape(self.height, self.width)


@dataclass
class _Pose:
    """One camera candidate for a reference, and how well the model's silhouette matches from it."""

    direction: np.ndarray
    quarter_turns: int
    perspective: float
    score: float = -1.0


class _PoseScorer:
    """Scores camera candidates for one reference on the silhouette stand-in mesh."""

    def __init__(self, reference: ReferenceImage, proxy_positions: np.ndarray, canvas_size: int):
        self.reference = reference
        self.triangles = proxy_positions
        self.canvas = _ScoreCanvas(reference, canvas_size)

    def score(self, direction: np.ndarray, quarter_turns: int, perspective: float,
              model_rotation_degrees: float = 0.0) -> float:
        """
        Silhouette overlap of the model seen from a camera candidate, with the model's projected extents
        stretched onto the subject's bounding box, discounted when that stretch changes the shape's aspect.

        :returns: Score in 0..1; higher is a better match.
        """
        frame, projected = _frame_and_projection(self.triangles, direction, quarter_turns, perspective,
                                                 model_rotation_degrees)
        mesh_mask = self.canvas.mesh_mask(_nominal_mapping(projected, frame.extents, self.reference.bbox))
        return self.canvas.overlap(mesh_mask, IDENTITY_REFINE) * _aspect_agreement(frame, self.reference.bbox) ** 0.25

    def evaluate(self, pose: _Pose) -> _Pose:
        """Scores a pose in place and returns it."""
        pose.score = self.score(pose.direction, pose.quarter_turns, pose.perspective)
        return pose


def _aspect_agreement(frame: ViewFrame, bbox: tuple) -> float:
    """1.0 when the projected model and the subject have the same width-to-height ratio, lower otherwise."""
    model_aspect = (frame.extents[1] - frame.extents[0]) / max(frame.extents[3] - frame.extents[2], 1e-12)
    x0, y0, x1, y1 = bbox
    image_aspect = (x1 - x0) / max(y1 - y0, 1e-12)
    return min(model_aspect, image_aspect) / max(model_aspect, image_aspect)


def _search_refine(canvas: _ScoreCanvas, mesh_mask: np.ndarray) -> tuple:
    """
    Finds small scale and offset corrections by coordinate search: each of scale x, scale y, offset x and
    offset y is stepped either way while that helps, and the steps shrink until they reach their last size.

    :returns: (best iou, best refine tuple).
    """
    values = list(IDENTITY_REFINE)
    best_iou = canvas.overlap(mesh_mask, IDENTITY_REFINE)
    steps = [first for first, _ in REFINE_STEPS]
    while any(step >= last for step, (_, last) in zip(steps, REFINE_STEPS)):
        for index, (_, last) in enumerate(REFINE_STEPS):
            if steps[index] < last:
                continue
            improved = False
            for direction in (1.0, -1.0):
                candidate = list(values)
                candidate[index] += direction * steps[index]
                if abs(candidate[index] - IDENTITY_REFINE[index]) > REFINE_LIMITS[index] + 1e-9:
                    continue
                candidate_iou = canvas.overlap(mesh_mask, tuple(candidate))
                if candidate_iou > best_iou + 1e-6:
                    values, best_iou, improved = candidate, candidate_iou, True
                    break
            if not improved:
                steps[index] /= 2.0
    return best_iou, tuple(values)


def _quarter_turn_candidates(reference: ReferenceImage) -> list:
    """The in-plane rotations worth testing for a reference."""
    return [reference.quarter_turns] if reference.quarter_turns is not None else [0, 1, 2, 3]


def camera_direction(yaw_degrees: float, pitch_degrees: float) -> np.ndarray:
    """
    Unit vector from the model toward a camera, in the oriented model frame.

    :param yaw_degrees: 0 = in front, 90 = on the model's left, 180 = behind, -90 = on its right.
    :param pitch_degrees: Height above the horizon; 90 = straight above.
    :returns: float64 3-vector.
    """
    yaw, pitch = math.radians(yaw_degrees), math.radians(pitch_degrees)
    return np.array((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))


def tilt_direction(direction: np.ndarray, across_degrees: float, up_degrees: float) -> np.ndarray:
    """
    Moves a camera direction by small angles along its own image axes: `across` toward the image's right,
    `up` toward the image's top. Used to search around a named or coarse camera direction.

    :returns: Unit float64 3-vector.
    """
    right, up = uv_layout.view_axes(np.asarray(direction, dtype=np.float64))
    tilted = direction + right * math.tan(math.radians(across_degrees)) + up * math.tan(math.radians(up_degrees))
    return tilted / np.linalg.norm(tilted)


def _angle_between(first: np.ndarray, second: np.ndarray) -> float:
    """Angle between two unit vectors, in degrees."""
    return math.degrees(math.acos(float(np.clip(np.dot(first, second), -1.0, 1.0))))


def _pattern_search(scorer: _PoseScorer, start: _Pose, tilt_limit: float, steps: tuple) -> _Pose:
    """
    Refines a camera candidate by compass search over its two tilt angles and its perspective strength:
    tries a step either way along each, moves as soon as one helps, and halves the step when none does.

    :param scorer: Scores poses for the reference.
    :param start: Starting pose (scored here); tilts are measured from its direction.
    :param tilt_limit: Largest total tilt from the start, degrees (0 searches perspective only).
    :param steps: (first, last) step in degrees.
    :returns: The best pose found.
    """
    best = scorer.evaluate(_Pose(start.direction, start.quarter_turns, start.perspective))
    across = up = 0.0
    step, last_step = steps
    while step >= last_step - 1e-9:
        improved = False
        perspective_step = step * PERSPECTIVE_PER_DEGREE
        for across_change, up_change, perspective_change in ((step, 0.0, 0.0), (-step, 0.0, 0.0), (0.0, step, 0.0),
                                                             (0.0, -step, 0.0), (0.0, 0.0, perspective_step),
                                                             (0.0, 0.0, -perspective_step)):
            candidate_across, candidate_up = across + across_change, up + up_change
            perspective = best.perspective + perspective_change
            if math.hypot(candidate_across, candidate_up) > tilt_limit + 1e-9:
                continue
            if not 0.0 <= perspective <= PERSPECTIVE_LIMIT:
                continue
            candidate = scorer.evaluate(_Pose(tilt_direction(start.direction, candidate_across, candidate_up),
                                              best.quarter_turns, perspective))
            if candidate.score > best.score + 1e-6:
                best, across, up, improved = candidate, candidate_across, candidate_up, True
                break
        if not improved:
            step /= 2.0
    return best


def _refine_pose(reference: ReferenceImage, proxies: "SilhouetteProxies", start: _Pose, tilt_limit: float) -> _Pose:
    """Compass-searches a pose on the small canvas, then finishes on the full canvas."""
    coarse = _pattern_search(_PoseScorer(reference, proxies.coarse, COARSE_CANVAS_SIZE), start, tilt_limit,
                             COARSE_PATTERN_STEPS)
    # The full-canvas pass only polishes: it may move a little around the small-canvas result.
    fine_limit = 0.0 if tilt_limit == 0.0 else FINE_PATTERN_STEPS[0] * 2.0
    return _pattern_search(_PoseScorer(reference, proxies.fine, SCORE_CANVAS_SIZE), coarse, fine_limit,
                           FINE_PATTERN_STEPS)


def _solve_straight_camera(reference: ReferenceImage, proxies: "SilhouetteProxies") -> _Pose:
    """
    Fits a straight view's camera: the in-plane rotation (top / bottom views), the perspective strength,
    and a small tilt off the named axis, kept only when it clearly matches the silhouette better.
    """
    named = np.asarray(reference.direction, dtype=np.float64)
    turn_scorer = _PoseScorer(reference, proxies.coarse, COARSE_CANVAS_SIZE)
    starts = [turn_scorer.evaluate(_Pose(named, turns, PERSPECTIVE_START)) for turns in _quarter_turn_candidates(reference)]
    tilted = _refine_pose(reference, proxies, max(starts, key=lambda pose: pose.score), STRAIGHT_TILT_LIMIT)
    # The named axis with the tilted fit's perspective, polished: the yardstick the tilt must clearly beat.
    upright = _pattern_search(_PoseScorer(reference, proxies.fine, SCORE_CANVAS_SIZE),
                              _Pose(named, tilted.quarter_turns, tilted.perspective), 0.0, FINE_PATTERN_STEPS)
    return tilted if tilted.score >= upright.score + STRAIGHT_TILT_MINIMUM_GAIN else upright


def _solve_oblique_camera(reference: ReferenceImage, proxies: "SilhouetteProxies") -> _Pose:
    """
    Finds an angled view's camera: a coarse yaw / pitch grid on a small canvas (yaw kept to the front or
    rear half when the file name says which; left and right are always searched, because names often give
    them from the viewer's side), then the best few starts refined.
    """
    coarse = _PoseScorer(reference, proxies.coarse, COARSE_CANVAS_SIZE)
    candidates = [coarse.evaluate(_Pose(camera_direction(yaw, pitch), 0, PERSPECTIVE_START))
                  for yaw in _oblique_yaw_candidates(reference.named_views)
                  for pitch in _oblique_pitch_candidates(reference.named_views)]
    candidates.sort(key=lambda pose: pose.score, reverse=True)
    starts = []
    for candidate in candidates:
        if all(_angle_between(candidate.direction, chosen.direction) >= OBLIQUE_DISTINCT_DEGREES for chosen in starts):
            starts.append(candidate)
        if len(starts) == OBLIQUE_STARTS:
            break
    refined = [_refine_pose(reference, proxies, start, OBLIQUE_TILT_LIMIT) for start in starts]
    return max(refined, key=lambda pose: pose.score)


def _oblique_yaw_candidates(named_views: tuple) -> np.ndarray:
    """Coarse camera yaws for an angled view: the named front or rear half, or all the way round."""
    if "front" in named_views or "rear" in named_views:
        center = 0.0 if "front" in named_views else 180.0
        steps = int(OBLIQUE_FRONT_REAR_WINDOW // OBLIQUE_YAW_STEP)
        return center + OBLIQUE_YAW_STEP * np.arange(-steps, steps + 1)
    return np.arange(-180.0, 180.0, OBLIQUE_YAW_STEP)


def _oblique_pitch_candidates(named_views: tuple) -> tuple:
    """Coarse camera pitches for an angled view: from above when named 'top', from below when 'bottom'."""
    if "top" in named_views:
        return OBLIQUE_PITCH_STEPS["top"]
    if "bottom" in named_views:
        return OBLIQUE_PITCH_STEPS["bottom"]
    return OBLIQUE_PITCH_STEPS["level"]


def compass_name(direction: np.ndarray) -> str:
    """Name of the side a camera looks from: front, front_left, left ... (top_ / bottom_ prefix when steep)."""
    yaw, pitch = direction_angles(direction)
    nearest = min(COMPASS_NAMES, key=lambda entry: abs((yaw - entry[0] + 180.0) % 360.0 - 180.0))[1]
    if pitch >= 50.0:
        return f"top_{nearest}"
    if pitch <= -50.0:
        return f"bottom_{nearest}"
    return nearest


@dataclass
class SilhouetteProxies:
    """Stand-in meshes for scoring silhouettes: one for the small search canvas, one for the full canvas."""

    coarse: np.ndarray    # float array (count, 3, 3)
    fine: np.ndarray


def build_silhouette_proxies(triangle_positions: np.ndarray) -> SilhouetteProxies:
    """
    Builds the stand-ins used to score silhouettes quickly at any mesh size.

    :param triangle_positions: float array (count, 3, 3) of the model.
    :returns: Coarse and fine stand-ins (the model itself when it is already small).
    """
    return SilhouetteProxies(coarse=_cluster_vertices(triangle_positions, COARSE_PROXY_CELLS),
                             fine=_cluster_vertices(triangle_positions, FINE_PROXY_CELLS))


def _cluster_vertices(triangle_positions: np.ndarray, cells_across: int) -> np.ndarray:
    """
    Snaps every vertex to a grid of `cells_across` cells along the model's diagonal (averaging the corners in
    a cell) and drops the triangles that collapse: a hole-free silhouette stand-in of bounded size.
    Meshes under PROXY_MINIMUM_TRIANGLES are returned unchanged.

    :param triangle_positions: float array (count, 3, 3).
    :param cells_across: Grid cells across the diagonal.
    :returns: float array (proxy_count, 3, 3).
    """
    if triangle_positions.shape[0] <= PROXY_MINIMUM_TRIANGLES:
        return triangle_positions
    corners = triangle_positions.reshape(-1, 3)
    minimum = corners.min(axis=0)
    cell = float(np.linalg.norm(corners.max(axis=0) - minimum)) / cells_across
    grid = np.floor((corners - minimum) / max(cell, 1e-12)).astype(np.int64)
    span = grid.max(axis=0) + 1
    cell_keys = (grid[:, 0] * span[1] + grid[:, 1]) * span[2] + grid[:, 2]
    unique_cells, corner_cluster = np.unique(cell_keys, return_inverse=True)
    members = np.bincount(corner_cluster)
    representative = np.stack([np.bincount(corner_cluster, weights=corners[:, axis]) for axis in range(3)],
                              axis=1) / members[:, None]
    clusters = corner_cluster.reshape(-1, 3)
    whole = (clusters[:, 0] != clusters[:, 1]) & (clusters[:, 1] != clusters[:, 2]) & (clusters[:, 0] != clusters[:, 2])
    clusters = np.sort(clusters[whole], axis=1)
    cluster_count = unique_cells.size
    triangle_keys = (clusters[:, 0] * cluster_count + clusters[:, 1]) * cluster_count + clusters[:, 2]
    _, first = np.unique(triangle_keys, return_index=True)
    return representative[clusters[first]]


def detect_forward(references: list, triangle_positions: np.ndarray) -> tuple:
    """
    Works out which horizontal axis the model's front faces by fitting its silhouette into every straight
    reference under each of the four possible headings. The side views settle front versus back; the front /
    rear views versus the sides settle which axis is the long one. Angled views are not used: their camera
    direction is itself solved against the heading.

    :param references: Loaded references.
    :param triangle_positions: float array (count, 3, 3) of the model as imported.
    :returns: (forward axis name '+x' / '-x' / '+y' / '-y', dict of score per axis); ('keep', {}) when
        there is no straight reference.
    """
    straight = [reference for reference in references if not reference.oblique]
    if not straight:
        return "keep", {}
    proxy = _cluster_vertices(triangle_positions, COARSE_PROXY_CELLS)
    scorers = [_PoseScorer(reference, proxy, COARSE_CANVAS_SIZE) for reference in straight]
    scores = {}
    for axis, rotation_degrees in mesh_tools.FORWARD_ROTATION_DEGREES.items():
        per_reference = []
        for scorer in scorers:
            reference = scorer.reference
            per_reference.append(max(scorer.score(reference.direction, turns, perspective, rotation_degrees)
                                     for turns in _quarter_turn_candidates(reference) for perspective in (0.0, 0.3)))
        scores[axis] = float(np.mean(per_reference))
    forward = max(scores, key=scores.get)
    return forward, {axis: round(score, 3) for axis, score in scores.items()}


def align_reference(reference: ReferenceImage, triangle_positions: np.ndarray, refine: bool, minimum_iou: float,
                    proxies: Optional[SilhouetteProxies] = None) -> None:
    """
    Fits a reference's camera to the oriented model: its direction (a small tilt for a straight view, a full
    search for an angled one), in-plane rotation (top / bottom), perspective strength, and optionally small
    scale and offset corrections; then decides whether the image is trustworthy enough to paint with.

    :param reference: A loaded reference; updated in place (direction, frame, refine, iou, used, note).
    :param triangle_positions: float array (count, 3, 3) of the oriented model.
    :param refine: Search scale / offset corrections as well (absorbs AI-drawn proportions).
    :param minimum_iou: References matching worse than this are not used.
    :param proxies: Silhouette stand-ins of the same model (build_silhouette_proxies); built when omitted.
    """
    proxies = proxies if proxies is not None else build_silhouette_proxies(triangle_positions)
    if reference.oblique:
        pose = _solve_oblique_camera(reference, proxies)
    else:
        named = np.asarray(reference.direction, dtype=np.float64)
        pose = _solve_straight_camera(reference, proxies)
        reference.camera_tilt = _angle_between(named, pose.direction)
    reference.direction = pose.direction
    reference.frame = build_view_frame(triangle_positions, pose.direction, pose.quarter_turns, pose.perspective)

    canvas = _ScoreCanvas(reference)
    projected = project_with_frame(triangle_positions, pose.direction, reference.frame)
    mesh_mask = canvas.mesh_mask(_nominal_mapping(projected, reference.frame.extents, reference.bbox))
    iou, refine_values = canvas.overlap(mesh_mask, IDENTITY_REFINE), IDENTITY_REFINE
    if refine:
        iou, refine_values = _search_refine(canvas, mesh_mask)
    reference.iou = iou
    reference.refine = tuple(float(value) for value in refine_values)
    reference.used = reference.iou >= minimum_iou
    if not reference.used:
        reference.note = (f"silhouette match {reference.iou:.2f} is below --ref-min-iou {minimum_iou:.2f}; "
                          "the image does not line up with the model")


def settle_oblique_views(references: list) -> list:
    """
    Gives every aligned angled view a name from where its camera really is (front_left, rear_right ...),
    noting when that disagrees with its file name, and drops an angled view whose camera nearly repeats a
    better-matching view's.

    :param references: Aligned references; updated in place.
    :returns: Notes for the report.
    """
    notes = []
    taken = {reference.view for reference in references if not reference.oblique}
    for reference in sorted([reference for reference in references if reference.oblique], key=lambda item: -item.iou):
        yaw, pitch = direction_angles(reference.direction)
        name = compass_name(reference.direction)
        if reference.named_views and not set(reference.named_views) <= set(name.split("_")):
            notes.append(f"{os.path.basename(reference.path)}: named {'_'.join(reference.named_views)}, but its "
                         f"camera is at the model's {name} (yaw {yaw:.0f}, pitch {pitch:.0f}); file names often "
                         f"give left / right from the viewer's side")
        unique_name, number = name, 2
        while unique_name in taken:
            unique_name, number = f"{name}_{number}", number + 1
        reference.view = unique_name
        taken.add(unique_name)
        if not reference.used:
            continue
        for other in references:
            if other is reference or not other.used or other.iou < reference.iou:
                continue
            if _angle_between(other.direction, reference.direction) < OBLIQUE_DUPLICATE_DEGREES:
                reference.used = False
                reference.note = f"its camera nearly repeats the {other.view} view, which matches better"
                break
    return notes


def build_depth_buffer(reference: ReferenceImage, triangle_positions: np.ndarray) -> None:
    """
    Renders the oriented model's nearest-surface depth into the reference's pixel grid, so texels hidden
    behind other parts in that view are not painted from it.

    :param reference: An aligned reference; its depth buffer is stored on it.
    :param triangle_positions: float array (count, 3, 3) of the oriented model.
    """
    height, width = reference.mask.shape
    pixel_points = map_to_reference(reference, triangle_positions)
    triangle_depth = depth_along(triangle_positions, reference.direction)
    reference.depth = rasterizer.rasterize_depth(pixel_points, triangle_depth, width, height)
