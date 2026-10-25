"""
Local alignment for bt-unwrap's reference images.

A reference image and an AI-generated mesh never agree exactly: a logo drawn at one spot in the image sits a
little elsewhere on the mesh. The source texture the generator baked onto the mesh is blurry, but its logos
and stripes ARE where the mesh expects them. So each reference is matched against a render of that source
texture from the reference's own (fitted) camera: both images are cut into overlapping patches, every patch
pair is phase-correlated to find how far the reference's content is shifted, and the shifts become a smooth
displacement field. Painting then samples the sharp reference at the displaced position, which puts its
detail exactly where the mesh's features are.

Coarse-to-fine: a low-resolution pass catches large shifts, a finer pass on the pre-warped image refines them.

The same render also checks consistency. A generated reference and a generated mesh disagree most on
complex parts (engines, suspension, cockpits): the image draws a chrome fin, a reflection or a pipe where the
mesh has something else. Where the model's own texture shows features (edges of parts, letters, stripes), a
trustworthy reference shows the same features in the same places, only sharper, so their local correlation
is high; a reference drawing different parts correlates poorly. Where the model's texture shows nothing (a
plain panel the generator left blank), there is nothing to contradict and the reference is trusted. The
agreement map records this per pixel; texture_compose decides how much it matters on each face (a lot in
cluttered parts, little on smooth panels, where a reference is simply a decal).
"""
from dataclasses import dataclass
from typing import Optional

import numpy as np

import image_utils
import rasterizer
import reference_views
import uv_layout

PYRAMID_LONG_SIDES = (512, 1024)       # working resolutions, coarse to fine
PATCH_SIZE = 64                         # working pixels; shifts up to half of this are measurable
PATCH_STEP = 16                         # spacing of patch centers in working pixels
DETAIL_BLUR_RADIUS = 1                  # removes pixel noise before matching
BACKGROUND_BLUR_RADIUS = 6              # high-pass: removes shading, keeps edges (logos, stripes)
MINIMUM_PATCH_COVERAGE = 0.85           # share of a patch that must be on the subject in both images
MINIMUM_PATCH_CONTRAST = 0.01           # patches with less high-pass energy carry no alignment signal
MINIMUM_PEAK = 0.08                     # phase-correlation peak below this is treated as no match
OUTLIER_PIXELS = 3.0                    # a shift this far from its neighbours' median is discarded
# The measured shifts become a smooth correction: a coarse control grid fitted to them, where bending costs
# much more than a uniform stretch, shear or shift. Straight edges (a wing, a stripe) stay straight; local
# bends survive only where many patches agree on them.
CONTROL_SPACING_FRACTION = 0.15         # control grid spacing, as a share of the subject's longer side
BENDING_PENALTY = 4.0                   # weight of the straightness penalty, relative to the measurements
ROBUST_PASSES = 3                       # reweighting passes that discount shifts disagreeing with the fit
ROBUST_PIXELS = 2.0                     # residual (working pixels) beyond which a shift's weight drops

CONSISTENCY_LONG_SIDE = 1024            # working resolution of the consistency check
CONSISTENCY_MINIMUM_PIXELS = 500        # fewer comparable pixels than this: no check (everything trusted)
# The test compares features about 0.5-2.5 % of the subject across (parts, letters, stripes): finer detail is
# what a reference should add, and a band this coarse tolerates the few pixels the warp leaves.
STRUCTURE_FINE_FRACTION = 0.0025        # band-pass inner blur radius, as a share of the subject's longer side
STRUCTURE_COARSE_FRACTION = 0.0125      # band-pass outer blur radius
STRUCTURE_WINDOW_FRACTION = 0.015       # correlation window radius
STRUCTURE_MINIMUM_ENERGY = 0.012        # source feature strength (luminance) below which there is nothing to test
# Local feature correlation that gives no trust / full trust, per unit of --ref-consistency (0.5 -> 0.05 / 0.3).
CORRELATION_RAMP_PER_STRICTNESS = (0.1, 0.6)


