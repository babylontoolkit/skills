"""
A small vectorised triangle rasterizer in numpy, used to find which triangle covers each texel of the new
UV layout and to build depth buffers for reference-image visibility.

Triangles are grouped by the size of their pixel bounding box, so each group is evaluated as one broadcast
array operation instead of a Python loop per triangle.
"""
from dataclasses import dataclass
from typing import Iterator, Optional

import numpy as np

# Bounding-box sizes are rounded up to these values so triangles of similar size share one batch.
BOX_SIZE_BUCKETS = np.array([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768,
                             1024, 1536, 2048, 3072, 4096, 6144, 8192, 16384], dtype=np.int64)

# Upper bound on candidate pixels evaluated in one broadcast batch; keeps memory use around a few hundred MB.
DEFAULT_BATCH_PIXEL_BUDGET = 6_000_000

# Barycentric tolerance: a slightly negative value closes hairline cracks between neighbouring triangles.
EDGE_TOLERANCE = 1e-4


@dataclass
class Fragments:
    """Pixels covered by one batch of triangles."""

    pixel_index: np.ndarray       # int64 flat index row * width + column
    triangle_index: np.ndarray    # int64 index into the triangle array that was rasterized
    barycentric: np.ndarray       # float32 (count, 3) weights of the triangle's three corners


def _bucket_size(sizes: np.ndarray) -> np.ndarray:
    """Rounds each bounding-box size up to the nearest bucket value."""
    positions = np.searchsorted(BOX_SIZE_BUCKETS, sizes, side="left")
    positions = np.minimum(positions, len(BOX_SIZE_BUCKETS) - 1)
    return np.maximum(BOX_SIZE_BUCKETS[positions], sizes)


