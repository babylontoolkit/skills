"""
Texture compositing for bt-unwrap. Every face of the model gets ONE source of color: the reference view that
sees it best, or the model's own baked texture. On smooth panels a reference is a decal and wins wherever it
sees the face well; in cluttered parts (engines, cockpits, suspension — where much of the surface is hidden
behind other parts) it must also show the same features as the model's own texture, because there a
generated image and a generated mesh rarely draw the same parts. Neighbouring faces are pulled toward the
same choice, so the result is made of whole patches; colors are blended only across the single ring of
faces where two patches meet, so nothing is averaged into a ghost. Each view's exposure is evened out, the
source texture's colors are matched to the references, and island edges are padded.

This is the per-face view selection used to texture meshes from photographs (Waechter et al., "Let There Be
Color!", 2014), with the model's own baked texture as one more candidate.
"""
from dataclasses import dataclass

import numpy as np

import image_utils
import rasterizer
import reference_views
import uv_layout

TEXEL_CHUNK = 2_000_000
COLOR_MATCH_MINIMUM_TEXELS = 2_000
COLOR_MATCH_GAIN_LIMITS = (0.5, 2.0)
STRONG_COVERAGE = 0.9
EXPOSURE_HEAD_ON = 0.5              # texels a view sees this directly, and agrees on, measure its exposure
EXPOSURE_MINIMUM_TEXELS = 2_000     # views with fewer such texels keep a gain of 1
EXPOSURE_GAIN_LIMIT = 1.8           # no view is brightened or darkened more than this
SOURCE_LABEL = 0                    # face label of the model's own texture; view n has label n + 1
LABEL_PASSES = 10                   # smoothing passes of the face labels
# A seam between two choices costs more where they look different there: seams settle in plain areas
# instead of cutting through a logo. Cost per shared edge = smoothness * (1 + this * color difference).
SEAM_COLOR_WEIGHT = 4.0
UNAVAILABLE_COLOR_DIFFERENCE = 1.0  # color difference assumed where a choice cannot paint a face
MINIMUM_SEEN_SHARE = 0.5            # a view must see this share of a face for the refusal reason to be 'other'
# Clutter: how much of the surface within this distance (share of the model diagonal) is hidden from the
# views that face it. This share of hidden surface counts as fully cluttered.
CLUTTER_RADIUS_FRACTION = 0.012
CLUTTER_FULL_SHARE = 0.35
CLUTTER_OPEN_COLOR = np.array((0.15, 0.35, 0.75), dtype=np.float32)       # clutter map: open surface
CLUTTER_CLUTTERED_COLOR = np.array((1.00, 0.55, 0.10), dtype=np.float32)  # ... cluttered surface
CLUTTER_FACING = 0.3                # views facing a face at least this much (mean) judge whether it is hidden

# Coverage map colors: which view painted a texel, and why a texel kept the model's own texture.
VIEW_COLORS = {
    "front": (0.20, 0.45, 1.00), "rear": (1.00, 0.85, 0.15), "left": (0.20, 0.85, 0.30),
    "right": (0.10, 0.85, 0.85), "top": (0.85, 0.25, 0.95), "bottom": (1.00, 0.55, 0.15),
    "front_left": (0.95, 0.95, 0.95), "front_right": (0.65, 1.00, 0.10),
    "rear_left": (0.55, 0.35, 0.15), "rear_right": (0.15, 0.20, 0.60),
}
EXTRA_VIEW_COLORS = ((0.55, 0.55, 0.10), (0.00, 0.45, 0.40), (0.75, 0.65, 1.00), (1.00, 0.60, 0.50))
REFUSED_HIDDEN_COLOR = (0.90, 0.05, 0.05)        # the best view faced it but other geometry hid it
REFUSED_OUTSIDE_COLOR = (1.00, 0.45, 0.70)       # it projected off the subject
REFUSED_INCONSISTENT_COLOR = (0.02, 0.02, 0.02)  # the view shows something else than the model's own texture
UNSEEN_COLOR = (0.22, 0.22, 0.22)                # no view faces it closely enough (or the source scored higher)
REFUSAL_NONE, REFUSAL_HIDDEN, REFUSAL_OUTSIDE, REFUSAL_INCONSISTENT = 0, 1, 2, 3