@dataclass
class WarpField:
    """A displacement field over a reference image, in full-resolution reference pixels."""

    displacement: np.ndarray   # float32 (grid_height, grid_width, 2): x, y shift to add to sample positions
    origin: tuple              # full-resolution pixel position of grid cell (0, 0)
    step: float                # full-resolution pixels between grid cells
    patches_used: int
    median_shift: float        # full-resolution pixels
    maximum_shift: float

    def displacement_at(self, pixel_x: np.ndarray, pixel_y: np.ndarray) -> np.ndarray:
        """
        Interpolates the shift at reference pixel positions.

        :param pixel_x: Horizontal pixel coordinates.
        :param pixel_y: Vertical pixel coordinates, bottom-up.
        :returns: float array (count, 2).
        """
        grid_x = (pixel_x - self.origin[0]) / self.step + 0.5
        grid_y = (pixel_y - self.origin[1]) / self.step + 0.5
        return image_utils.sample_bilinear(self.displacement, grid_x, grid_y)

    def report(self) -> dict:
        """Summary for the JSON report."""
        return {"patches_used": self.patches_used, "median_shift_pixels": round(self.median_shift, 1),
                "maximum_shift_pixels": round(self.maximum_shift, 1)}


@dataclass
class AgreementMap:
    """How far each part of a reference image can be trusted: 1 where it agrees with the source texture."""

    values: np.ndarray         # float32 (height, width), 0..1, at the check's working resolution
    scale: float               # working pixels per full-resolution reference pixel
    source_render: np.ndarray  # float32 (height, width, 3) what the model's own texture shows from this camera
    reference_render: np.ndarray  # float32 (height, width, 3) the warped reference
    trusted_percent: float     # share of the model's pixels in this view that agree

    def at(self, pixel_x: np.ndarray, pixel_y: np.ndarray) -> np.ndarray:
        """
        Agreement at full-resolution reference pixel positions (already warped).

        :param pixel_x: Horizontal pixel coordinates.
        :param pixel_y: Vertical pixel coordinates, bottom-up.
        :returns: float32 array (count,), 0..1.
        """
        return image_utils.sample_bilinear(self.values[:, :, None], pixel_x * self.scale, pixel_y * self.scale)[:, 0]

    def report(self) -> dict:
        """Summary for the JSON report."""
        return {"trusted_percent": round(self.trusted_percent, 1)}


def consistency_map(reference, triangles, color: np.ndarray, strictness: float) -> Optional[AgreementMap]:
    """
    Compares a reference with the model's own (baked source) texture seen from the same fitted camera and
    maps how far it can be trusted: wherever the source shows features, the reference's features must line
    up with them.

    :param reference: An aligned reference with a depth buffer (and its local warp, when there is one).
    :param triangles: TriangleSet of the final mesh with the working UV layer.
    :param color: float32 (size, size, 4) baked source color on the working layout.
    :param strictness: 0..1; how closely the features must correlate (0.5 = the default --ref-consistency).
    :returns: The agreement map, or None when too little of the model is visible to compare.
    """
    view = render_source_view(reference, triangles, color, CONSISTENCY_LONG_SIDE)
    source_rgb, covered, scale = view.rgb, view.covered, view.scale
    height, width = covered.shape
    grid_x, grid_y = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    full_x, full_y = grid_x.ravel() / scale, grid_y.ravel() / scale
    if reference.warp is not None:
        shift = reference.warp.displacement_at(full_x, full_y)
        full_x, full_y = full_x + shift[:, 0], full_y + shift[:, 1]
    reference_rgb = image_utils.sample_bilinear(reference.pixels[:, :, :3], full_x, full_y).reshape(height, width, 3)
    in_subject = image_utils.sample_nearest(reference.mask, full_x, full_y).reshape(height, width)
    comparable = covered & in_subject
    if comparable.sum() < CONSISTENCY_MINIMUM_PIXELS:
        return None
    x0, y0, x1, y1 = reference.bbox
    subject_pixels = max(x1 - x0, y1 - y0) * scale
    agreement = _structure_trust(source_rgb, reference_rgb, covered, subject_pixels, strictness)
    agreement[~covered] = 1.0   # off the model nothing is painted; keep edges from fading through the windows
    return AgreementMap(values=agreement, scale=scale, source_render=source_rgb, reference_render=reference_rgb,
                        trusted_percent=float((agreement[comparable] >= 0.5).mean()) * 100.0)