def rasterize(
    triangle_points: np.ndarray,
    width: int,
    height: int,
    edge_tolerance: float = EDGE_TOLERANCE,
    batch_pixel_budget: int = DEFAULT_BATCH_PIXEL_BUDGET,
) -> Iterator[Fragments]:
    """
    Rasterizes 2D triangles and yields the covered pixels batch by batch. A pixel is covered when its center
    lies inside the triangle.

    :param triangle_points: float array (triangle_count, 3, 2) of corner positions in pixel units; x to the
        right, y measured from row 0.
    :param width: Raster width in pixels.
    :param height: Raster height in pixels.
    :param edge_tolerance: Barycentric slack. Positive values grow triangles slightly (no cracks); a negative
        value keeps only strict interiors (used for overlap detection).
    :param batch_pixel_budget: Maximum candidate pixels evaluated at once.
    :returns: An iterator of Fragments; a pixel may appear in several batches when triangles overlap.
    """
    points = np.asarray(triangle_points, dtype=np.float64)
    if points.shape[0] == 0:
        return
    minimum_x = np.clip(np.floor(points[:, :, 0].min(axis=1) - 0.5).astype(np.int64), 0, width - 1)
    maximum_x = np.clip(np.ceil(points[:, :, 0].max(axis=1) - 0.5).astype(np.int64), 0, width - 1)
    minimum_y = np.clip(np.floor(points[:, :, 1].min(axis=1) - 0.5).astype(np.int64), 0, height - 1)
    maximum_y = np.clip(np.ceil(points[:, :, 1].max(axis=1) - 0.5).astype(np.int64), 0, height - 1)
    outside = (points[:, :, 0].max(axis=1) < 0) | (points[:, :, 0].min(axis=1) > width) | \
              (points[:, :, 1].max(axis=1) < 0) | (points[:, :, 1].min(axis=1) > height)

    box_width = _bucket_size(maximum_x - minimum_x + 1)
    box_height = _bucket_size(maximum_y - minimum_y + 1)
    candidates = np.nonzero(~outside)[0]
    if candidates.size == 0:
        return
    group_keys = box_width[candidates] * 100_000 + box_height[candidates]
    order = np.argsort(group_keys, kind="stable")
    sorted_candidates = candidates[order]
    sorted_keys = group_keys[order]
    group_starts = np.flatnonzero(np.r_[True, sorted_keys[1:] != sorted_keys[:-1]])
    group_ends = np.r_[group_starts[1:], sorted_keys.size]

    for group_start, group_end in zip(group_starts, group_ends):
        group = sorted_candidates[group_start:group_end]
        cell_width = int(box_width[group[0]])
        cell_height = int(box_height[group[0]])
        cells_per_triangle = cell_width * cell_height
        chunk_size = max(1, batch_pixel_budget // cells_per_triangle)
        offset_x = np.tile(np.arange(cell_width), cell_height)
        offset_y = np.repeat(np.arange(cell_height), cell_width)
        for chunk_start in range(0, group.size, chunk_size):
            chunk = group[chunk_start:chunk_start + chunk_size]
            fragments = _rasterize_chunk(points, chunk, minimum_x, minimum_y, offset_x, offset_y,
                                         width, height, edge_tolerance)
            if fragments is not None:
                yield fragments


def _rasterize_chunk(points, chunk, minimum_x, minimum_y, offset_x, offset_y, width, height, edge_tolerance):
    """Evaluates every candidate pixel of a chunk of same-size triangles in one broadcast."""
    corner_a = points[chunk, 0]
    corner_b = points[chunk, 1]
    corner_c = points[chunk, 2]
    denominator = (corner_b[:, 1] - corner_c[:, 1]) * (corner_a[:, 0] - corner_c[:, 0]) + \
                  (corner_c[:, 0] - corner_b[:, 0]) * (corner_a[:, 1] - corner_c[:, 1])
    valid = np.abs(denominator) > 1e-12
    if not valid.any():
        return None
    chunk = chunk[valid]
    corner_a, corner_b, corner_c, denominator = corner_a[valid], corner_b[valid], corner_c[valid], denominator[valid]

    pixel_column = minimum_x[chunk][:, None] + offset_x[None, :]
    pixel_row = minimum_y[chunk][:, None] + offset_y[None, :]
    center_x = pixel_column + 0.5
    center_y = pixel_row + 0.5
    weight_a = ((corner_b[:, 1:2] - corner_c[:, 1:2]) * (center_x - corner_c[:, 0:1]) +
                (corner_c[:, 0:1] - corner_b[:, 0:1]) * (center_y - corner_c[:, 1:2])) / denominator[:, None]
    weight_b = ((corner_c[:, 1:2] - corner_a[:, 1:2]) * (center_x - corner_c[:, 0:1]) +
                (corner_a[:, 0:1] - corner_c[:, 0:1]) * (center_y - corner_c[:, 1:2])) / denominator[:, None]
    weight_c = 1.0 - weight_a - weight_b
    inside = (weight_a >= -edge_tolerance) & (weight_b >= -edge_tolerance) & (weight_c >= -edge_tolerance)
    inside &= (pixel_column < width) & (pixel_row < height)
    triangle_slot, cell = np.nonzero(inside)
    if triangle_slot.size == 0:
        return None
    barycentric = np.stack(
        (weight_a[triangle_slot, cell], weight_b[triangle_slot, cell], weight_c[triangle_slot, cell]), axis=1
    )
    barycentric = np.clip(barycentric, 0.0, 1.0)
    barycentric /= barycentric.sum(axis=1, keepdims=True)
    return Fragments(
        pixel_index=pixel_row[triangle_slot, cell] * width + pixel_column[triangle_slot, cell],
        triangle_index=chunk[triangle_slot].astype(np.int64),
        barycentric=barycentric.astype(np.float32),
    )


def rasterize_ids(triangle_points: np.ndarray, width: int, height: int) -> tuple:
    """
    Builds a per-pixel triangle id buffer plus barycentric weights. Where triangles overlap, the last one
    written wins.

    :param triangle_points: float array (triangle_count, 3, 2) in pixel units.
    :param width: Raster width in pixels.
    :param height: Raster height in pixels.
    :returns: (triangle_id int64 (height*width) with -1 for empty pixels,
               barycentric float32 (height*width, 3)).
    """
    triangle_id = np.full(width * height, -1, dtype=np.int64)
    barycentric = np.zeros((width * height, 3), dtype=np.float32)
    for fragments in rasterize(triangle_points, width, height):
        triangle_id[fragments.pixel_index] = fragments.triangle_index
        barycentric[fragments.pixel_index] = fragments.barycentric
    return triangle_id, barycentric


def rasterize_coverage_count(triangle_points: np.ndarray, width: int, height: int,
                             triangle_group: Optional[np.ndarray] = None) -> tuple:
    """
    Counts, per pixel, how many triangle interiors cover it, to detect overlapping UV islands. Shared edges
    are not counted twice because only strict interiors are rasterized.

    :param triangle_points: float array (triangle_count, 3, 2) in pixel units.
    :param width: Raster width in pixels.
    :param height: Raster height in pixels.
    :param triangle_group: Optional island id per triangle; when given, the returned set lists the islands
        that take part in an overlap.
    :returns: (count int32 (height*width), set of overlapping island ids).
    """
    count = np.zeros(width * height, dtype=np.int32)
    first_group = np.full(width * height, -1, dtype=np.int64)
    overlapping_groups = set()
    for fragments in rasterize(triangle_points, width, height, edge_tolerance=-1e-3):
        np.add.at(count, fragments.pixel_index, 1)
        if triangle_group is None:
            continue
        groups = triangle_group[fragments.triangle_index]
        previous = first_group[fragments.pixel_index]
        clash = (previous >= 0) & (previous != groups)
        if clash.any():
            overlapping_groups.update(np.unique(groups[clash]).tolist())
            overlapping_groups.update(np.unique(previous[clash]).tolist())
        unset = previous < 0
        first_group[fragments.pixel_index[unset]] = groups[unset]
    return count, overlapping_groups


def rasterize_depth(triangle_points: np.ndarray, triangle_depth: np.ndarray, width: int, height: int) -> np.ndarray:
    """
    Builds a depth buffer that keeps the NEAREST surface per pixel, where larger depth means closer to the
    camera.

    :param triangle_points: float array (triangle_count, 3, 2) of projected corners in pixel units.
    :param triangle_depth: float array (triangle_count, 3) of corner depths.
    :param width: Raster width in pixels.
    :param height: Raster height in pixels.
    :returns: float32 array (height, width); -inf where nothing is drawn.
    """
    depth = np.full(width * height, -np.inf, dtype=np.float32)
    for fragments in rasterize(triangle_points, width, height):
        fragment_depth = (triangle_depth[fragments.triangle_index] * fragments.barycentric).sum(axis=1)
        np.maximum.at(depth, fragments.pixel_index, fragment_depth.astype(np.float32))
    return depth.reshape(height, width)


def rasterize_mask(triangle_points: np.ndarray, width: int, height: int) -> np.ndarray:
    """
    Draws the filled silhouette of a set of triangles.

    :param triangle_points: float array (triangle_count, 3, 2) in pixel units.
    :param width: Raster width in pixels.
    :param height: Raster height in pixels.
    :returns: Boolean array (height, width).
    """
    mask = np.zeros(width * height, dtype=bool)
    for fragments in rasterize(triangle_points, width, height):
        mask[fragments.pixel_index] = True
    return mask.reshape(height, width)