@dataclass
class TexelSurface:
    """For every covered texel of the new layout: where it is on the model and which way it faces."""

    size: int
    texel_index: np.ndarray       # int64 flat indices (row * size + column) of covered texels
    triangle_index: np.ndarray    # int64 triangle under each covered texel
    barycentric: np.ndarray       # float32 (count, 3) position of each texel inside its triangle
    positions: np.ndarray         # float32 (count, 3) world position
    normals: np.ndarray           # float32 (count, 3) smoothed normal, used to weigh reference views

    def covered_mask(self) -> np.ndarray:
        """Boolean (size, size) mask of texels that lie on the model."""
        mask = np.zeros(self.size * self.size, dtype=bool)
        mask[self.texel_index] = True
        return mask.reshape(self.size, self.size)


def build_texel_surface(triangles, size: int, vertex_normals: np.ndarray) -> TexelSurface:
    """
    Rasterizes the new UV layout to find the surface point behind every texel.

    :param triangles: TriangleSet with the working UV layer.
    :param size: Texture size in pixels.
    :param vertex_normals: float32 (vertex_count, 3) smoothed normals numbered like triangles.vertex_index.
        Weighing views by these keeps a lumpy panel from flickering between views.
    :returns: The covered texels with their positions and normals.
    """
    uv_pixels = triangles.uvs[uv_layout.NEW_UV_LAYER].astype(np.float64) * size
    triangle_id, barycentric = rasterizer.rasterize_ids(uv_pixels, size, size)
    texel_index = np.flatnonzero(triangle_id >= 0)
    triangle_index = triangle_id[texel_index]
    weights = barycentric[texel_index]
    positions = (triangles.positions[triangle_index] * weights[:, :, None]).sum(axis=1).astype(np.float32)
    normals = (vertex_normals[triangles.vertex_index[triangle_index]] * weights[:, :, None]).sum(axis=1)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-20)
    return TexelSurface(size=size, texel_index=texel_index, triangle_index=triangle_index,
                        barycentric=weights.astype(np.float32), positions=positions,
                        normals=normals.astype(np.float32))


@dataclass
class ViewSamples:
    """What one reference offers: its color at every texel it may paint, and per-face totals for choosing."""

    view: str
    texels: np.ndarray          # int64 indices into the covered-texel arrays, where the view may paint
    colors: np.ndarray          # float32 (count, 3) sRGB colors sampled from the reference
    facing: np.ndarray          # float32 (count,) how directly each of those texels faces the view, 0..1
    trust: np.ndarray           # float32 (count,) agreement with the model's own texture there, 0..1
    face_facing: np.ndarray     # float32 (triangles,) sum of facing over every texel of the face
    face_active: np.ndarray     # float32 (triangles,) texels of the face that face the view at all
    face_visible: np.ndarray    # float32 (triangles,) ...that it can see
    face_inside: np.ndarray     # float32 (triangles,) ...and that land on its subject (the paintable ones)
    face_seen_facing: np.ndarray  # float32 (triangles,) sum of facing over the paintable texels
    face_trust: np.ndarray      # float32 (triangles,) sum of trust over the paintable texels