def _structure_trust(source_rgb: np.ndarray, reference_rgb: np.ndarray, covered: np.ndarray,
                     subject_pixels: float, strictness: float) -> np.ndarray:
    """
    Local correlation of the two images' features (a band-pass of luminance, lighting removed), over windows
    a little larger than the features and only over the model's own pixels. Where the source shows hardly
    any features there is nothing to contradict, so the reference is trusted (it may add detail the source
    lost).

    :param subject_pixels: Length of the subject's longer side in working pixels; sets the feature scale.
    :param strictness: 0..1 scale of the correlation thresholds.
    :returns: float32 (height, width), 0..1.
    """
    fine = max(1, int(round(STRUCTURE_FINE_FRACTION * subject_pixels)))
    coarse = max(fine + 2, int(round(STRUCTURE_COARSE_FRACTION * subject_pixels)))
    radius = max(3, int(round(STRUCTURE_WINDOW_FRACTION * subject_pixels)))
    source_features = _masked_structure(source_rgb, covered, fine, coarse)
    reference_features = _masked_structure(reference_rgb, covered, fine, coarse)
    weight = covered.astype(np.float32)

    def local_mean(values: np.ndarray) -> np.ndarray:
        return box_blur(box_blur(values * weight, radius), radius)

    weight_mean = np.maximum(local_mean(np.ones_like(weight)), 1e-6)
    source_mean = local_mean(source_features) / weight_mean
    reference_mean = local_mean(reference_features) / weight_mean
    source_variance = np.maximum(local_mean(source_features ** 2) / weight_mean - source_mean ** 2, 0.0)
    reference_variance = np.maximum(local_mean(reference_features ** 2) / weight_mean - reference_mean ** 2, 0.0)
    covariance = local_mean(source_features * reference_features) / weight_mean - source_mean * reference_mean
    correlation = covariance / np.sqrt(source_variance * reference_variance + 1e-8)
    low, high = (value * strictness for value in CORRELATION_RAMP_PER_STRICTNESS)
    trust = np.clip((correlation - low) / max(high - low, 1e-6), 0.0, 1.0)
    has_features = np.sqrt(source_variance) >= STRUCTURE_MINIMUM_ENERGY
    return np.where(has_features, trust, 1.0).astype(np.float32)


def _masked_blur(image: np.ndarray, weight_mask: np.ndarray, radius: int) -> np.ndarray:
    """
    Blurs an image using only the pixels inside a mask (normalized convolution); outside stays as is.

    :param image: float array (height, width) or (height, width, channels).
    :param weight_mask: Boolean (height, width) pixels that take part.
    :param radius: Box radius; applied twice for a smooth falloff.
    :returns: float32 array of the same shape.
    """
    weight = weight_mask.astype(np.float32)
    blurred_weight = np.maximum(box_blur(box_blur(weight, radius), radius), 1e-6)
    planes = image[:, :, None] if image.ndim == 2 else image
    channels = [box_blur(box_blur(planes[:, :, channel] * weight, radius), radius) / blurred_weight
                for channel in range(planes.shape[2])]
    blurred = np.where(weight_mask[:, :, None], np.stack(channels, axis=-1), planes)
    return (blurred[:, :, 0] if image.ndim == 2 else blurred).astype(np.float32)


def _masked_structure(rgb: np.ndarray, covered: np.ndarray, fine_radius: int, coarse_radius: int) -> np.ndarray:
    """
    Band-pass grayscale (features between the two blur radii), computed over the model's own pixels only, so
    the outline of the model against whatever lies behind it (black in a render, the backdrop in a photo)
    adds no features.
    """
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    detail = _masked_blur(luminance, covered, fine_radius)
    background = _masked_blur(detail, covered, coarse_radius)
    return np.where(covered, detail - background, 0.0).astype(np.float32)


def consistency_preview(agreement: AgreementMap) -> np.ndarray:
    """
    Check image for the consistency map, three panels: the source render, the warped reference, and the
    reference with the areas whose features disagree with the source tinted red.

    :param agreement: A computed agreement map.
    :returns: float32 (height, width * 3 + gaps, 4) image, bottom-up.
    """
    height, width = agreement.values.shape
    doubt = (1.0 - agreement.values)[:, :, None] * 0.75
    tinted = np.clip(agreement.reference_render * (1.0 - doubt) + np.array((0.9, 0.0, 0.0)) * doubt, 0.0, 1.0)
    gap = np.ones((height, 8, 3), dtype=np.float32)
    panels = np.concatenate((agreement.source_render, gap, agreement.reference_render, gap, tinted), axis=1)
    return np.concatenate((panels, np.ones(panels.shape[:2] + (1,), dtype=np.float32)), axis=2).astype(np.float32)


@dataclass
class SourceView:
    """The model, textured with its own baked source color, seen through a reference's fitted camera."""

    rgb: np.ndarray            # float32 (height, width, 3)
    covered: np.ndarray        # bool (height, width): pixels on the model
    depth: np.ndarray          # float32 (height, width): nearest surface toward the camera, -inf off the model
    scale: float               # working pixels per full-resolution reference pixel


def render_source_view(reference, triangles, color: np.ndarray, long_side: int) -> SourceView:
    """
    Renders the model, textured with the baked source color on the new layout, through a reference's
    fitted camera at a working resolution.

    :param reference: An aligned reference.
    :param triangles: TriangleSet of the final mesh with the working UV layer.
    :param color: float32 (size, size, 4) baked source color.
    :param long_side: Working resolution of the longer image side.
    :returns: The rendered view.
    """
    full_height, full_width = reference.mask.shape
    scale = long_side / max(full_width, full_height)
    width, height = max(8, int(round(full_width * scale))), max(8, int(round(full_height * scale)))
    pixel_points = reference_views.map_to_reference(reference, triangles.positions) * scale
    triangle_depth = reference_views.depth_along(triangles.positions, reference.direction)
    nearest = rasterizer.rasterize_depth(pixel_points, triangle_depth, width, height).ravel()

    depth_slack = 1e-4 * float(np.ptp(triangle_depth))
    texture_size = color.shape[0]
    uvs = triangles.uvs[uv_layout.NEW_UV_LAYER]
    image = np.zeros((width * height, 3), dtype=np.float32)
    covered = np.zeros(width * height, dtype=bool)
    for fragments in rasterizer.rasterize(pixel_points, width, height):
        fragment_depth = (triangle_depth[fragments.triangle_index] * fragments.barycentric).sum(axis=1)
        front = fragment_depth >= nearest[fragments.pixel_index] - depth_slack
        if not front.any():
            continue
        triangle_index = fragments.triangle_index[front]
        weights = fragments.barycentric[front]
        texel_uv = (uvs[triangle_index] * weights[:, :, None]).sum(axis=1)
        image[fragments.pixel_index[front]] = image_utils.sample_bilinear(
            color[:, :, :3], texel_uv[:, 0] * texture_size, texel_uv[:, 1] * texture_size)
        covered[fragments.pixel_index[front]] = True
    return SourceView(rgb=image.reshape(height, width, 3), covered=covered.reshape(height, width),
                      depth=nearest.reshape(height, width), scale=scale)


def box_blur(image: np.ndarray, radius: int) -> np.ndarray:
    """
    Separable box blur with edge clamping (summed-area along each axis).

    :param image: float array (height, width).
    :param radius: Half-width in pixels; 0 returns the input.
    :returns: Blurred array, same shape.
    """
    if radius <= 0:
        return image
    blurred = image.astype(np.float64)
    for axis in (0, 1):
        padded = np.concatenate((np.repeat(np.take(blurred, [0], axis=axis), radius + 1, axis=axis), blurred,
                                 np.repeat(np.take(blurred, [-1], axis=axis), radius, axis=axis)), axis=axis)
        cumulative = np.cumsum(padded, axis=axis)
        length = blurred.shape[axis]
        upper = np.take(cumulative, np.arange(2 * radius + 1, 2 * radius + 1 + length), axis=axis)
        lower = np.take(cumulative, np.arange(0, length), axis=axis)
        blurred = (upper - lower) / (2 * radius + 1)
    return blurred.astype(np.float32)