def compose_color(baked_color: np.ndarray, surface: TexelSurface, triangles, references: list, options,
                  model_diagonal: float, padding: int) -> tuple:
    """
    Builds the final base color: every face takes its color from its chosen view or from the color-matched
    source texture, with soft hand-overs only where choices meet, then pads around islands.

    :param baked_color: float32 (size, size, 4) baked source base color (sRGB values).
    :param surface: Covered texels of the new layout.
    :param triangles: TriangleSet of the final mesh (vertex numbering and positions for the face choices).
    :param references: Aligned references.
    :param options: Parsed options (ref_strength, ref_source_score, ref_seam_smoothness, color_match, padding ...).
    :param model_diagonal: Bounding-box diagonal in meters.
    :param padding: Island edge padding in pixels at this texture size.
    :returns: (final color float32 (size, size, 4), statistics dict, diagnostic maps: name -> float32
               (size, size, 4) texture for the same layout — 'coverage' (see coverage_image) and 'clutter' (see
               clutter_image); empty when there are no references).
    """
    size = surface.size
    flat_color = baked_color.reshape(-1, 4).copy()
    source_colors = flat_color[surface.texel_index, :3]
    statistics = {"reference_painted_percent": 0.0, "per_view_percent": {}, "color_match": {"applied": False}}
    diagnostic_maps = {}

    used = [reference for reference in references if reference.used]
    if used:
        samples = [_sample_view(reference, surface, triangles.count, options, model_diagonal) for reference in used]
        gains = exposure_gains(samples, source_colors) if options.exposure_match else {}
        _apply_gains(samples, gains)
        clutter = face_clutter(samples, surface, triangles, model_diagonal)
        labels = choose_face_sources(samples, surface, triangles, source_colors, clutter, options)
        vertex_weights = _vertex_label_weights(triangles, labels, len(samples) + 1)
        reference_colors, coverage, dominant = _blend_views(samples, surface, triangles, vertex_weights)
        coverage = coverage * options.ref_strength
        if options.color_match:
            source_colors, match_report = match_source_colors(source_colors, reference_colors, coverage)
            statistics["color_match"] = match_report
        flat_color[surface.texel_index, :3] = source_colors * (1.0 - coverage[:, None]) + \
            reference_colors * coverage[:, None]
        views = [view_samples.view for view_samples in samples]
        refusal = _face_refusals(samples, surface, triangles.count, clutter)
        statistics["reference_painted_percent"] = round(float((coverage > 0.5).mean()) * 100.0, 1)
        statistics["per_view_percent"] = {view: round(float(((dominant == index) & (coverage > 0.5)).mean()) * 100.0, 1)
                                          for index, view in enumerate(views)}
        statistics["exposure_gains"] = {view: np.round(gain, 3).tolist() for view, gain in gains.items()}
        statistics["face_choices"] = {"source": int((labels == SOURCE_LABEL).sum()),
                                      **{view: int((labels == index + 1).sum()) for index, view in enumerate(views)}}
        statistics["cluttered_face_percent"] = round(float((clutter >= 0.5).mean()) * 100.0, 1)
        statistics["coverage"] = coverage_summary(views, coverage, dominant, refusal[surface.triangle_index])
        diagnostic_maps["coverage"] = coverage_image(surface, views, coverage, dominant,
                                                     refusal[surface.triangle_index], padding)
        diagnostic_maps["clutter"] = clutter_image(surface, clutter[surface.triangle_index], padding)
    else:
        flat_color[surface.texel_index, :3] = source_colors

    flat_color[:, 3] = 1.0
    color = flat_color.reshape(size, size, 4)
    color = image_utils.dilate_colors(color, surface.covered_mask(), padding)
    return color, statistics, diagnostic_maps


def _sample_view(reference, surface: TexelSurface, triangle_count: int, options, model_diagonal: float) -> ViewSamples:
    """Samples one reference at every texel it faces, can see, lands on its subject, and agrees with the source."""
    count = surface.texel_index.size
    sampling_mask = image_utils.erode_mask(reference.mask, options.ref_edge_inset)
    height, width = reference.mask.shape
    direction = reference.direction.astype(np.float32)
    minimum_facing = np.cos(np.radians(options.ref_max_angle))
    depth_tolerance = options.depth_tolerance * model_diagonal
    parts = {"texels": [], "colors": [], "facing": [], "trust": []}
    face_totals = {name: np.zeros(triangle_count, dtype=np.float64)
                   for name in ("face_facing", "face_active", "face_visible", "face_inside", "face_seen_facing",
                                "face_trust")}
    for start in range(0, count, TEXEL_CHUNK):
        chunk = slice(start, min(start + TEXEL_CHUNK, count))
        facing = np.clip((surface.normals[chunk] @ direction - minimum_facing) / max(1.0 - minimum_facing, 1e-6),
                         0.0, 1.0)
        active = np.flatnonzero(facing > 1e-3)
        if active.size == 0:
            continue
        faces = surface.triangle_index[chunk][active]
        points = surface.positions[chunk][active].astype(np.float64)
        pixel_points = reference_views.map_to_reference(reference, points)
        pixel_x, pixel_y = pixel_points[:, 0], pixel_points[:, 1]
        # Visibility is a property of the mesh, so it uses the mesh's own projection; color comes from where
        # the local warp says the matching content really is in the image.
        nearest_depth = image_utils.sample_nearest(reference.depth, pixel_x, pixel_y)
        visible = reference_views.depth_along(points, reference.direction) >= nearest_depth - depth_tolerance
        if reference.warp is not None:
            shift = reference.warp.displacement_at(pixel_x, pixel_y)
            pixel_x, pixel_y = pixel_x + shift[:, 0], pixel_y + shift[:, 1]
        inside = (pixel_x >= 0) & (pixel_x < width) & (pixel_y >= 0) & (pixel_y < height)
        inside &= image_utils.sample_nearest(sampling_mask, pixel_x, pixel_y) & visible
        trust = reference.agreement.at(pixel_x, pixel_y) if reference.agreement is not None \
            else np.ones(active.size, dtype=np.float32)
        active_facing = facing[active]
        paintable = inside

        def add(name: str, values: np.ndarray) -> None:
            face_totals[name] += np.bincount(faces, weights=values, minlength=triangle_count)

        add("face_facing", active_facing)
        add("face_active", np.ones(active.size))
        add("face_visible", visible.astype(np.float64))
        add("face_inside", inside.astype(np.float64))
        add("face_seen_facing", np.where(paintable, active_facing, 0.0))
        add("face_trust", np.where(paintable, trust, 0.0))
        if not paintable.any():
            continue
        parts["texels"].append(chunk.start + active[paintable])
        parts["colors"].append(image_utils.sample_bilinear(reference.pixels[:, :, :3], pixel_x[paintable],
                                                           pixel_y[paintable]).astype(np.float32))
        parts["facing"].append(active_facing[paintable].astype(np.float32))
        parts["trust"].append(trust[paintable].astype(np.float32))
    empty = {"texels": np.zeros(0, dtype=np.int64), "colors": np.zeros((0, 3), dtype=np.float32),
             "facing": np.zeros(0, dtype=np.float32), "trust": np.zeros(0, dtype=np.float32)}
    joined = {name: np.concatenate(chunks) if chunks else empty[name] for name, chunks in parts.items()}
    return ViewSamples(view=reference.view, **joined,
                       **{name: values.astype(np.float32) for name, values in face_totals.items()})