def _structure(rgb: np.ndarray) -> np.ndarray:
    """Edges-only grayscale: luminance, lightly denoised, minus its local average (lighting removed)."""
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    detail = box_blur(box_blur(luminance, DETAIL_BLUR_RADIUS), DETAIL_BLUR_RADIUS)
    background = box_blur(box_blur(detail, BACKGROUND_BLUR_RADIUS), BACKGROUND_BLUR_RADIUS)
    return detail - background


def _patch_centers(height: int, width: int) -> tuple:
    """Grid of patch centers; returns (row centers, column centers)."""
    half = PATCH_SIZE // 2
    return (np.arange(half, max(half + 1, height - half), PATCH_STEP),
            np.arange(half, max(half + 1, width - half), PATCH_STEP))


def _extract_patches(image: np.ndarray, rows: np.ndarray, columns: np.ndarray) -> np.ndarray:
    """Cuts PATCH_SIZE squares centered on every grid point; returns (rows, columns, size, size)."""
    half = PATCH_SIZE // 2
    offsets = np.arange(-half, half)
    row_index = rows[:, None, None, None] + offsets[None, None, :, None]
    column_index = columns[None, :, None, None] + offsets[None, None, None, :]
    row_index = np.clip(row_index, 0, image.shape[0] - 1)
    column_index = np.clip(column_index, 0, image.shape[1] - 1)
    return image[row_index, column_index]