def exposure_gains(samples: list, source_colors: np.ndarray) -> dict:
    """
    Evens out the lighting baked into each reference (a backlit rear view, a bright top view). The baked
    source texture is the yardstick: the generator fused all its views into one consistently lit texture,
    and the local warp has aligned every reference to it. Over each view's head-on, agreeing region, the
    ratio of source to reference brightness says how much brighter or darker that view was lit. Only the
    differences BETWEEN views are corrected — the gains are normalised so the references keep their overall
    brightness.

    :param samples: ViewSamples for every used reference.
    :param source_colors: float32 (count, 3) baked source sRGB colors, one per covered texel.
    :returns: view -> float array (3,) of linear-light gains.
    """
    ratios, weights, views = [], [], []
    for view_samples in samples:
        # Only where the view agrees with the source texture: a chrome reflection or a part drawn differently
        # says nothing about how brightly the view was lit.
        head_on = (view_samples.facing >= EXPOSURE_HEAD_ON) & (view_samples.trust >= EXPOSURE_HEAD_ON)
        if head_on.sum() < EXPOSURE_MINIMUM_TEXELS:
            continue
        source_mean = image_utils.srgb_to_linear(source_colors[view_samples.texels[head_on]]).mean(axis=0)
        reference_mean = image_utils.srgb_to_linear(view_samples.colors[head_on]).mean(axis=0)
        ratios.append(np.log((source_mean + 1e-4) / (reference_mean + 1e-4)))
        weights.append(float(head_on.sum()))
        views.append(view_samples.view)
    if len(views) < 2:
        return {}
    log_ratios = np.array(ratios)
    weight_share = np.array(weights) / np.sum(weights)
    log_gains = log_ratios - (weight_share[:, None] * log_ratios).sum(axis=0, keepdims=True)
    gains = np.clip(np.exp(log_gains), 1.0 / EXPOSURE_GAIN_LIMIT, EXPOSURE_GAIN_LIMIT)
    return {view: gains[index].astype(np.float32) for index, view in enumerate(views)}


def _apply_gains(samples: list, gains: dict) -> None:
    """Applies each view's exposure gain to its sampled colors, in linear light."""
    for view_samples in samples:
        if view_samples.view in gains and view_samples.colors.size:
            linear = image_utils.srgb_to_linear(view_samples.colors) * gains[view_samples.view][None, :]
            view_samples.colors = image_utils.linear_to_srgb(linear).astype(np.float32)


def face_clutter(samples: list, surface: TexelSurface, triangles, model_diagonal: float) -> np.ndarray:
    """
    How cluttered the model is around each face: the share of nearby surface (within CLUTTER_RADIUS_FRACTION
    of the model diagonal) that the views facing it cannot see, because other parts are in the way. An
    engine, a cockpit or a suspension scores high; a wing, a side panel or a nose scores near zero.

    :returns: float32 (triangles,), 0 = open .. 1 = cluttered.
    """
    face_texels = np.maximum(np.bincount(surface.triangle_index, minlength=triangles.count), 1).astype(np.float32)
    mean_facing = np.stack([view_samples.face_facing / face_texels for view_samples in samples], axis=1)
    seen_share = np.stack([view_samples.face_visible / np.maximum(view_samples.face_active, 1.0)
                           for view_samples in samples], axis=1)
    judged = mean_facing >= CLUTTER_FACING
    best_seen = np.where(judged, seen_share, -1.0).max(axis=1)
    has_judge = judged.any(axis=1)
    hidden = np.where(has_judge, 1.0 - np.clip(best_seen, 0.0, 1.0), 0.0)

    edge_one = triangles.positions[:, 1] - triangles.positions[:, 0]
    edge_two = triangles.positions[:, 2] - triangles.positions[:, 0]
    weight = 0.5 * np.linalg.norm(np.cross(edge_one, edge_two), axis=1) * has_judge
    cell = max(CLUTTER_RADIUS_FRACTION * model_diagonal, 1e-9)
    voxel = np.floor(triangles.positions.mean(axis=1) / cell).astype(np.int64)
    voxel -= voxel.min(axis=0)
    span = voxel.max(axis=0) + 3
    keys = ((voxel[:, 0] + 1) * span[1] + voxel[:, 1] + 1) * span[2] + voxel[:, 2] + 1
    unique_keys, voxel_index = np.unique(keys, return_inverse=True)
    hidden_sum = np.bincount(voxel_index, weights=hidden * weight)
    weight_sum = np.bincount(voxel_index, weights=weight)
    # Each face reads its own voxel and the 26 around it, so the neighbourhood is a smooth ball, not a grid cell.
    near_hidden = np.zeros(triangles.count)
    near_weight = np.zeros(triangles.count)
    for offset_x in (-1, 0, 1):
        for offset_y in (-1, 0, 1):
            for offset_z in (-1, 0, 1):
                neighbour_keys = keys + (offset_x * span[1] + offset_y) * span[2] + offset_z
                position = np.clip(np.searchsorted(unique_keys, neighbour_keys), 0, unique_keys.size - 1)
                found = unique_keys[position] == neighbour_keys
                near_hidden[found] += hidden_sum[position[found]]
                near_weight[found] += weight_sum[position[found]]
    share = near_hidden / np.maximum(near_weight, 1e-12)
    return np.clip(share / CLUTTER_FULL_SHARE, 0.0, 1.0).astype(np.float32)


def choose_face_sources(samples: list, surface: TexelSurface, triangles, source_colors: np.ndarray,
                        clutter: np.ndarray, options) -> np.ndarray:
    """
    Picks one color source per face. A view scores by how head-on it sees the face and how much of the face
    it can paint; in cluttered parts the score also shrinks as far as the view disagrees with the model's own
    texture there. The model's own texture scores --ref-source-score. Neighbouring faces then vote: a face
    pays --ref-seam-smoothness for every neighbour that chose differently, more where the two choices look
    different there, so whole panels come from one view and seams settle in plain areas rather than through
    logos.

    :param samples: ViewSamples for every used reference.
    :param surface: Covered texels (per-face texel counts).
    :param triangles: TriangleSet of the final mesh.
    :param source_colors: float32 (count, 3) baked source color per covered texel.
    :param clutter: float32 (triangles,) face_clutter.
    :param options: Parsed options (ref_source_score, ref_seam_smoothness).
    :returns: int array (triangles,) of labels: SOURCE_LABEL, or n + 1 for view n.
    """
    face_texels = np.bincount(surface.triangle_index, minlength=triangles.count).astype(np.float32)
    scores = np.zeros((triangles.count, len(samples) + 1), dtype=np.float32)
    scores[:, SOURCE_LABEL] = options.ref_source_score
    for index, view_samples in enumerate(samples):
        seen = view_samples.face_seen_facing / np.maximum(face_texels, 1.0)
        trust = view_samples.face_trust / np.maximum(view_samples.face_inside, 1.0)
        scores[:, index + 1] = seen * (1.0 - clutter * (1.0 - trust))
    # Faces too small to hold a texel have no preference of their own; their neighbours decide.
    scores[face_texels == 0, :] = 0.0
    labels = scores.argmax(axis=1)
    pairs = triangle_adjacency(triangles.vertex_index)
    if pairs.size == 0 or options.ref_seam_smoothness <= 0.0:
        return labels
    face_colors = _face_label_colors(samples, surface, triangles.count, source_colors)
    face_index = np.arange(triangles.count)
    for _ in range(LABEL_PASSES):
        penalty = np.zeros_like(scores)
        for face, neighbour in ((pairs[:, 0], pairs[:, 1]), (pairs[:, 1], pairs[:, 0])):
            neighbour_label = labels[neighbour]
            # How different every candidate label looks from the neighbour's choice, on both faces.
            difference = (_color_difference(face_colors[face], face_colors[face, neighbour_label]) +
                          _color_difference(face_colors[neighbour], face_colors[neighbour, neighbour_label])) / 2.0
            edge_cost = options.ref_seam_smoothness * (1.0 + SEAM_COLOR_WEIGHT * difference)
            edge_cost[np.arange(face.size), neighbour_label] = 0.0
            np.add.at(penalty, face, edge_cost)
        total = scores - penalty
        updated = total.argmax(axis=1)
        keep = total[face_index, updated] <= total[face_index, labels] + 1e-6
        updated[keep] = labels[keep]
        if np.array_equal(updated, labels):
            break
        labels = updated
    return labels