def _phase_correlate(source_patches: np.ndarray, reference_patches: np.ndarray) -> tuple:
    """
    Finds, for every patch pair, the shift d with reference(x) ≈ source(x - d).

    :returns: (shift float32 (..., 2) as x, y; peak float32 (...) in 0..1).
    """
    window = np.outer(np.hanning(PATCH_SIZE), np.hanning(PATCH_SIZE)).astype(np.float32)
    source_spectrum = np.fft.rfft2(source_patches * window)
    reference_spectrum = np.fft.rfft2(reference_patches * window)
    cross = reference_spectrum * np.conj(source_spectrum)
    cross /= np.maximum(np.abs(cross), 1e-9)
    correlation = np.fft.irfft2(cross, s=(PATCH_SIZE, PATCH_SIZE))
    flat = correlation.reshape(correlation.shape[:-2] + (-1,))
    peak_index = flat.argmax(axis=-1)
    peak = np.take_along_axis(flat, peak_index[..., None], axis=-1)[..., 0]
    shift_y = peak_index // PATCH_SIZE
    shift_x = peak_index % PATCH_SIZE
    shift_x = np.where(shift_x >= PATCH_SIZE // 2, shift_x - PATCH_SIZE, shift_x).astype(np.float32)
    shift_y = np.where(shift_y >= PATCH_SIZE // 2, shift_y - PATCH_SIZE, shift_y).astype(np.float32)
    fraction_x, fraction_y = _subpixel_offsets(flat, peak_index)
    return np.stack((shift_x + fraction_x, shift_y + fraction_y), axis=-1), peak.astype(np.float32)


def _subpixel_offsets(flat_correlation: np.ndarray, peak_index: np.ndarray) -> tuple:
    """Parabolic refinement of each correlation peak; returns (x offset, y offset), each within ±0.5 pixel."""
    row = peak_index // PATCH_SIZE
    column = peak_index % PATCH_SIZE

    def value_at(at_row, at_column):
        wrapped = (at_row % PATCH_SIZE) * PATCH_SIZE + (at_column % PATCH_SIZE)
        return np.take_along_axis(flat_correlation, wrapped[..., None], axis=-1)[..., 0]

    center = value_at(row, column)
    offsets = []
    for before, after in ((value_at(row, column - 1), value_at(row, column + 1)),
                          (value_at(row - 1, column), value_at(row + 1, column))):
        denominator = before - 2.0 * center + after
        offset = np.where(np.abs(denominator) > 1e-9, 0.5 * (before - after) / denominator, 0.0)
        offsets.append(np.clip(offset, -0.5, 0.5).astype(np.float32))
    return offsets[0], offsets[1]


def _neighbour_median(field: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Median of each grid cell's valid 3x3 neighbours (NaN where there are none)."""
    height, width = valid.shape
    stacked = np.full((9, height, width, 2), np.nan, dtype=np.float32)
    padded = np.pad(np.where(valid[..., None], field, np.nan), ((1, 1), (1, 1), (0, 0)), constant_values=np.nan)
    slot = 0
    for row_shift in (-1, 0, 1):
        for column_shift in (-1, 0, 1):
            stacked[slot] = padded[1 + row_shift:1 + row_shift + height, 1 + column_shift:1 + column_shift + width]
            slot += 1
    with np.errstate(all="ignore"):
        return np.nanmedian(stacked, axis=0)


def _fit_smooth_field(shifts: np.ndarray, valid: np.ndarray, weights: np.ndarray, rows: np.ndarray,
                      columns: np.ndarray, spacing: float) -> np.ndarray:
    """
    Fits a smooth displacement field to the measured patch shifts: values on a coarse control grid,
    interpolated bilinearly, chosen to match the measurements (robustly reweighted) while keeping second
    differences small — so the field stays close to a uniform stretch, shear and shift and only bends where
    the data clearly asks for it.

    :param shifts: float32 (grid_height, grid_width, 2) measured shifts per patch.
    :param valid: Boolean (grid_height, grid_width) patches to trust.
    :param weights: float32 (grid_height, grid_width) confidence per patch (correlation peak).
    :param rows: Patch-center rows in working pixels.
    :param columns: Patch-center columns in working pixels.
    :param spacing: Control grid spacing in working pixels.
    :returns: float32 (grid_height, grid_width, 2) smooth field on the patch grid.
    """
    control_columns = max(2, int(np.ceil((columns[-1] - columns[0]) / spacing)) + 1)
    control_rows = max(2, int(np.ceil((rows[-1] - rows[0]) / spacing)) + 1)
    interpolation = _bilinear_matrix(rows, columns, control_rows, control_columns)
    bending = _bending_matrix(control_rows, control_columns)
    targets = shifts.reshape(-1, 2).astype(np.float64)
    base_weight = np.where(valid, weights, 0.0).ravel().astype(np.float64)
    penalty = BENDING_PENALTY * max(float(base_weight.sum()), 1.0) / (control_rows * control_columns)
    regularizer = penalty * (bending.T @ bending) + 1e-6 * np.eye(control_rows * control_columns)
    robust_weight = np.ones_like(base_weight)
    controls = np.zeros((control_rows * control_columns, 2))
    for _ in range(ROBUST_PASSES):
        weight = base_weight * robust_weight
        weighted = interpolation * weight[:, None]
        controls = np.linalg.solve(interpolation.T @ weighted + regularizer, weighted.T @ targets)
        residual = np.linalg.norm(interpolation @ controls - targets, axis=1)
        robust_weight = np.minimum(1.0, ROBUST_PIXELS / np.maximum(residual, 1e-9))
    return (interpolation @ controls).reshape(shifts.shape).astype(np.float32)


def _bilinear_matrix(rows: np.ndarray, columns: np.ndarray, control_rows: int, control_columns: int) -> np.ndarray:
    """Weights that interpolate a control grid (spanning the patch grid) at every patch center."""
    grid_row = (rows - rows[0]) / max(float(rows[-1] - rows[0]), 1.0) * (control_rows - 1)
    grid_column = (columns - columns[0]) / max(float(columns[-1] - columns[0]), 1.0) * (control_columns - 1)
    row_low = np.minimum(np.floor(grid_row).astype(np.int64), control_rows - 2)
    column_low = np.minimum(np.floor(grid_column).astype(np.int64), control_columns - 2)
    row_fraction = grid_row - row_low
    column_fraction = grid_column - column_low
    matrix = np.zeros((rows.size, columns.size, control_rows * control_columns))
    patch_row, patch_column = np.meshgrid(np.arange(rows.size), np.arange(columns.size), indexing="ij")
    for row_step, row_weight in ((0, 1.0 - row_fraction), (1, row_fraction)):
        for column_step, column_weight in ((0, 1.0 - column_fraction), (1, column_fraction)):
            control = (row_low[:, None] + row_step) * control_columns + (column_low[None, :] + column_step)
            matrix[patch_row, patch_column, control] += row_weight[:, None] * column_weight[None, :]
    return matrix.reshape(rows.size * columns.size, control_rows * control_columns)


def _bending_matrix(control_rows: int, control_columns: int) -> np.ndarray:
    """Second differences along rows and columns plus the twist term: zero exactly for affine fields."""
    def index(row: int, column: int) -> int:
        return row * control_columns + column

    equations = []
    for row in range(control_rows):
        for column in range(control_columns):
            if 0 < column < control_columns - 1:
                equations.append({index(row, column - 1): 1.0, index(row, column): -2.0, index(row, column + 1): 1.0})
            if 0 < row < control_rows - 1:
                equations.append({index(row - 1, column): 1.0, index(row, column): -2.0, index(row + 1, column): 1.0})
            if row < control_rows - 1 and column < control_columns - 1:
                equations.append({index(row, column): 1.0, index(row, column + 1): -1.0,
                                  index(row + 1, column): -1.0, index(row + 1, column + 1): 1.0})
    matrix = np.zeros((max(len(equations), 1), control_rows * control_columns))
    for equation_number, equation in enumerate(equations):
        for control, value in equation.items():
            matrix[equation_number, control] = value
    return matrix


def _estimate_level(source_structure, source_covered, reference_structure, reference_covered, maximum_shift,
                    control_spacing):
    """One pyramid level: patch shifts on a grid, outliers removed, then a smooth field fitted to them."""
    rows, columns = _patch_centers(*source_structure.shape)
    source_patches = _extract_patches(source_structure, rows, columns)
    reference_patches = _extract_patches(reference_structure, rows, columns)
    source_coverage = _extract_patches(source_covered.astype(np.float32), rows, columns).mean(axis=(-1, -2))
    reference_coverage = _extract_patches(reference_covered.astype(np.float32), rows, columns).mean(axis=(-1, -2))
    contrast = np.minimum(source_patches.std(axis=(-1, -2)), reference_patches.std(axis=(-1, -2)))
    shifts, peaks = _phase_correlate(source_patches, reference_patches)
    valid = (source_coverage >= MINIMUM_PATCH_COVERAGE) & (reference_coverage >= MINIMUM_PATCH_COVERAGE) & \
            (contrast >= MINIMUM_PATCH_CONTRAST) & (peaks >= MINIMUM_PEAK) & \
            (np.linalg.norm(shifts, axis=-1) <= maximum_shift)
    if valid.sum() >= 4:
        local = _neighbour_median(shifts, valid)
        deviation = np.linalg.norm(shifts - np.nan_to_num(local), axis=-1)
        valid &= ~np.isnan(local[..., 0]) & (deviation <= OUTLIER_PIXELS)
    if not valid.any():
        return np.zeros(shifts.shape, dtype=np.float32), rows, columns, 0
    return _fit_smooth_field(shifts, valid, peaks, rows, columns, control_spacing), rows, columns, int(valid.sum())


def _sample_field(field, rows, columns, pixel_x, pixel_y):
    """Bilinear lookup of a patch-grid field at working-resolution pixel positions."""
    grid_x = (pixel_x - columns[0]) / PATCH_STEP + 0.5
    grid_y = (pixel_y - rows[0]) / PATCH_STEP + 0.5
    return image_utils.sample_bilinear(field, grid_x, grid_y)


def estimate_warp(reference, triangles, color: np.ndarray, maximum_shift_fraction: float):
    """
    Measures how far each part of a reference image is shifted from where the mesh expects it.

    :param reference: An aligned, used reference with a depth buffer.
    :param triangles: TriangleSet of the final mesh with the working UV layer.
    :param color: float32 (size, size, 4) baked source color on the working layout.
    :param maximum_shift_fraction: Largest allowed shift as a fraction of the subject's longer side.
    :returns: A WarpField in full-resolution pixels, or None when no patch matched.
    """
    x0, y0, x1, y1 = reference.bbox
    subject_long_side = max(x1 - x0, y1 - y0)
    total_field = None
    total_rows = total_columns = None
    total_scale = 1.0
    patches_used = 0
    for long_side in PYRAMID_LONG_SIDES:
        view = render_source_view(reference, triangles, color, long_side)
        source_rgb, source_covered, scale = view.rgb, view.covered, view.scale
        height, width = source_covered.shape
        reference_rgb = image_utils.resize_image(reference.pixels[:, :, :3], width, height)
        reference_covered = image_utils.resize_image(reference.mask.astype(np.float32), width, height) > 0.5
        if total_field is not None:
            # Pre-warp the reference with the coarser estimate, so this level only measures what is left.
            grid_x, grid_y = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
            full_x, full_y = grid_x.ravel() / scale, grid_y.ravel() / scale
            shift = _sample_field(total_field, total_rows, total_columns, full_x * total_scale,
                                  full_y * total_scale) / total_scale
            sample_x, sample_y = full_x + shift[:, 0], full_y + shift[:, 1]
            reference_rgb = image_utils.sample_bilinear(reference.pixels[:, :, :3], sample_x, sample_y)\
                .reshape(height, width, 3)
            reference_covered = image_utils.sample_nearest(reference.mask, sample_x, sample_y).reshape(height, width)
        maximum_shift = maximum_shift_fraction * subject_long_side * scale
        residual, rows, columns, used = _estimate_level(_structure(source_rgb), source_covered,
                                                        _structure(reference_rgb), reference_covered, maximum_shift,
                                                        CONTROL_SPACING_FRACTION * subject_long_side * scale)
        patches_used = used
        if total_field is None:
            total_field, total_rows, total_columns, total_scale = residual, rows, columns, scale
            continue
        # Combine: resample the coarse field onto this level's grid (in this level's pixels) and add the residual.
        grid_x, grid_y = np.meshgrid(columns.astype(np.float64), rows.astype(np.float64))
        coarse = _sample_field(total_field, total_rows, total_columns, grid_x.ravel() / scale * total_scale,
                               grid_y.ravel() / scale * total_scale).reshape(residual.shape) / total_scale * scale
        total_field, total_rows, total_columns, total_scale = coarse + residual, rows, columns, scale

    if total_field is None or patches_used == 0:
        return None
    limit = maximum_shift_fraction * subject_long_side * total_scale
    magnitude = np.linalg.norm(total_field, axis=-1, keepdims=True)
    total_field = total_field * np.minimum(1.0, limit / np.maximum(magnitude, 1e-9))
    full_resolution = (total_field / total_scale).astype(np.float32)
    shift_lengths = np.linalg.norm(full_resolution, axis=-1)
    return WarpField(
        displacement=full_resolution,
        origin=(float(total_columns[0]) / total_scale, float(total_rows[0]) / total_scale),
        step=PATCH_STEP / total_scale,
        patches_used=patches_used,
        median_shift=float(np.median(shift_lengths)),
        maximum_shift=float(shift_lengths.max()),
    )


def warp_preview(reference, triangles, color: np.ndarray, long_side: int = 1024) -> np.ndarray:
    """
    Side-by-side check image: the source render, the reference as fitted, and the reference after warping.

    :param reference: A reference (its warp may be None).
    :param triangles: TriangleSet of the final mesh with the working UV layer.
    :param color: float32 (size, size, 4) baked source color.
    :param long_side: Width of each panel's longer side.
    :returns: float32 (height, width * 3 + gaps, 4) image, bottom-up.
    """
    view = render_source_view(reference, triangles, color, long_side)
    source_rgb, scale = view.rgb, view.scale
    height, width = source_rgb.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    full_x, full_y = grid_x.ravel() / scale, grid_y.ravel() / scale
    fitted = image_utils.sample_bilinear(reference.pixels[:, :, :3], full_x, full_y).reshape(height, width, 3)
    warped = fitted
    if reference.warp is not None:
        shift = reference.warp.displacement_at(full_x, full_y)
        warped = image_utils.sample_bilinear(reference.pixels[:, :, :3], full_x + shift[:, 0], full_y + shift[:, 1])\
            .reshape(height, width, 3)
    gap = np.ones((height, 8, 3), dtype=np.float32)
    panels = np.concatenate((source_rgb, gap, fitted, gap, warped), axis=1)
    return np.concatenate((panels, np.ones(panels.shape[:2] + (1,), dtype=np.float32)), axis=2)