def _face_label_colors(samples: list, surface: TexelSurface, triangle_count: int,
                       source_colors: np.ndarray) -> np.ndarray:
    """
    Mean color of every face under every choice (the source texture, then each view), NaN where a view
    cannot paint the face.

    :returns: float32 (triangles, labels, 3).
    """
    colors = np.full((triangle_count, len(samples) + 1, 3), np.nan, dtype=np.float32)
    texel_count = np.bincount(surface.triangle_index, minlength=triangle_count).astype(np.float64)
    for channel in range(3):
        sums = np.bincount(surface.triangle_index, weights=source_colors[:, channel], minlength=triangle_count)
        colors[:, SOURCE_LABEL, channel] = np.where(texel_count > 0, sums / np.maximum(texel_count, 1.0), np.nan)
    for index, view_samples in enumerate(samples):
        faces = surface.triangle_index[view_samples.texels]
        painted = np.bincount(faces, minlength=triangle_count).astype(np.float64)
        for channel in range(3):
            sums = np.bincount(faces, weights=view_samples.colors[:, channel], minlength=triangle_count)
            colors[:, index + 1, channel] = np.where(painted > 0, sums / np.maximum(painted, 1.0), np.nan)
    return colors


def _color_difference(candidates: np.ndarray, chosen: np.ndarray) -> np.ndarray:
    """
    Mean absolute sRGB difference between every candidate's color and a chosen color, per face.

    :param candidates: float32 (faces, labels, 3).
    :param chosen: float32 (faces, 3).
    :returns: float32 (faces, labels); UNAVAILABLE_COLOR_DIFFERENCE where either color is missing.
    """
    difference = np.abs(candidates - chosen[:, None, :]).mean(axis=2)
    return np.where(np.isnan(difference), UNAVAILABLE_COLOR_DIFFERENCE, difference).astype(np.float32)


def triangle_adjacency(vertex_index: np.ndarray) -> np.ndarray:
    """
    Pairs of triangles that share an edge.

    :param vertex_index: int array (triangles, 3) of vertex numbers.
    :returns: int64 array (pairs, 2).
    """
    edges = np.stack((vertex_index[:, [0, 1]], vertex_index[:, [1, 2]], vertex_index[:, [2, 0]]), axis=1)
    edges = np.sort(edges.reshape(-1, 2), axis=1)
    owner = np.repeat(np.arange(vertex_index.shape[0]), 3)
    keys = edges[:, 0] * (int(vertex_index.max()) + 1) + edges[:, 1]
    order = np.argsort(keys, kind="stable")
    same = keys[order][1:] == keys[order][:-1]
    return np.stack((owner[order][:-1][same], owner[order][1:][same]), axis=1).astype(np.int64)


def _vertex_label_weights(triangles, labels: np.ndarray, label_count: int) -> np.ndarray:
    """
    Share of each label around every vertex (by the area of the faces using it), so texels blend between
    choices only inside the ring of faces where two choices meet.

    :returns: float32 (vertices, labels), rows summing to 1.
    """
    edge_one = triangles.positions[:, 1] - triangles.positions[:, 0]
    edge_two = triangles.positions[:, 2] - triangles.positions[:, 0]
    areas = 0.5 * np.linalg.norm(np.cross(edge_one, edge_two), axis=1) + 1e-12
    weights = np.zeros((int(triangles.vertex_index.max()) + 1, label_count), dtype=np.float64)
    for corner in range(3):
        np.add.at(weights, (triangles.vertex_index[:, corner], labels), areas)
    return (weights / np.maximum(weights.sum(axis=1, keepdims=True), 1e-20)).astype(np.float32)


def _label_weight_at(surface: TexelSurface, triangles, vertex_weights: np.ndarray, texels: np.ndarray,
                     label: int) -> np.ndarray:
    """A label's weight at given texels, interpolated from the vertices of their triangles."""
    corners = triangles.vertex_index[surface.triangle_index[texels]]
    return (surface.barycentric[texels] * vertex_weights[corners, label]).sum(axis=1)


def _blend_views(samples: list, surface: TexelSurface, triangles, vertex_weights: np.ndarray) -> tuple:
    """
    Combines the views by their label weights. Where a view's weight falls on a texel it cannot paint, that
    weight goes to the source texture.

    :returns: (reference color float32 (count, 3), coverage float32 (count,) = share painted by views,
               dominant view index int16 (count,), -1 where no view paints).
    """
    count = surface.texel_index.size
    color_sum = np.zeros((count, 3), dtype=np.float32)
    weight_sum = np.zeros(count, dtype=np.float32)
    best_weight = np.zeros(count, dtype=np.float32)
    dominant = np.full(count, -1, dtype=np.int16)
    for index, view_samples in enumerate(samples):
        if view_samples.texels.size == 0:
            continue
        weight = _label_weight_at(surface, triangles, vertex_weights, view_samples.texels, index + 1)
        color_sum[view_samples.texels] += view_samples.colors * weight[:, None]
        weight_sum[view_samples.texels] += weight
        wins = weight > best_weight[view_samples.texels]
        best_weight[view_samples.texels[wins]] = weight[wins]
        dominant[view_samples.texels[wins]] = index
    reference_colors = color_sum / np.maximum(weight_sum, 1e-12)[:, None]
    return reference_colors, np.clip(weight_sum, 0.0, 1.0), dominant


def _face_refusals(samples: list, surface: TexelSurface, triangle_count: int, clutter: np.ndarray) -> np.ndarray:
    """
    Why the view facing each face most directly could not paint it: hidden by other geometry, off its
    subject, or (in a cluttered part) disagreeing with the model's own texture.

    :returns: int8 (triangles,) refusal codes.
    """
    face_texels = np.maximum(np.bincount(surface.triangle_index, minlength=triangle_count), 1).astype(np.float32)
    facing = np.stack([view_samples.face_facing / face_texels for view_samples in samples], axis=1)
    best = facing.argmax(axis=1)
    face_index = np.arange(triangle_count)

    def share(name: str) -> np.ndarray:
        return np.stack([getattr(view_samples, name) for view_samples in samples], axis=1)[face_index, best] / face_texels

    visible, inside, trust = share("face_visible"), share("face_inside"), share("face_trust")
    mean_trust = trust / np.maximum(inside, 1e-6)
    refusal = np.full(triangle_count, REFUSAL_NONE, dtype=np.int8)
    refusal[visible < MINIMUM_SEEN_SHARE] = REFUSAL_HIDDEN
    refusal[(refusal == REFUSAL_NONE) & (inside < MINIMUM_SEEN_SHARE)] = REFUSAL_OUTSIDE
    refusal[(refusal == REFUSAL_NONE) & (mean_trust < 0.5) & (clutter >= 0.5)] = REFUSAL_INCONSISTENT
    refusal[facing.max(axis=1) < 0.5] = REFUSAL_NONE
    return refusal


def view_color(view: str, extra_index: int) -> tuple:
    """Coverage-map color of a view: fixed for the named sides, from a short cycle for any other angle."""
    return VIEW_COLORS.get(view, EXTRA_VIEW_COLORS[extra_index % len(EXTRA_VIEW_COLORS)])


def _view_palette(views: list) -> np.ndarray:
    """Coverage-map colors for a list of views."""
    extra = [view for view in views if view not in VIEW_COLORS]
    return np.array([view_color(view, extra.index(view) if view in extra else 0) for view in views],
                    dtype=np.float32).reshape(-1, 3)


def _hex(color: tuple) -> str:
    """#rrggbb for a 0..1 color."""
    return "#" + "".join(f"{int(round(channel * 255)):02x}" for channel in color)


def coverage_image(surface: TexelSurface, views: list, coverage: np.ndarray, dominant: np.ndarray,
                   texel_refusal: np.ndarray, padding: int) -> np.ndarray:
    """
    Renders where each view painted as a texture for the same UV layout: view colors where references
    painted (brighter = fuller coverage), and for the rest why the best-facing view could not: red = hidden
    by other geometry, pink = off its subject, black = it disagrees with the model's own texture; dark grey
    = no view faces it closely enough, or the model's own texture simply scored higher.

    :returns: float32 (size, size, 4).
    """
    colors = np.tile(np.array(UNSEEN_COLOR, dtype=np.float32), (coverage.size, 1))
    painted = (coverage >= 0.5) & (dominant >= 0)
    colors[painted] = _view_palette(views)[dominant[painted]] * (0.45 + 0.55 * coverage[painted])[:, None]
    for code, color in ((REFUSAL_HIDDEN, REFUSED_HIDDEN_COLOR), (REFUSAL_OUTSIDE, REFUSED_OUTSIDE_COLOR),
                        (REFUSAL_INCONSISTENT, REFUSED_INCONSISTENT_COLOR)):
        colors[~painted & (texel_refusal == code)] = color
    flat = np.zeros((surface.size * surface.size, 4), dtype=np.float32)
    flat[surface.texel_index, :3] = colors
    flat[:, 3] = 1.0
    return image_utils.dilate_colors(flat.reshape(surface.size, surface.size, 4), surface.covered_mask(), padding)


def clutter_image(surface: TexelSurface, texel_clutter: np.ndarray, padding: int) -> np.ndarray:
    """
    Renders face_clutter as a texture for the same UV layout: blue = open surface (references paint it as
    decals), orange = cluttered (references must agree with the model's own texture to paint it).

    :returns: float32 (size, size, 4).
    """
    colors = CLUTTER_OPEN_COLOR[None, :] * (1.0 - texel_clutter[:, None]) + \
        CLUTTER_CLUTTERED_COLOR[None, :] * texel_clutter[:, None]
    flat = np.zeros((surface.size * surface.size, 4), dtype=np.float32)
    flat[surface.texel_index, :3] = colors
    flat[:, 3] = 1.0
    return image_utils.dilate_colors(flat.reshape(surface.size, surface.size, 4), surface.covered_mask(), padding)


def coverage_summary(views: list, coverage: np.ndarray, dominant: np.ndarray, texel_refusal: np.ndarray) -> dict:
    """Shares of the surface by outcome, and the coverage-map legend, for the report."""
    painted = (coverage >= 0.5) & (dominant >= 0)

    def share(selection: np.ndarray) -> float:
        return round(float(selection.mean()) * 100.0, 1)

    legend = {view: _hex(tuple(color)) for view, color in zip(views, _view_palette(views).tolist())}
    legend.update({"kept: hidden by other geometry": _hex(REFUSED_HIDDEN_COLOR),
                   "kept: off the subject": _hex(REFUSED_OUTSIDE_COLOR),
                   "kept: view disagrees with the model's texture": _hex(REFUSED_INCONSISTENT_COLOR),
                   "kept: no view faces it well enough": _hex(UNSEEN_COLOR)})
    return {
        "painted_percent": share(painted),
        "kept_hidden_percent": share(~painted & (texel_refusal == REFUSAL_HIDDEN)),
        "kept_outside_subject_percent": share(~painted & (texel_refusal == REFUSAL_OUTSIDE)),
        "kept_inconsistent_percent": share(~painted & (texel_refusal == REFUSAL_INCONSISTENT)),
        "kept_unseen_percent": share(~painted & (texel_refusal == REFUSAL_NONE)),
        "legend": legend,
    }


def match_source_colors(source_colors: np.ndarray, reference_colors: np.ndarray, coverage: np.ndarray) -> tuple:
    """
    Adjusts the baked source texture's brightness and contrast per channel so it matches the references
    where both exist; the hand-over between reference-painted and source-only areas then does not show.

    :param source_colors: float32 (count, 3) baked source colors.
    :param reference_colors: float32 (count, 3) reference colors.
    :param coverage: float32 (count,) 0..1 reference coverage.
    :returns: (adjusted source colors, dict of per-channel gain and bias for the report).
    """
    strong = coverage >= STRONG_COVERAGE
    if strong.sum() < COLOR_MATCH_MINIMUM_TEXELS:
        return source_colors, {"applied": False, "reason": "too little reference coverage to compare"}
    source_mean = source_colors[strong].mean(axis=0)
    source_spread = source_colors[strong].std(axis=0)
    reference_mean = reference_colors[strong].mean(axis=0)
    reference_spread = reference_colors[strong].std(axis=0)
    gain = np.clip(reference_spread / np.maximum(source_spread, 1e-4), *COLOR_MATCH_GAIN_LIMITS)
    bias = reference_mean - source_mean * gain
    adjusted = np.clip(source_colors * gain + bias, 0.0, 1.0)
    return adjusted, {"applied": True, "gain": np.round(gain, 3).tolist(), "bias": np.round(bias, 3).tolist()}
